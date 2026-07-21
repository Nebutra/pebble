import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compareDesktopParityScreenshots } from './compare-desktop-parity-screenshots.mjs'
import {
  nativeInputFixtureHtml,
  nativeInputFrameFixtureHtml
} from './tauri-native-input-fixture.mjs'

import { stopFunctionalGateProcess } from './functional-gate-process-shutdown.mjs'

import { waitForCleanExit } from './functional-gate-process-exit.mjs'
import { evaluateWindowLifecycleEvidence } from './window-lifecycle-evidence.mjs'
import { isMissingTccBundleRegistration } from './macos-tcc-reset-result.mjs'
import { validateTauriRuntimeScreenshots } from './tauri-real-runtime-screenshot-evidence.mjs'

const root = resolve(import.meta.dirname, '../..')
const desktop = resolve(root, 'apps/desktop')
const temporary = mkdtempSync(join(tmpdir(), 'pebble-real-runtime-gate-'))
const repo = join(temporary, 'repo')
const dataDir = join(temporary, 'runtime-data')
const evidence = join(temporary, 'evidence.json')
const providerBin = join(temporary, 'provider-bin')
const nativeChatRoot = join(temporary, 'native-chat')
const screenshotDir = process.env.PEBBLE_REAL_RUNTIME_SCREENSHOT_DIR
  ? resolve(process.env.PEBBLE_REAL_RUNTIME_SCREENSHOT_DIR)
  : null
const nativeInputOnly = process.argv.includes('--native-input-only')
const nativeDragOnly = process.argv.includes('--native-drag-only')
mkdirSync(repo)
mkdirSync(dataDir)
mkdirSync(providerBin)
mkdirSync(nativeChatRoot)
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true })
await assertPortAvailable(4175)
const functionalGateAccessibilityReset = nativeDragOnly ? false : resetFunctionalGateAccessibility()
seedGitRepository(repo)
seedGitHubFixture(providerBin)
seedGitLabFixture(providerBin)
seedNativeChatFixture(nativeChatRoot)
const port = await findAvailablePort()
const runtimeUrl = `http://127.0.0.1:${port}`
const buildEnv = {
  VITE_EXPOSE_STORE: 'true',
  VITE_PEBBLE_RUNTIME_URL: runtimeUrl,
  VITE_PEBBLE_RUNTIME_DATA_DIR: dataDir,
  VITE_TAURI_REAL_RUNTIME_GATE: 'true',
  VITE_TAURI_REAL_RUNTIME_NATIVE_INPUT_ONLY: nativeInputOnly ? 'true' : 'false',
  VITE_TAURI_REAL_RUNTIME_NATIVE_DRAG_ONLY: nativeDragOnly ? 'true' : 'false'
}

run('node', ['scripts/prepare-go-sidecars.mjs'], desktop)
if (process.env.PEBBLE_REAL_RUNTIME_REUSE_BUILD !== '1') {
  run('npm', ['run', 'build'], desktop, buildEnv)
}
const preview = spawn(command('npm'), ['run', 'preview:optimized:renderer'], {
  cwd: desktop,
  stdio: 'inherit',
  detached: process.platform !== 'win32'
})
const browserFixture = await startBrowserFixture()
let shell = null
try {
  await waitForUrl('http://127.0.0.1:4175/', preview)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    shell = spawn(command('npm'), ['run', 'tauri:functional:shell'], {
      cwd: desktop,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PEBBLE_FUNCTIONAL_GATE_REPO_PATH: repo,
        PEBBLE_FUNCTIONAL_GATE_EVIDENCE_PATH: evidence,
        PEBBLE_FUNCTIONAL_GATE_BROWSER_URL: browserFixture.url,
        PEBBLE_FUNCTIONAL_GATE_LAUNCH_EPOCH_MS: String(Date.now()),
        ...(screenshotDir ? { PEBBLE_FUNCTIONAL_GATE_SCREENSHOT_DIR: screenshotDir } : {}),
        PEBBLE_NATIVE_CHAT_FIXTURE_ROOT: nativeChatRoot,
        PATH: `${providerBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`
      }
    })
    try {
      await waitForEvidence(evidence, shell, screenshotDir)
      break
    } catch (error) {
      const evidenceStarted = readEvidenceIfPresent(evidence) !== null
      await stopFunctionalGateProcess(shell)
      shell = null
      if (evidenceStarted || attempt === 3) throw error
      await delay(500)
    }
  }
  const result = JSON.parse(readFileSync(evidence, 'utf8'))
  result.browserFunctionalGateAccessibilityReset = functionalGateAccessibilityReset
  if (!(await waitForCleanExit(shell, 10_000))) {
    throw new Error(
      `functional Tauri shell did not complete its clean shutdown: ${JSON.stringify(result)}`
    )
  }
  if (
    result.status !== 'passed' ||
    (!nativeInputOnly && !nativeDragOnly && !result.terminalMounted) ||
    (!nativeInputOnly && !nativeDragOnly && !result.commandExecuted) ||
    !result.browserLoaded ||
    (process.platform === 'darwin' && !result.browserNativeMouseInput) ||
    (process.platform === 'darwin' && !nativeDragOnly && !result.browserTrustedMouseInput) ||
    (process.platform === 'darwin' && !nativeDragOnly && !result.browserTrustedKeyInput) ||
    (process.platform === 'darwin' && !nativeDragOnly && !result.browserTrustedTextInput) ||
    (process.platform === 'darwin' && !nativeDragOnly && !result.browserTrustedWheelInput) ||
    (process.platform === 'darwin' && nativeDragOnly && !result.browserTrustedDragInput) ||
    (process.platform === 'darwin' && !nativeDragOnly && !result.browserTrustedCheckInput) ||
    (process.platform === 'darwin' && !nativeDragOnly && !result.browserTrustedSelectInput) ||
    (process.platform === 'darwin' && !nativeDragOnly && !result.browserTrustedFrameShadowInput) ||
    (process.platform === 'darwin' && !nativeDragOnly && result.browserAccessibilityStatus !== 'not-granted') ||
    (process.platform === 'darwin' && nativeDragOnly && result.browserAccessibilityStatus !== 'granted') ||
    (process.platform === 'darwin' && !nativeDragOnly && !result.browserFunctionalGateAccessibilityReset) ||
    result.browserScreenshotBytes < 2_000 ||
    (!nativeInputOnly && !nativeDragOnly && !result.sourceControlProjected) ||
    (!nativeInputOnly && !nativeDragOnly && result.sourceControlEntryCount < 4) ||
    (!nativeInputOnly && !nativeDragOnly && !result.checksProviderParsed) ||
    (!nativeInputOnly && !nativeDragOnly && !result.checksPanelMounted) ||
    (!nativeInputOnly && !nativeDragOnly && !result.gitLabChecksPanelMounted) ||
    (!nativeInputOnly && !nativeDragOnly && !result.hostedReviewNative) ||
    (!nativeInputOnly && !nativeDragOnly && !result.nativeChatTranscriptRead)
  ) {
    throw new Error(`real runtime gate failed: ${JSON.stringify(result)}`)
  }
  if (!nativeInputOnly && !nativeDragOnly) {
    const windowLifecycle = evaluateWindowLifecycleEvidence(result.windowLifecycle, process.platform)
    if (!windowLifecycle.passed) {
      throw new Error(`window lifecycle release gate failed: ${JSON.stringify(windowLifecycle)}`)
    }
  }
  if (
    screenshotDir &&
    ['terminal', 'browser', 'source-control', 'checks'].some(
      (surface) => statSync(join(screenshotDir, `tauri-${surface}.png`)).size < 2_000
    )
  ) {
    throw new Error(`real runtime screenshot evidence failed: ${JSON.stringify(result)}`)
  }
  if (screenshotDir) {
    validateTauriRuntimeScreenshots(screenshotDir)
    captureElectronReference(browserFixture.url)
    validateCrossShellParity(screenshotDir)
  }
  console.log(
    `Tauri ${nativeDragOnly ? 'trusted native drag' : nativeInputOnly ? 'trusted native input' : 'real runtime'} gate passed in ${result.durationMs}ms.`
  )
} finally {
  const cleanup = await Promise.allSettled([
    stopFunctionalGateProcess(shell),
    stopFunctionalGateProcess(preview),
    browserFixture.close()
  ])
  for (const result of cleanup) {
    if (result.status === 'rejected') {
      console.warn(`functional gate cleanup failed: ${String(result.reason)}`)
    }
  }
  rmSync(temporary, { recursive: true, force: true })
}

function readEvidenceIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function validateCrossShellParity(directory) {
  for (const surface of ['terminal', 'source-control', 'checks']) {
    const result = compareDesktopParityScreenshots(
      readFileSync(join(directory, `electron-${surface}.png`)),
      readFileSync(join(directory, `tauri-${surface}.png`))
    )
    writeFileSync(join(directory, `${surface}-diff.png`), result.diffBytes)
    const ratio = `${(result.mismatchRatio * 100).toFixed(2)}%`
    if (!result.matches) {
      throw new Error(
        `${surface} cross-shell pixel parity failed: ${ratio} exceeds ` +
          `${(result.maxMismatchRatio * 100).toFixed(2)}%`
      )
    }
    console.log(`${surface} cross-shell pixel mismatch: ${ratio}`)
  }
}

function captureElectronReference(browserUrl) {
  run(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      'tests/e2e/runtime-surface-parity-reference.spec.ts',
      '--config',
      'tests/playwright.config.ts',
      '--project',
      'electron-headless',
      '--workers=1'
    ],
    root,
    {
      PEBBLE_ELECTRON_RUNTIME_SURFACE_DIR: screenshotDir,
      PEBBLE_RUNTIME_PARITY_REPO_PATH: repo,
      PEBBLE_RUNTIME_PARITY_BROWSER_URL: browserUrl,
      PEBBLE_PROVIDER_INVOCATION_LOG: join(screenshotDir, 'provider-invocations.log'),
      PATH: `${providerBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`
    }
  )
}

function seedNativeChatFixture(fixtureRoot) {
  const sessions = join(fixtureRoot, '2026', '07', '18')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    join(sessions, 'rollout-2026-07-18-functional-native-chat.jsonl'),
    `${JSON.stringify({
      timestamp: '2026-07-18T00:00:00Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'PEBBLE_NATIVE_CHAT_TRANSCRIPT'
      }
    })}\n`
  )
}

async function startBrowserFixture() {
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(
      request.url === '/frame'
        ? nativeInputFrameFixtureHtml()
        : nativeInputFixtureHtml('/frame')
    )
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('browser fixture did not bind')
  return {
    url: `http://127.0.0.1:${address.port}/fixture`,
    close: () =>
      new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose()))
      )
  }
}

function seedGitRepository(path) {
  run('git', ['init'], path)
  run('git', ['config', 'user.email', 'functional-gate@pebble.local'], path)
  run('git', ['config', 'user.name', 'Pebble Functional Gate'], path)
  writeFileSync(join(path, 'README.md'), '# Pebble real runtime gate\n')
  writeFileSync(join(path, 'rename-me.txt'), 'rename fixture\n')
  run('git', ['add', 'README.md', 'rename-me.txt'], path)
  run('git', ['commit', '-m', 'Seed real runtime gate'], path)
  run('git', ['branch', '-M', 'main'], path)
  run('git', ['remote', 'add', 'origin', 'https://github.com/nebutra/pebble.git'], path)
  writeFileSync(join(path, 'README.md'), '# Pebble real runtime gate\n\nunstaged\n')
  writeFileSync(join(path, 'staged.txt'), 'staged fixture\n')
  writeFileSync(join(path, 'untracked.txt'), 'untracked fixture\n')
  run('git', ['add', 'staged.txt'], path)
  run('git', ['mv', 'rename-me.txt', 'renamed.txt'], path)
}

function seedGitHubFixture(path) {
  const fixture = `#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
if (process.env.PEBBLE_PROVIDER_INVOCATION_LOG) appendFileSync(process.env.PEBBLE_PROVIDER_INVOCATION_LOG, 'gh ' + JSON.stringify(args) + '\\n')
const has = (...values) => values.every((value) => args.includes(value))
const gitLabPhase = existsSync(join(process.cwd(), '.pebble-gitlab-phase'))
if (has('repo', 'view') && args.includes('--jq')) {
  console.log('nebutra/pebble')
} else if (has('repo', 'view')) {
  console.log(JSON.stringify({ isFork: false, parent: null }))
} else if (has('pr', 'checks')) {
  console.log(JSON.stringify([
    { name: 'Pebble Linux', state: 'SUCCESS', link: 'https://github.com/nebutra/pebble/actions/runs/101' },
    { name: 'Pebble Windows', state: 'FAILURE', link: 'https://github.com/nebutra/pebble/actions/runs/102' },
    { name: 'Pebble macOS', state: 'PENDING', link: 'https://github.com/nebutra/pebble/actions/runs/103' }
  ]))
} else if (has('pr', 'list')) {
  console.log(JSON.stringify(gitLabPhase ? [] : [{
    number: 128, title: 'Provider-backed checks gate', state: 'OPEN',
    url: 'https://github.com/nebutra/pebble/pull/128', labels: [],
    updatedAt: '2026-07-18T00:00:00Z', author: { login: 'pebble-gate' },
    isDraft: false, headRefName: 'main', baseRefName: 'main',
    headRefOid: '0123456789abcdef0123456789abcdef01234567', isCrossRepository: false
  }]))
} else if (has('pr', 'view')) {
  console.log(JSON.stringify({
    number: 128, title: 'Provider-backed checks gate', state: 'OPEN',
    url: 'https://github.com/nebutra/pebble/pull/128', updatedAt: '2026-07-18T00:00:00Z',
    isDraft: false, headRefOid: '0123456789abcdef0123456789abcdef01234567',
    headRefName: 'main', baseRefOid: 'abcdef0123456789abcdef0123456789abcdef01',
    baseRefName: 'main', mergeable: 'MERGEABLE', reviewDecision: null,
    autoMergeRequest: null, mergeStateStatus: 'CLEAN', statusCheckRollup: []
  }))
} else if (args[0] === 'api' && args.some((arg) => arg.includes('/pulls?head='))) {
  console.log(JSON.stringify([{
    number: 128, title: 'Provider-backed checks gate', state: 'open',
    html_url: 'https://github.com/nebutra/pebble/pull/128',
    updated_at: '2026-07-18T00:00:00Z', draft: false, merged_at: null,
    mergeable: true, mergeable_state: 'clean',
    base: { ref: 'main', sha: 'abcdef0123456789abcdef0123456789abcdef01' },
    head: { ref: 'main', sha: '0123456789abcdef0123456789abcdef01234567' }
  }]))
} else if (args[0] === 'api' && args.includes('graphql') && args.some((arg) => arg.includes('statusCheckRollup'))) {
  const checkRun = (databaseId, name, status, conclusion, detailsUrl) => ({
    __typename: 'CheckRun', databaseId, name, status, conclusion, detailsUrl, url: detailsUrl,
    checkSuite: { databaseId: databaseId + 1000, workflowRun: { databaseId: databaseId + 2000 } }
  })
  console.log(JSON.stringify({ data: { repository: { pullRequest: {
    headRefOid: '0123456789abcdef0123456789abcdef01234567',
    commits: { nodes: [{ commit: {
      statusCheckRollup: { contexts: { nodes: [
        checkRun(101, 'Pebble Linux', 'COMPLETED', 'SUCCESS', 'https://github.com/nebutra/pebble/actions/runs/101'),
        checkRun(102, 'Pebble Windows', 'COMPLETED', 'FAILURE', 'https://github.com/nebutra/pebble/actions/runs/102'),
        checkRun(103, 'Pebble macOS', 'IN_PROGRESS', null, 'https://github.com/nebutra/pebble/actions/runs/103')
      ] } },
      checkSuites: { nodes: [] }
    } }] }
  } } } }))
} else if (args[0] === 'api' && args.includes('graphql')) {
  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }))
} else if (args[0] === 'api') {
  console.log('[]')
} else {
  console.error('unsupported functional gh invocation: ' + args.join(' '))
  process.exit(2)
}
`
  const executable = join(path, process.platform === 'win32' ? 'gh-fixture.js' : 'gh')
  writeFileSync(executable, fixture, { mode: 0o755 })
  if (process.platform === 'win32') {
    writeFileSync(join(path, 'gh.cmd'), '@echo off\r\nnode "%~dp0gh-fixture.js" %*\r\n')
  }
}

function seedGitLabFixture(path) {
  const fixture = `#!/usr/bin/env node
const args = process.argv.slice(2)
const joined = args.join(' ')
const print = (value) => console.log(JSON.stringify(value))
if (args[0] === 'repo' && args[1] === 'view') {
  print({ path_with_namespace: 'nebutra/pebble', web_url: 'https://gitlab.com/nebutra/pebble' })
} else if (joined.includes('pipelines/77/jobs')) {
  print([
    { id: 701, name: 'Pebble GitLab Linux', stage: 'verify', status: 'success', web_url: 'https://gitlab.com/jobs/701', duration: 12 },
    { id: 702, name: 'Pebble GitLab Windows', stage: 'verify', status: 'failed', web_url: 'https://gitlab.com/jobs/702', duration: 18 },
    { id: 703, name: 'Pebble GitLab macOS', stage: 'verify', status: 'running', web_url: 'https://gitlab.com/jobs/703', duration: null }
  ])
} else if (joined.includes('merge_requests/9/discussions')) {
  print([])
} else if (joined.includes('merge_requests/9/reviewers')) {
  print([])
} else if (joined.includes('merge_requests/9/approval_state')) {
  print({ rules: [] })
} else if (joined.includes('merge_requests/9/approvals')) {
  print({ approvals_required: 0, approvals_left: 0, approved_by: [] })
} else if (joined.includes('merge_requests/9/diffs')) {
  print([])
} else if (joined.includes('merge_requests/9')) {
  print({
    id: 9009, iid: 9, title: 'GitLab provider-backed checks gate', state: 'opened',
    web_url: 'https://gitlab.com/nebutra/pebble/-/merge_requests/9',
    updated_at: '2026-07-18T00:00:00Z', description: 'Functional gate MR',
    sha: '1123456789abcdef0123456789abcdef01234567',
    diff_refs: { base_sha: 'base', head_sha: '1123456789abcdef0123456789abcdef01234567', start_sha: 'start' },
    head_pipeline: { id: 77 }, source_branch: 'main', target_branch: 'main', labels: []
  })
} else if (joined.includes('merge_requests?') || (args[0] === 'mr' && args[1] === 'list')) {
  print([{
    id: 9009, iid: 9, title: 'GitLab provider-backed checks gate', state: 'opened',
    web_url: 'https://gitlab.com/nebutra/pebble/-/merge_requests/9',
    updated_at: '2026-07-18T00:00:00Z', source_branch: 'main', target_branch: 'main',
    sha: '1123456789abcdef0123456789abcdef01234567', labels: [], draft: false
  }])
} else {
  console.error('unsupported functional glab invocation: ' + joined)
  process.exit(2)
}
`
  const executable = join(path, process.platform === 'win32' ? 'glab-fixture.js' : 'glab')
  writeFileSync(executable, fixture, { mode: 0o755 })
  if (process.platform === 'win32') {
    writeFileSync(join(path, 'glab.cmd'), '@echo off\r\nnode "%~dp0glab-fixture.js" %*\r\n')
  }
}

function run(name, args, cwd, extraEnv = {}) {
  const result = spawnSync(command(name), args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  })
  if (result.status !== 0) throw new Error(`${name} exited with ${result.status ?? 'no status'}`)
}

function resetFunctionalGateAccessibility() {
  if (process.platform !== 'darwin') return false
  const result = spawnSync(
    '/usr/bin/tccutil',
    ['reset', 'Accessibility', 'nebutra.pebble.functional-gate'],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) {
    // Why: tccutil reports an unregistered test bundle as an error even though
    // that state already proves the bundle has no Accessibility grant.
    if (isMissingTccBundleRegistration(result.stderr)) return true
    throw new Error(
      `could not reset functional gate Accessibility: ${result.stderr?.trim() || 'unknown error'}`
    )
  }
  console.log('Functional gate Accessibility grant reset for nebutra.pebble.functional-gate.')
  return true
}

function command(name) {
  return process.platform === 'win32' && !name.includes('\\') && !name.includes('/')
    ? `${name}.cmd`
    : name
}

function findAvailablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((error) => (error || port === null ? reject(error) : resolvePort(port)))
    })
  })
}

function assertPortAvailable(port) {
  return new Promise((resolveAvailable, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', () =>
      reject(new Error(`functional gate renderer port ${port} is already in use`))
    )
    server.listen(port, '127.0.0.1', () =>
      server.close((error) => (error ? reject(error) : resolveAvailable()))
    )
  })
}

async function waitForUrl(url, child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('optimized renderer preview exited early')
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await delay(100)
  }
  throw new Error(`timed out waiting for ${url}`)
}

async function waitForEvidence(path, child, captureDirectory) {
  const deadline = Date.now() + 240_000
  let lastStage = 'not-started'
  const capturedSurfaces = new Set()
  while (Date.now() < deadline) {
    try {
      const evidence = JSON.parse(readFileSync(path, 'utf8'))
      lastStage = evidence.stage || evidence.status || lastStage
      const surface = captureDirectory ? lastStage.match(/^(terminal|browser|source-control|checks)-capture-ready$/)?.[1] : null
      if (process.platform === 'darwin' && surface && !capturedSurfaces.has(surface)) {
        captureFunctionalWindow(surface, captureDirectory)
        capturedSurfaces.add(surface)
      }
      if (evidence.status !== 'running') return
    } catch {}
    if (child.exitCode !== null) throw new Error('functional Tauri shell exited before evidence')
    await delay(100)
  }
  throw new Error(`timed out waiting for real runtime evidence after ${lastStage}`)
}

function captureFunctionalWindow(surface, captureDirectory) {
  if (process.platform !== 'darwin') {
    throw new Error('functional window screenshot evidence is not implemented on this platform')
  }
  const script = `
import CoreGraphics
import Foundation
let rows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
let match = rows.first { row in
  (row[kCGWindowOwnerName as String] as? String) == "pebble-desktop-tauri" &&
  (row[kCGWindowName as String] as? String) == "Pebble Functional Gate" &&
  (row[kCGWindowIsOnscreen as String] as? Bool) == true &&
  (row[kCGWindowLayer as String] as? Int) == 0
}
if let number = match?[kCGWindowNumber as String] as? Int { print(number) }
`
  const lookup = spawnSync('xcrun', ['swift', '-e', script], { encoding: 'utf8' })
  const windowId = Number.parseInt(lookup.stdout?.trim() ?? '', 10)
  if (lookup.status !== 0 || !Number.isInteger(windowId)) {
    throw new Error(`could not resolve functional window id: ${lookup.stderr?.trim() ?? ''}`)
  }
  const output = join(captureDirectory, `tauri-${surface}.png`)
  const ready = `${output}.ready`
  rmSync(output, { force: true })
  rmSync(ready, { force: true })
  // Why: WindowServer shadows expand the bitmap beyond the fixed 1200x800
  // content viewport and make cross-shell pixel coordinates incomparable.
  const captured = spawnSync('/usr/sbin/screencapture', ['-x', '-o', `-l${windowId}`, output], {
    encoding: 'utf8'
  })
  if (captured.status !== 0) {
    throw new Error(`functional window capture failed: ${captured.stderr?.trim() ?? ''}`)
  }
  writeFileSync(ready, '')
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}
