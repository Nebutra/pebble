import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { resolveMacosCodeSigningIdentity } from './macos-code-signing-identity.mjs'

const desktopRoot = resolve(import.meta.dirname, '..')
const goRoot = resolve(desktopRoot, '..', '..', 'runtime', 'go')
const outputRoot = resolve(desktopRoot, 'src-tauri', 'binaries')
const target = process.env.TAURI_ENV_TARGET_TRIPLE || hostTargetTriple()
const hostOnly = process.argv.includes('--host-only')
mkdirSync(resolve(outputRoot, 'relay-workers'), { recursive: true })

for (const binary of ['pebble-runtime', 'pebble-control', 'pebble-relay-worker']) {
  buildSidecar(binary, target)
}
if (!hostOnly) {
  // Why: local dev and native capture need host sidecars only; release builds own the relay matrix.
  buildRelayWorkerMatrix()
  signDarwinRelayWorkersForDistribution()
}

function buildRelayWorkerMatrix() {
  for (const [goos, goarch] of [
    ['darwin', 'amd64'],
    ['darwin', 'arm64'],
    ['linux', 'amd64'],
    ['linux', 'arm64'],
    ['windows', 'amd64'],
    ['windows', 'arm64']
  ]) {
    const extension = goos === 'windows' ? '.exe' : ''
    buildGo(
      'pebble-relay-worker',
      resolve(outputRoot, 'relay-workers', `pebble-relay-worker-${goos}-${goarch}${extension}`),
      goos,
      goarch
    )
  }
}

function signDarwinRelayWorkersForDistribution() {
  if (platform() !== 'darwin') {
    return
  }
  const identity = resolveMacosCodeSigningIdentity()
  if (!identity) {
    return
  }
  for (const goarch of ['amd64', 'arm64']) {
    const path = resolve(outputRoot, 'relay-workers', `pebble-relay-worker-darwin-${goarch}`)
    run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, path])
  }
}

function buildSidecar(binary, triple) {
  if (triple === 'universal-apple-darwin') {
    const arm = sidecarPath(binary, 'aarch64-apple-darwin')
    const intel = sidecarPath(binary, 'x86_64-apple-darwin')
    buildGo(binary, arm, 'darwin', 'arm64')
    buildGo(binary, intel, 'darwin', 'amd64')
    const output = sidecarPath(binary, triple)
    run('lipo', ['-create', '-output', output, arm, intel])
    rmSync(arm, { force: true })
    rmSync(intel, { force: true })
    return
  }
  const resolved = goTarget(triple)
  buildGo(binary, sidecarPath(binary, triple), resolved.goos, resolved.goarch)
}

function buildGo(binary, output, goos, goarch) {
  mkdirSync(dirname(output), { recursive: true })
  const temporary = `${output}.tmp-${process.pid}`
  rmSync(temporary, { force: true })
  run('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', temporary, `./cmd/${binary}`], {
    cwd: goRoot,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch }
  })
  renameSync(temporary, output)
}

function sidecarPath(binary, triple) {
  const extension = triple.includes('windows') ? '.exe' : ''
  return resolve(outputRoot, `${binary}-${triple}${extension}`)
}

function goTarget(triple) {
  const goos = triple.includes('windows')
    ? 'windows'
    : triple.includes('apple-darwin')
      ? 'darwin'
      : triple.includes('linux')
        ? 'linux'
        : null
  const goarch = triple.startsWith('aarch64')
    ? 'arm64'
    : triple.startsWith('x86_64')
      ? 'amd64'
      : null
  if (!goos || !goarch) {
    throw new Error(`Unsupported Tauri sidecar target: ${triple}`)
  }
  return { goos, goarch }
}

function hostTargetTriple() {
  const hostPlatform = platform()
  const hostArch = arch()
  const prefix = hostArch === 'arm64' ? 'aarch64' : hostArch === 'x64' ? 'x86_64' : null
  const suffix =
    hostPlatform === 'darwin'
      ? 'apple-darwin'
      : hostPlatform === 'linux'
        ? 'unknown-linux-gnu'
        : hostPlatform === 'win32'
          ? 'pc-windows-msvc'
          : null
  if (!prefix || !suffix) {
    throw new Error(`Unsupported host for Tauri sidecars: ${hostPlatform}/${hostArch}`)
  }
  return `${prefix}-${suffix}`
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`)
  }
}
