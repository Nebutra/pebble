import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const RUNTIME_METADATA_FILE = 'pebble-runtime.json'
let pebbleDevUserDataPath: string | null = null
let pebbleServeProcess: ChildProcess | null = null
let pebbleServeStdout = ''
let pebbleServeStderr = ''

export type CliResult = {
  stdout: string
  stderr: string
}

type RunPebbleCliOptions = {
  retryMissingRuntimeMetadata?: boolean
}

export async function runPebbleCli(
  args: string[],
  options: RunPebbleCliOptions = {}
): Promise<CliResult> {
  try {
    return await runPebbleCliOnce(args)
  } catch (error) {
    if (
      options.retryMissingRuntimeMetadata !== false &&
      isMissingRuntimeMetadataError(args, error)
    ) {
      // Why: Windows CI can let the dev runtime exit while launching the
      // fixture app; reopen once so the desktop action gets a live runtime.
      await ensurePebbleRuntimeLaunched()
      return await runPebbleCliOnce(args)
    }
    throw error
  }
}

async function runPebbleCliOnce(args: string[]): Promise<CliResult> {
  const devCli = join(process.cwd(), 'config/scripts/pebble-dev.mjs')
  const command = process.env.PEBBLE_COMPUTER_CLI ?? process.execPath
  const cliArgs = process.env.PEBBLE_COMPUTER_CLI ? args : [devCli, ...args]
  const env = { ...process.env }
  if (!process.env.PEBBLE_COMPUTER_CLI && !env.PEBBLE_DEV_USER_DATA_PATH) {
    env.PEBBLE_DEV_USER_DATA_PATH = await getComputerE2ePebbleDevUserDataPath()
  }
  try {
    const result = await execFileAsync(command, cliArgs, {
      env,
      maxBuffer: 20 * 1024 * 1024
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error && 'stderr' in error) {
      const output = error as { message: string; stdout: string; stderr: string }
      throw new Error(`${output.message}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`)
    }
    throw error
  }
}

export async function ensurePebbleRuntimeLaunched(): Promise<void> {
  if (!process.env.PEBBLE_COMPUTER_CLI && process.platform === 'win32') {
    await ensurePebbleRuntimeServed()
    return
  }
  await runPebbleCli(['open', '--json'], { retryMissingRuntimeMetadata: false })
  await waitForPebbleRuntimeReady()
}

export async function stopPebbleRuntime(): Promise<void> {
  const processToStop = pebbleServeProcess
  if (!processToStop?.pid) {
    return
  }
  pebbleServeProcess = null
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(processToStop.pid), '/T', '/F'])
    } catch {
      // The foreground test runtime may already have exited.
    }
    return
  }
  processToStop.kill()
}

export function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T
}

async function getComputerE2ePebbleDevUserDataPath(): Promise<string> {
  if (!pebbleDevUserDataPath) {
    // Why: the shared pebble-dev profile can keep an older runtime alive across
    // local test runs, making computer-use E2E exercise stale provider code.
    pebbleDevUserDataPath = await mkdtemp(join(tmpdir(), 'pebble-computer-runtime-'))
  }
  return pebbleDevUserDataPath
}

async function waitForPebbleRuntimeReady(): Promise<void> {
  const userDataPath = await getComputerE2ePebbleDevUserDataPath()
  const metadataPath = join(userDataPath, RUNTIME_METADATA_FILE)
  const deadline = Date.now() + 15000
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      await access(metadataPath)
      const status = parseJsonOutput<{
        result: { runtime: { reachable: boolean } }
      }>((await runPebbleCli(['status', '--json'], { retryMissingRuntimeMetadata: false })).stdout)
      if (status.result.runtime.reachable) {
        return
      }
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }

  const detail = [
    lastError instanceof Error ? `Last error: ${lastError.message}` : null,
    pebbleServeStdout.trim() ? `serve stdout: ${pebbleServeStdout.trim()}` : null,
    pebbleServeStderr.trim() ? `serve stderr: ${pebbleServeStderr.trim()}` : null
  ]
    .filter(Boolean)
    .join(' ')
  throw new Error(`Pebble runtime metadata was not ready at ${metadataPath}.${detail}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensurePebbleRuntimeServed(): Promise<void> {
  if (!pebbleServeProcess || pebbleServeProcess.exitCode !== null) {
    const devCli = join(process.cwd(), 'config/scripts/pebble-dev.mjs')
    const env = {
      ...process.env,
      PEBBLE_DEV_USER_DATA_PATH: await getComputerE2ePebbleDevUserDataPath()
    }
    pebbleServeStdout = ''
    pebbleServeStderr = ''
    pebbleServeProcess = spawn(process.execPath, [devCli, 'serve', '--no-pairing', '--json'], {
      env,
      windowsHide: true
    })
    pebbleServeProcess.stdout?.on('data', (chunk) => {
      pebbleServeStdout += String(chunk)
    })
    pebbleServeProcess.stderr?.on('data', (chunk) => {
      pebbleServeStderr += String(chunk)
    })
    pebbleServeProcess.once('exit', () => {
      pebbleServeProcess = null
    })
    process.once('exit', () => {
      pebbleServeProcess?.kill()
    })
  }
  await waitForPebbleRuntimeReady()
}

function isMissingRuntimeMetadataError(args: string[], error: unknown): boolean {
  if (args[0] !== 'computer') {
    return false
  }
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false
  }
  const message = String((error as { message?: unknown }).message)
  return (
    message.includes('"code": "runtime_unavailable"') &&
    message.includes('Could not read Pebble runtime metadata')
  )
}
