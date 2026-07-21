import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const PREVIEW_URL = 'http://127.0.0.1:4175/'
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const reuseBuild = process.argv.includes('--reuse-build')
const builtEntry = resolve(process.cwd(), 'dist/index.html')

// Why: Tauri executes packaged Go sidecars even in optimized dev; refresh them
// before Rust starts so native fixes cannot be masked by stale binaries.
const sidecars = spawnSync(process.execPath, ['scripts/prepare-go-sidecars.mjs'], {
  cwd: process.cwd(),
  stdio: 'inherit'
})
if (sidecars.status !== 0) {
  process.exit(sidecars.status ?? 1)
}

if (!reuseBuild || !existsSync(builtEntry)) {
  const build = spawnSync(npmCommand, ['run', 'build'], {
    cwd: process.cwd(),
    stdio: 'inherit'
  })
  if (build.status !== 0) {
    process.exit(build.status ?? 1)
  }
}

const preview = spawn(npmCommand, ['run', 'preview:optimized:renderer'], {
  cwd: process.cwd(),
  stdio: 'inherit'
})

let shell = null
let shuttingDown = false
let exitCode = 0

function shutdown(statusCode = 0) {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  exitCode = statusCode
  shell?.kill('SIGTERM')
  preview.kill('SIGTERM')
}

process.on('SIGINT', () => shutdown(130))
process.on('SIGTERM', () => shutdown(143))
preview.on('exit', (code) => {
  if (!shuttingDown) {
    shutdown(code ?? 1)
  }
})

try {
  await waitForPreview()

  shell = spawn(npmCommand, ['run', 'tauri:optimized:shell'], {
    cwd: process.cwd(),
    stdio: 'inherit'
  })
  shell.on('exit', (code) => shutdown(code ?? 0))

  await new Promise((resolve) => shell.once('exit', resolve))
} catch (error) {
  console.error(error)
  shutdown(1)
} finally {
  await Promise.all([waitForExit(preview), waitForExit(shell)])
  process.exitCode = exitCode
}

async function waitForPreview() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (preview.exitCode !== null) {
      throw new Error('Optimized renderer preview exited before it became ready.')
    }
    try {
      const response = await fetch(PREVIEW_URL)
      if (response.ok) {
        return
      }
    } catch {
      // The preview server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  shutdown(1)
  throw new Error(`Timed out waiting for ${PREVIEW_URL}`)
}

function waitForExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolve) => child.once('exit', resolve))
}
