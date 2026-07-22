import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

// Run via `pnpm verify:tauri-pixel-performance:capture`. Evidence defaults to
// an ignored directory; CI can preserve it by setting PEBBLE_PIXEL_PERF_EVIDENCE_DIR.
const root = resolve(import.meta.dirname, '../..')
const desktop = resolve(root, 'apps/desktop')
const baselines = resolve(root, 'tests/e2e/baselines/desktop')
const evidence = resolve(
  process.env.PEBBLE_PIXEL_PERF_EVIDENCE_DIR || 'artifacts/tauri-pixel-performance'
)
const runs = Number(process.env.PEBBLE_SETTINGS_PERF_RUNS || 5)
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error('PEBBLE_SETTINGS_PERF_RUNS must be a positive integer')
}
mkdirSync(evidence, { recursive: true })
clearParityHarnessCrashState()

const reference = resolve(baselines, 'settings.png')
const candidate = resolve(evidence, 'tauri-settings.png')
const landingReference = resolve(baselines, 'landing.png')
const landingCandidate = resolve(evidence, 'tauri-landing.png')
const updateReference = resolve(baselines, 'update.png')
const updateCandidate = resolve(evidence, 'tauri-update.png')
const crashReference = resolve(baselines, 'crash.png')
const crashCandidate = resolve(evidence, 'tauri-crash.png')
for (const path of [reference, landingReference, updateReference, crashReference]) {
  if (!existsSync(path) || !existsSync(`${path}.viewport.json`)) {
    throw new Error(`approved desktop pixel baseline is missing: ${path}`)
  }
}
run(process.execPath, ['scripts/prepare-go-sidecars.mjs', '--host-only'], desktop)
run(process.execPath, ['scripts/stage-macos-speech-libraries.mjs'], desktop)
run('pnpm', ['--filter', '@pebble/desktop', 'run', 'build'], root, {
  VITE_EXPOSE_STORE: 'true',
  VITE_TAURI_PARITY_CAPTURE: 'true'
})
const referenceViewport = JSON.parse(readFileSync(`${reference}.viewport.json`, 'utf8'))

const preview = spawn(command('npm'), ['run', 'preview:optimized:renderer'], {
  cwd: desktop,
  stdio: 'inherit',
  detached: process.platform !== 'win32'
})
try {
  await waitForUrl('http://127.0.0.1:4175/', preview)
  await captureTauriSurface({
    surface: 'landing',
    capturePath: landingCandidate,
    viewport: JSON.parse(readFileSync(`${landingReference}.viewport.json`, 'utf8'))
  })
  run(
    process.execPath,
    [
      'config/scripts/compare-desktop-parity-screenshots.mjs',
      '--reference',
      landingReference,
      '--candidate',
      landingCandidate,
      '--diff',
      resolve(evidence, 'landing-diff.png'),
      '--max-mismatch-ratio',
      '0.015'
    ],
    root
  )
  await captureAndCompareSurface({
    surface: 'update',
    referencePath: updateReference,
    candidatePath: updateCandidate
  })
  await captureAndCompareSurface({
    surface: 'crash',
    referencePath: crashReference,
    candidatePath: crashCandidate
  })
  const samples = []
  for (let index = 0; index < runs; index += 1) {
    const samplePath = resolve(evidence, `settings-sample-${index + 1}.json`)
    rmSync(samplePath, { force: true })
    if (index === 0) {
      rmSync(candidate, { force: true })
    }
    await captureTauriSurface({
      surface: 'settings',
      capturePath:
        index === 0 ? candidate : resolve(evidence, `tauri-settings-${index + 1}.png`),
      viewport: referenceViewport,
      performancePath: samplePath,
      requiredPaths: [samplePath, index === 0 ? candidate : null].filter(Boolean)
    })
    samples.push(JSON.parse(readFileSync(samplePath, 'utf8')))
  }
  const samplesPath = resolve(evidence, 'settings-samples.json')
  writeFileSync(samplesPath, `${JSON.stringify(samples, null, 2)}\n`)
  run(
    process.execPath,
    [
      'config/scripts/check-tauri-pixel-performance-gate.mjs',
      '--reference',
      reference,
      '--candidate',
      candidate,
      '--samples',
      samplesPath,
      '--diff',
      resolve(evidence, 'settings-diff.png'),
      '--report',
      resolve(evidence, 'report.json'),
      '--settings-switch-p95-ms',
      process.env.PEBBLE_SETTINGS_SWITCH_P95_MS || '350',
      '--max-long-task-ms',
      process.env.PEBBLE_SETTINGS_MAX_LONG_TASK_MS || '100',
      '--max-long-task-count',
      process.env.PEBBLE_SETTINGS_MAX_LONG_TASK_COUNT || '0'
    ],
    root
  )
} finally {
  await stopProcessTree(preview)
}

async function captureTauriSurface({
  surface,
  capturePath,
  viewport,
  performancePath,
  requiredPaths = [capturePath]
}) {
  rmSync(capturePath, { force: true })
  const shell = spawn(command('npm'), ['run', 'tauri:parity:shell'], {
    cwd: desktop,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      PEBBLE_PARITY_CAPTURE_SURFACE: surface,
      PEBBLE_PARITY_CAPTURE_PATH: capturePath,
      PEBBLE_PARITY_CAPTURE_WIDTH: String(viewport.width),
      PEBBLE_PARITY_CAPTURE_HEIGHT: String(viewport.height),
      PEBBLE_SYSTEM_CRASH_IMPORT_DISABLED: '1',
      ...(performancePath ? { PEBBLE_SETTINGS_PERFORMANCE_PATH: performancePath } : {})
    }
  })
  try {
    await waitForFiles(requiredPaths, shell)
  } finally {
    await stopProcessTree(shell)
  }
}

function clearParityHarnessCrashState() {
  const appDataRoot =
    process.platform === 'darwin'
      ? resolve(homedir(), 'Library/Application Support')
      : process.platform === 'win32'
        ? process.env.APPDATA
        : process.env.XDG_DATA_HOME || resolve(homedir(), '.local/share')
  if (!appDataRoot) {
    return
  }
  const parityData = resolve(appDataRoot, 'nebutra.pebble.parity')
  for (const name of [
    'crash-reports.json',
    'crash-reports.log.ndjson',
    'macos-system-crash-imports.json',
    'tauri-session.json'
  ]) {
    rmSync(resolve(parityData, name), { force: true })
  }
}

async function captureAndCompareSurface({ surface, referencePath, candidatePath }) {
  await captureTauriSurface({
    surface,
    capturePath: candidatePath,
    viewport: JSON.parse(readFileSync(`${referencePath}.viewport.json`, 'utf8'))
  })
  run(
    process.execPath,
    [
      'config/scripts/compare-desktop-parity-screenshots.mjs',
      '--reference',
      referencePath,
      '--candidate',
      candidatePath,
      '--diff',
      resolve(evidence, `${surface}-diff.png`),
      '--max-mismatch-ratio',
      '0.015'
    ],
    root
  )
}

function command(name) {
  return process.platform === 'win32' && !name.includes('\\') && !name.includes('/')
    ? `${name}.cmd`
    : name
}
function run(name, args, cwd, extraEnv = {}) {
  const result = spawnSync(command(name), args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  })
  if (result.status !== 0) {
    // Why: throwing preserves surrounding finally blocks so a failed pixel
    // comparison cannot leak the preview server or parity shell.
    throw new Error(`${name} exited with status ${result.status ?? 1}`)
  }
}
async function waitForUrl(url, child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('optimized renderer preview exited early')
    }
    try {
      if ((await fetch(url)).ok) {
        return
      }
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
  throw new Error(`timed out waiting for ${url}`)
}
async function waitForFiles(paths, child) {
  // Why: a clean Rust link can consume most of 30 seconds before the WebView
  // starts. Evidence still has its own bounded renderer preparation deadline.
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (paths.every(existsSync)) {
      return
    }
    if (child.exitCode !== null) {
      throw new Error('optimized shell exited before writing gate evidence')
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`timed out waiting for ${paths.join(', ')}`)
}
function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolvePromise) => child.once('exit', resolvePromise))
}

async function stopProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  await waitForExit(child)
}
