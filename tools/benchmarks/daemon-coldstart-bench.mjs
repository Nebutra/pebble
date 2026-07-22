#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const goRoot = resolve(root, 'runtime/go')
const options = parseArgs(process.argv.slice(2))
const temporary = mkdtempSync(join(os.tmpdir(), 'pebble-runtime-coldstart-'))
const executable = join(
  temporary,
  process.platform === 'win32' ? 'pebble-runtime.exe' : 'pebble-runtime'
)
const build = spawnSync('go', ['build', '-trimpath', '-o', executable, './cmd/pebble-runtime'], {
  cwd: goRoot,
  stdio: 'inherit',
  env: { ...process.env, GOCACHE: process.env.GOCACHE ?? join(temporary, 'go-cache') }
})
if (build.error) {
  throw build.error
}
if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

const samples = []
try {
  for (let index = 0; index < options.iterations; index += 1) {
    samples.push(
      await measureColdStart(executable, join(temporary, `data-${index + 1}`), options.timeoutMs)
    )
  }
  const durations = samples.map((sample) => sample.listenReadyMs).sort((a, b) => a - b)
  const report = {
    schemaVersion: 1,
    owner: 'go-runtime',
    label: options.label,
    samples,
    medianListenReadyMs: median(durations)
  }
  const resultsDir = resolve(import.meta.dirname, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const output = join(resultsDir, `daemon-coldstart-${options.label}-${stamp()}.json`)
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Go runtime cold-start benchmark written to ${output}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

async function measureColdStart(binary, dataDir, timeoutMs) {
  mkdirSync(dataDir, { recursive: true })
  const port = await availablePort()
  const startedAt = process.hrtime.bigint()
  const child = spawn(binary, ['--listen', `127.0.0.1:${port}`, '--data-dir', dataDir], {
    stdio: ['ignore', 'ignore', 'pipe']
  })
  child.stderr.setEncoding('utf8')
  try {
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error('Go runtime startup timed out')), timeoutMs)
      child.stderr.on('data', (chunk) => {
        if (!chunk.includes('pebble runtime listening')) {
          return
        }
        clearTimeout(timeout)
        resolveReady()
      })
      child.once('error', reject)
      child.once('exit', (code) => reject(new Error(`Go runtime exited before ready: ${code}`)))
    })
    return { listenReadyMs: Number(process.hrtime.bigint() - startedAt) / 1e6 }
  } finally {
    await stop(child)
  }
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  await new Promise((resolveClose) => server.close(resolveClose))
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate runtime port')
  }
  return address.port
}

async function stop(child) {
  if (child.exitCode !== null) {
    return
  }
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000))
  ])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
  }
}

function parseArgs(argv) {
  const parsed = { label: 'run', iterations: 3, timeoutMs: 30_000 }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    const next = () => {
      const candidate = argv[++index]
      if (!candidate) {
        throw new Error(`${value} requires a value`)
      }
      return candidate
    }
    if (value === '--label') {
      parsed.label = next()
    } else if (value === '--iterations') {
      parsed.iterations = Number(next())
    } else if (value === '--timeout-ms') {
      parsed.timeoutMs = Number(next())
    } else {
      throw new Error(`Unknown argument: ${value}`)
    }
  }
  if (!Number.isInteger(parsed.iterations) || parsed.iterations < 1) {
    throw new Error('--iterations must be positive')
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be positive')
  }
  return parsed
}

function median(sorted) {
  if (sorted.length === 0) {
    return null
  }
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
