import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { verifyWindowsInnerSignature } from './verify-windows-inner-signature.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')
const desktopRoot = resolve(repoRoot, 'apps/desktop')
const defaultTargetDir = resolve(desktopRoot, 'src-tauri/target')
const tauriManifestPath = resolve(desktopRoot, 'src-tauri/Cargo.toml')
const mainMacosEntitlementsPath = resolve(repoRoot, 'resources/build/entitlements.mac.plist')
const computerUseMacosEntitlementsPath = resolve(
  repoRoot,
  'resources/build/entitlements.computer-use.mac.plist'
)
const sidecarNames = ['pebble-control', 'pebble-relay-worker', 'pebble-runtime']
const macosSpeechLibraryNames = ['libonnxruntime.1.17.1.dylib', 'libsherpa-onnx-c-api.dylib']
const computerUseScripts = [
  ['computer-use-linux', 'runtime.py'],
  ['computer-use-windows', 'runtime.ps1']
]
const relayWorkerTargets = [
  ['darwin', 'amd64', 'x86_64-apple-darwin'],
  ['darwin', 'arm64', 'aarch64-apple-darwin'],
  ['linux', 'amd64', 'x86_64-unknown-linux-gnu'],
  ['linux', 'arm64', 'aarch64-unknown-linux-gnu'],
  ['windows', 'amd64', 'x86_64-pc-windows-msvc'],
  ['windows', 'arm64', 'aarch64-pc-windows-msvc']
]
const supportedPlatforms = new Set(['linux', 'macos', 'windows'])

function walk(root, includeDirectories = false) {
  if (!existsSync(root)) {
    return []
  }
  const matches = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) {
      if (includeDirectories) {
        matches.push(path)
      }
      matches.push(...walk(path, includeDirectories))
    } else if (entry.isFile()) {
      matches.push(path)
    }
  }
  return matches
}

function requireSingle(paths, label) {
  if (paths.length !== 1) {
    throw new Error(`Expected exactly one ${label}; found ${paths.length}.`)
  }
  return paths[0]
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Missing ${label}: ${path}`)
  }
  if (statSync(path).size === 0) {
    throw new Error(`Empty ${label}: ${path}`)
  }
  return path
}

export function resolveReleaseRoot(targetDir, targetTriple, platform) {
  const preferred =
    platform === 'macos'
      ? resolve(targetDir, targetTriple, 'release')
      : resolve(targetDir, 'release')
  const preferredHasOutput =
    existsSync(preferred) &&
    statSync(preferred).isDirectory() &&
    (platform !== 'macos' || existsSync(resolve(preferred, 'bundle/macos/Pebble.app')))
  if (preferredHasOutput) {
    return preferred
  }
  const localMacosRelease = resolve(targetDir, 'release')
  // Why: `tauri build` without `--target` uses Cargo's default target/release
  // even though artifact verification still needs the host architecture triple.
  if (
    platform === 'macos' &&
    existsSync(localMacosRelease) &&
    statSync(localMacosRelease).isDirectory() &&
    existsSync(resolve(localMacosRelease, 'bundle/macos/Pebble.app'))
  ) {
    return localMacosRelease
  }
  throw new Error(`No ${platform} release output found at ${preferred}.`)
}

function expectedArchitectures(targetTriple) {
  if (targetTriple === 'universal-apple-darwin') {
    return ['aarch64', 'x86_64']
  }
  if (targetTriple.startsWith('aarch64')) {
    return ['aarch64']
  }
  if (targetTriple.startsWith('x86_64')) {
    return ['x86_64']
  }
  throw new Error(`Unsupported release target triple: ${targetTriple || '<missing>'}.`)
}

function readFatMachArchitectures(bytes, entrySize) {
  const count = bytes.readUInt32BE(4)
  if (count === 0 || count > 16 || bytes.length < 8 + count * entrySize) {
    return []
  }
  const architectures = []
  for (let index = 0; index < count; index += 1) {
    const cpuType = bytes.readUInt32BE(8 + index * entrySize)
    if (cpuType === 0x0100000c) {
      architectures.push('aarch64')
    }
    if (cpuType === 0x01000007) {
      architectures.push('x86_64')
    }
  }
  return architectures
}

export function detectBinaryArchitectures(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20) {
    return []
  }

  const magic = bytes.readUInt32BE(0)
  if (magic === 0xcafebabe) {
    return readFatMachArchitectures(bytes, 20)
  }
  if (magic === 0xcafebabf) {
    return readFatMachArchitectures(bytes, 32)
  }

  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const littleEndian = bytes[5] === 1
    const machine = littleEndian ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18)
    if (machine === 0xb7) {
      return ['aarch64']
    }
    if (machine === 0x3e) {
      return ['x86_64']
    }
  }

  if (bytes[0] === 0x4d && bytes[1] === 0x5a && bytes.length >= 64) {
    const peOffset = bytes.readUInt32LE(0x3c)
    if (
      bytes.length >= peOffset + 6 &&
      bytes.toString('ascii', peOffset, peOffset + 4) === 'PE\0\0'
    ) {
      const machine = bytes.readUInt16LE(peOffset + 4)
      if (machine === 0xaa64) {
        return ['aarch64']
      }
      if (machine === 0x8664) {
        return ['x86_64']
      }
    }
  }

  if (magic === 0xcffaedfe) {
    const cpuType = bytes.readUInt32LE(4)
    if (cpuType === 0x0100000c) {
      return ['aarch64']
    }
    if (cpuType === 0x01000007) {
      return ['x86_64']
    }
  }

  return []
}

export function verifyBinaryArchitecture(path, targetTriple) {
  const actual = [...new Set(detectBinaryArchitectures(readFileSync(path)))].sort()
  const expected = expectedArchitectures(targetTriple).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${path} has architectures ${actual.join(', ') || '<unknown>'}; expected ${expected.join(', ')}.`
    )
  }
  return actual
}

export function runArtifactCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || 'no command output'
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
  return { stderr: result.stderr ?? '', stdout: result.stdout ?? '' }
}

export function macosDyldProbeCommand(mainExecutable, sleepSeconds = 3) {
  const probeScript = String.raw`
    const { spawn } = require('node:child_process')
    const [executable, seconds] = process.argv.slice(1)
    const child = spawn(executable, [], { stdio: 'ignore' })
    let settled = false
    let survived = false
    const finish = (code, message) => {
      if (settled) return
      settled = true
      if (message) console.error(message)
      process.exit(code)
    }
    child.once('error', (error) => finish(1, 'Pebble dyld probe failed to spawn: ' + error.message))
    child.once('exit', (code, signal) => finish(
      survived ? 0 : 1,
      survived ? '' : 'Pebble exited during dyld probe (status ' + (code ?? signal ?? 'unknown') + ')'
    ))
    setTimeout(() => {
      if (settled || child.exitCode !== null || child.signalCode !== null) return
      survived = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    }, Number(seconds) * 1000)
  `
  return {
    args: ['-e', probeScript, mainExecutable, String(sleepSeconds)],
    command: process.execPath
  }
}

export function validateMacosCodeSignatureMetadata(output, expectedTeamId) {
  if (typeof expectedTeamId !== 'string' || expectedTeamId.trim() === '') {
    throw new Error('APPLE_TEAM_ID is required for macOS artifact inspection.')
  }
  if (!/^Authority=Developer ID Application:/mu.test(output)) {
    throw new Error('macOS artifact is not signed by a Developer ID Application identity.')
  }
  const teamMatch = output.match(/^TeamIdentifier=(.+)$/mu)
  if (teamMatch?.[1]?.trim() !== expectedTeamId.trim()) {
    throw new Error(
      `macOS artifact team identifier is ${teamMatch?.[1]?.trim() || '<missing>'}; expected ${expectedTeamId.trim()}.`
    )
  }
  if (!/\bflags=0x[0-9a-f]+\([^\n)]*\bruntime\b[^\n)]*\)/iu.test(output)) {
    throw new Error('macOS artifact signature does not enable hardened runtime.')
  }
}

export function validateMacosEntitlements(output, requiredKeys, label) {
  if (!/<plist\b[^>]*>[\s\S]*<dict>[\s\S]*<\/dict>[\s\S]*<\/plist>/u.test(output)) {
    throw new Error(`${label} has no embedded entitlements plist.`)
  }
  for (const key of requiredKeys) {
    if (!output.includes(`<key>${key}</key>`)) {
      throw new Error(`${label} is missing required entitlement ${key}.`)
    }
  }
}

function entitlementKeys(path) {
  return [...readFileSync(path, 'utf8').matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1])
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function evidencePath(path) {
  return relative(repoRoot, path).split(sep).join('/')
}

function evidenceRecord(role, path, checks) {
  const stats = statSync(path)
  return {
    checks: [...checks].sort(),
    path: evidencePath(path),
    role,
    sha256: sha256(path),
    size: stats.size
  }
}

export function verifyUpdaterSignatureWithRust({ payloadPath, publicKey, signaturePath }) {
  if (typeof publicKey !== 'string' || publicKey.trim() === '') {
    throw new Error('TAURI_UPDATER_PUBLIC_KEY is required for updater signature inspection.')
  }
  runArtifactCommand('cargo', [
    'run',
    '--quiet',
    '--manifest-path',
    tauriManifestPath,
    '--bin',
    'pebble-updater-signature-verifier',
    '--',
    publicKey,
    payloadPath,
    signaturePath
  ])
}

function verifyUpdaterArtifacts(root, updaterSignatureVerifier, updaterPublicKey) {
  const signatures = walk(resolve(root, 'bundle')).filter((path) => path.endsWith('.sig'))
  if (signatures.length === 0) {
    throw new Error('No signed Tauri updater artifacts were found.')
  }

  return signatures.flatMap((signaturePath) => {
    const payloadPath = requireFile(signaturePath.slice(0, -4), 'updater payload')
    requireFile(signaturePath, 'updater signature')
    updaterSignatureVerifier({ payloadPath, publicKey: updaterPublicKey, signaturePath })
    return [
      evidenceRecord('updater-payload', payloadPath, [
        'cryptographic-signature-valid',
        'signature-sidecar-present'
      ]),
      evidenceRecord('updater-signature', signaturePath, [
        'cryptographic-signature-valid',
        'non-empty'
      ])
    ]
  })
}

function preparedSidecars(targetTriple, desktopDir) {
  const extension = targetTriple.includes('windows') ? '.exe' : ''
  return sidecarNames.map((name) =>
    requireFile(
      resolve(desktopDir, 'src-tauri/binaries', `${name}-${targetTriple}${extension}`),
      `prepared ${name} sidecar`
    )
  )
}

function preparedRelayWorkerMatrix(desktopDir) {
  return relayWorkerTargets.map(([goos, goarch, targetTriple]) => ({
    path: requireFile(
      resolve(
        desktopDir,
        'src-tauri/binaries/relay-workers',
        `pebble-relay-worker-${goos}-${goarch}${goos === 'windows' ? '.exe' : ''}`
      ),
      `prepared relay worker for ${goos}/${goarch}`
    ),
    targetTriple
  }))
}

function bundledRelayWorkerMatrix(appPath) {
  return relayWorkerTargets.map(([goos, goarch, targetTriple]) => ({
    goos,
    path: requireFile(
      resolve(
        appPath,
        'Contents/Resources/binaries/relay-workers',
        `pebble-relay-worker-${goos}-${goarch}${goos === 'windows' ? '.exe' : ''}`
      ),
      `bundled relay worker for ${goos}/${goarch}`
    ),
    targetTriple
  }))
}

function verifyInstalledRelayWorkerMatrix(root) {
  const files = walk(root)
  for (const [goos, goarch, targetTriple] of relayWorkerTargets) {
    const name = `pebble-relay-worker-${goos}-${goarch}${goos === 'windows' ? '.exe' : ''}`
    const path = requireSingle(
      files.filter((candidate) => basename(candidate) === name),
      `installed relay worker for ${goos}/${goarch}`
    )
    verifyBinaryArchitecture(path, targetTriple)
  }
}

function installedComputerUseScripts(root) {
  const files = walk(root)
  return computerUseScripts.map(([directory, name]) =>
    requireSingle(
      files.filter((candidate) => {
        const normalized = relative(root, candidate).split(sep).join('/')
        return normalized.endsWith(`${directory}/${name}`)
      }),
      `installed ${directory} provider script`
    )
  )
}

function verifyExtractedPackageResources(extract) {
  const extractionRoot = mkdtempSync(resolve(tmpdir(), 'pebble-package-resources-'))
  try {
    extract(extractionRoot)
    verifyInstalledRelayWorkerMatrix(extractionRoot)
    for (const path of installedComputerUseScripts(extractionRoot)) {
      requireFile(path, 'installed computer-use provider script')
    }
  } finally {
    rmSync(extractionRoot, { force: true, recursive: true })
  }
}

function verifyMacosArtifacts(root, targetTriple, commandRunner, expectedAppleTeamId) {
  const apps = walk(resolve(root, 'bundle'), true).filter(
    (path) => extname(path) === '.app' && basename(path) === 'Pebble.app'
  )
  const appPath = requireSingle(apps, 'macOS app bundle')
  const sidecars = sidecarNames.map((name) =>
    requireFile(resolve(appPath, 'Contents/MacOS', name), `bundled ${name} sidecar`)
  )
  const speechLibraries = macosSpeechLibraryNames.map((name) =>
    requireFile(resolve(appPath, 'Contents/Frameworks', name), `bundled ${name}`)
  )
  const relayWorkers = bundledRelayWorkerMatrix(appPath)
  const simulatorHelper = requireFile(
    resolve(appPath, 'Contents/Resources/serve-sim/serve-sim-bin'),
    'bundled iOS simulator helper'
  )
  const computerUseHelper = requireFile(
    resolve(
      appPath,
      'Contents/Resources/Pebble Computer Use.app/Contents/MacOS/pebble-computer-use-macos'
    ),
    'bundled macOS computer-use helper'
  )
  const computerUseHelperApp = resolve(appPath, 'Contents/Resources/Pebble Computer Use.app')
  const computerUseProviders = installedComputerUseScripts(appPath).map((path) =>
    requireFile(path, 'bundled computer-use provider script')
  )

  for (const path of [...sidecars, ...speechLibraries, simulatorHelper, computerUseHelper]) {
    verifyBinaryArchitecture(path, targetTriple)
    commandRunner('codesign', ['--verify', '--strict', path])
    const metadata = commandRunner('codesign', ['--display', '--verbose=4', path])
    validateMacosCodeSignatureMetadata(
      `${metadata.stdout ?? ''}\n${metadata.stderr ?? ''}`,
      expectedAppleTeamId
    )
  }
  for (const { goos, path, targetTriple: relayTargetTriple } of relayWorkers) {
    verifyBinaryArchitecture(path, relayTargetTriple)
    if (goos === 'darwin') {
      // Remote Darwin workers execute as native code, so notarized releases must sign them too.
      commandRunner('codesign', ['--verify', '--strict', path])
      const metadata = commandRunner('codesign', ['--display', '--verbose=4', path])
      validateMacosCodeSignatureMetadata(
        `${metadata.stdout ?? ''}\n${metadata.stderr ?? ''}`,
        expectedAppleTeamId
      )
    }
  }
  commandRunner('codesign', ['--verify', '--strict', '--deep', computerUseHelperApp])
  const helperEntitlements = commandRunner('codesign', [
    '--display',
    '--entitlements',
    ':-',
    computerUseHelperApp
  ])
  validateMacosEntitlements(
    `${helperEntitlements.stdout ?? ''}\n${helperEntitlements.stderr ?? ''}`,
    entitlementKeys(computerUseMacosEntitlementsPath),
    'macOS computer-use helper'
  )
  commandRunner('codesign', ['--verify', '--strict', '--deep', appPath])
  const appMetadata = commandRunner('codesign', ['--display', '--verbose=4', appPath])
  validateMacosCodeSignatureMetadata(
    `${appMetadata.stdout ?? ''}\n${appMetadata.stderr ?? ''}`,
    expectedAppleTeamId
  )
  const appEntitlements = commandRunner('codesign', ['--display', '--entitlements', ':-', appPath])
  validateMacosEntitlements(
    `${appEntitlements.stdout ?? ''}\n${appEntitlements.stderr ?? ''}`,
    entitlementKeys(mainMacosEntitlementsPath),
    'macOS app bundle'
  )
  // Why: a valid Developer ID signature alone does not prove notarization was stapled.
  commandRunner('xcrun', ['stapler', 'validate', appPath])

  const diskImages = walk(resolve(root, 'bundle')).filter(
    (path) => extname(path).toLowerCase() === '.dmg'
  )
  const diskImage = requireSingle(diskImages, 'macOS DMG installer')
  commandRunner('xcrun', ['stapler', 'validate', diskImage])

  const mainExecutable = requireSingle(
    walk(resolve(appPath, 'Contents/MacOS')).filter(
      (path) => !sidecarNames.includes(basename(path))
    ),
    'macOS main executable'
  )
  verifyBinaryArchitecture(mainExecutable, targetTriple)
  // Why: file and signature checks do not prove dyld can resolve bundled
  // @rpath libraries; require the release executable to stay alive at startup.
  const probe = macosDyldProbeCommand(mainExecutable)
  commandRunner(probe.command, probe.args)
  return [
    evidenceRecord('main-executable', mainExecutable, [
      'architecture',
      'codesign-developer-id',
      'codesign-strict',
      'dyld-launch',
      'entitlements',
      'hardened-runtime',
      'notarization-stapled'
    ]),
    evidenceRecord('installer', diskImage, ['notarization-stapled']),
    ...sidecars.map((path) =>
      evidenceRecord('bundled-sidecar', path, [
        'architecture',
        'codesign-developer-id',
        'codesign-strict',
        'hardened-runtime'
      ])
    ),
    ...speechLibraries.map((path) =>
      evidenceRecord('bundled-native-library', path, [
        'architecture',
        'codesign-developer-id',
        'codesign-strict',
        'hardened-runtime'
      ])
    ),
    ...relayWorkers.map(({ goos, path }) =>
      evidenceRecord(
        'bundled-relay-worker',
        path,
        goos === 'darwin'
          ? ['architecture', 'codesign-developer-id', 'codesign-strict', 'hardened-runtime']
          : ['architecture']
      )
    ),
    ...computerUseProviders.map((path) =>
      evidenceRecord('bundled-computer-use-provider', path, [
        'native-provider-resource',
        'non-empty'
      ])
    ),
    evidenceRecord('bundled-emulator-helper', simulatorHelper, [
      'architecture',
      'codesign-developer-id',
      'codesign-strict',
      'hardened-runtime'
    ]),
    evidenceRecord('bundled-computer-use-helper', computerUseHelper, [
      'architecture',
      'codesign-developer-id',
      'codesign-strict',
      'entitlements',
      'hardened-runtime'
    ])
  ]
}

function verifyWindowsArtifacts(root, targetTriple, signatureVerifier, commandRunner) {
  const mainExecutable = requireFile(
    resolve(root, 'pebble-desktop-tauri.exe'),
    'Windows main executable'
  )
  const sidecars = sidecarNames.map((name) =>
    requireFile(resolve(root, `${name}.exe`), `staged ${name} sidecar`)
  )
  const bundleFiles = walk(resolve(root, 'bundle'))
  const nsisInstaller = requireSingle(
    bundleFiles.filter((path) => extname(path).toLowerCase() === '.exe'),
    'Windows NSIS installer'
  )
  const msiInstaller = requireSingle(
    bundleFiles.filter((path) => extname(path).toLowerCase() === '.msi'),
    'Windows MSI installer'
  )
  const installers = [nsisInstaller, msiInstaller]

  for (const path of [mainExecutable, ...sidecars, ...installers]) {
    signatureVerifier(path)
  }
  for (const path of [mainExecutable, ...sidecars]) {
    verifyBinaryArchitecture(path, targetTriple)
  }
  verifyExtractedPackageResources((extractionRoot) =>
    commandRunner('msiexec', ['/a', msiInstaller, '/qn', `TARGETDIR=${extractionRoot}`])
  )
  verifyExtractedPackageResources((extractionRoot) =>
    commandRunner(nsisInstaller, ['/S', `/D=${extractionRoot}`])
  )

  return [
    evidenceRecord('main-executable', mainExecutable, ['architecture', 'authenticode-valid']),
    ...sidecars.map((path) =>
      evidenceRecord('staged-sidecar', path, ['architecture', 'authenticode-valid'])
    ),
    evidenceRecord('installer', nsisInstaller, [
      'authenticode-valid',
      'computer-use-providers-contained',
      'relay-worker-matrix-contained',
      'silent-install-smoke'
    ]),
    evidenceRecord('installer', msiInstaller, [
      'authenticode-valid',
      'computer-use-providers-contained',
      'relay-worker-matrix-contained'
    ])
  ]
}

function linuxPackageArchitecture(targetTriple) {
  return targetTriple.startsWith('aarch64') ? 'arm64' : 'amd64'
}

const oldestSupportedLinuxGlibc = [2, 35]

export function verifyLinuxGlibcSymbolCeiling(output, path) {
  const versions = [...output.matchAll(/\bGLIBC_(\d+)\.(\d+)\b/gu)].map((match) => [
    Number(match[1]),
    Number(match[2])
  ])
  const unsupported = versions.find(
    ([major, minor]) =>
      major > oldestSupportedLinuxGlibc[0] ||
      (major === oldestSupportedLinuxGlibc[0] && minor > oldestSupportedLinuxGlibc[1])
  )
  if (unsupported) {
    throw new Error(
      `${path} requires GLIBC_${unsupported.join('.')}; Pebble Linux releases must stay compatible with GLIBC_2.35.`
    )
  }
}

function verifyLinuxArtifacts(root, targetTriple, commandRunner) {
  const mainExecutable = requireFile(resolve(root, 'pebble-desktop-tauri'), 'Linux main executable')
  const sidecars = sidecarNames.map((name) =>
    requireFile(resolve(root, name), `staged ${name} sidecar`)
  )
  for (const path of [mainExecutable, ...sidecars]) {
    verifyBinaryArchitecture(path, targetTriple)
    // Why: release runners may have a newer libc than supported user systems.
    verifyLinuxGlibcSymbolCeiling(
      commandRunner('readelf', ['--version-info', '--wide', path]).stdout,
      path
    )
  }

  const debPackages = walk(resolve(root, 'bundle')).filter((path) => path.endsWith('.deb'))
  const debPackage = requireSingle(debPackages, 'Linux Debian installer')
  const debArchitecture = commandRunner('dpkg-deb', [
    '--field',
    debPackage,
    'Architecture'
  ]).stdout.trim()
  if (debArchitecture !== linuxPackageArchitecture(targetTriple)) {
    throw new Error(
      `${debPackage} has Debian architecture ${debArchitecture || '<missing>'}; expected ${linuxPackageArchitecture(targetTriple)}.`
    )
  }
  const debDependencies = commandRunner('dpkg-deb', ['--field', debPackage, 'Depends']).stdout
  for (const dependency of ['at-spi2-core', 'gir1.2-atspi-2.0', 'python3', 'python3-gi']) {
    if (
      !new RegExp(`(^|[,\\s])${dependency.replaceAll('.', '\\.')}(?:\\s|,|\\(|$)`).test(
        debDependencies
      )
    ) {
      throw new Error(`${debPackage} is missing required computer-use dependency ${dependency}.`)
    }
  }
  verifyExtractedPackageResources((extractionRoot) =>
    commandRunner('dpkg-deb', ['--extract', debPackage, extractionRoot])
  )
  return [
    evidenceRecord('main-executable', mainExecutable, ['architecture', 'glibc-symbol-ceiling']),
    ...sidecars.map((path) =>
      evidenceRecord('staged-sidecar', path, ['architecture', 'glibc-symbol-ceiling'])
    ),
    evidenceRecord('installer', debPackage, [
      'package-architecture',
      'computer-use-dependencies-declared',
      'computer-use-providers-contained',
      'relay-worker-matrix-contained'
    ])
  ]
}

export function verifyTauriReleaseArtifacts({
  platform,
  targetTriple,
  targetDir = defaultTargetDir,
  desktopDir = desktopRoot,
  commandRunner = runArtifactCommand,
  expectedAppleTeamId = process.env.APPLE_TEAM_ID,
  updaterPublicKey = process.env.TAURI_UPDATER_PUBLIC_KEY,
  updaterSignatureVerifier = verifyUpdaterSignatureWithRust,
  windowsSignatureVerifier = (path) => verifyWindowsInnerSignature({ executablePath: path })
}) {
  if (!supportedPlatforms.has(platform)) {
    throw new Error(`Unsupported Tauri release platform: ${platform || '<missing>'}.`)
  }
  expectedArchitectures(targetTriple)
  const root = resolveReleaseRoot(targetDir, targetTriple, platform)

  const prepared = preparedSidecars(targetTriple, desktopDir)
  const preparedRelayWorkers = preparedRelayWorkerMatrix(desktopDir)
  const platformArtifacts =
    platform === 'macos'
      ? verifyMacosArtifacts(root, targetTriple, commandRunner, expectedAppleTeamId)
      : platform === 'windows'
        ? verifyWindowsArtifacts(root, targetTriple, windowsSignatureVerifier, commandRunner)
        : verifyLinuxArtifacts(root, targetTriple, commandRunner)

  const artifacts = [
    ...prepared.map((path) => {
      verifyBinaryArchitecture(path, targetTriple)
      return evidenceRecord('prepared-sidecar', path, ['architecture'])
    }),
    ...preparedRelayWorkers.map(({ path, targetTriple: relayTargetTriple }) => {
      verifyBinaryArchitecture(path, relayTargetTriple)
      return evidenceRecord('prepared-relay-worker', path, ['architecture'])
    }),
    ...platformArtifacts,
    ...(platform === 'linux'
      ? []
      : verifyUpdaterArtifacts(root, updaterSignatureVerifier, updaterPublicKey))
  ].sort((left, right) => `${left.role}:${left.path}`.localeCompare(`${right.role}:${right.path}`))

  return { artifacts, platform, schemaVersion: 1, targetTriple }
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value == null) {
      throw new Error(
        'Usage: verify-tauri-release-artifacts --platform <platform> --target-triple <triple> --output <path> [--target-dir <path>]'
      )
    }
    options[key.slice(2)] = value
  }
  return options
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  if (!options.output) {
    throw new Error('--output is required.')
  }
  const evidence = verifyTauriReleaseArtifacts({
    platform: options.platform,
    targetDir: options['target-dir'] ? resolve(options['target-dir']) : defaultTargetDir,
    targetTriple: options['target-triple']
  })
  const outputPath = resolve(options.output)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`Verified ${evidence.artifacts.length} release artifacts; wrote ${outputPath}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
