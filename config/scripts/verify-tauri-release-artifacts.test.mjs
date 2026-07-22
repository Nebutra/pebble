import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  detectBinaryArchitectures,
  macosDyldProbeCommand,
  resolveReleaseRoot,
  runArtifactCommand,
  verifyBinaryArchitecture,
  verifyLinuxGlibcSymbolCeiling,
  verifyTauriReleaseArtifacts as inspectTauriReleaseArtifacts
} from './verify-tauri-release-artifacts.mjs'

const temporaryDirectories = []

function verifyTauriReleaseArtifacts(options) {
  return inspectTauriReleaseArtifacts({
    updaterPublicKey: 'test-updater-public-key',
    updaterSignatureVerifier: vi.fn(),
    ...options
  })
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true })
  }
})

function temporaryDesktop() {
  const desktopDir = mkdtempSync(join(tmpdir(), 'pebble-tauri-release-'))
  temporaryDirectories.push(desktopDir)
  return desktopDir
}

function writeBinary(path, bytes) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
}

function elfBinary(machine) {
  const bytes = Buffer.alloc(64)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  bytes.writeUInt16LE(machine, 18)
  return bytes
}

function peBinary(machine) {
  const bytes = Buffer.alloc(128)
  bytes.set([0x4d, 0x5a])
  bytes.writeUInt32LE(64, 0x3c)
  bytes.write('PE\0\0', 64, 'ascii')
  bytes.writeUInt16LE(machine, 68)
  return bytes
}

function universalMachBinary() {
  const bytes = Buffer.alloc(48)
  bytes.writeUInt32BE(0xcafebabe, 0)
  bytes.writeUInt32BE(2, 4)
  bytes.writeUInt32BE(0x0100000c, 8)
  bytes.writeUInt32BE(0x01000007, 28)
  return bytes
}

function thinMachBinary(cpuType) {
  const bytes = Buffer.alloc(32)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(cpuType, 4)
  return bytes
}

function createPreparedRelayWorkerMatrix(desktopDir) {
  const targets = [
    ['darwin', 'amd64', thinMachBinary(0x01000007)],
    ['darwin', 'arm64', thinMachBinary(0x0100000c)],
    ['linux', 'amd64', elfBinary(0x3e)],
    ['linux', 'arm64', elfBinary(0xb7)],
    ['windows', 'amd64', peBinary(0x8664)],
    ['windows', 'arm64', peBinary(0xaa64)]
  ]
  for (const [goos, goarch, bytes] of targets) {
    writeBinary(
      join(
        desktopDir,
        'src-tauri/binaries/relay-workers',
        `pebble-relay-worker-${goos}-${goarch}${goos === 'windows' ? '.exe' : ''}`
      ),
      bytes
    )
  }
}

function createBundledRelayWorkerMatrix(appContentsPath) {
  const targets = [
    ['darwin', 'amd64', thinMachBinary(0x01000007)],
    ['darwin', 'arm64', thinMachBinary(0x0100000c)],
    ['linux', 'amd64', elfBinary(0x3e)],
    ['linux', 'arm64', elfBinary(0xb7)],
    ['windows', 'amd64', peBinary(0x8664)],
    ['windows', 'arm64', peBinary(0xaa64)]
  ]
  for (const [goos, goarch, bytes] of targets) {
    writeBinary(
      join(
        appContentsPath,
        'Resources/binaries/relay-workers',
        `pebble-relay-worker-${goos}-${goarch}${goos === 'windows' ? '.exe' : ''}`
      ),
      bytes
    )
  }
  writeBinary(
    join(appContentsPath, 'Resources/computer-use-linux/runtime.py'),
    Buffer.from('# native Linux provider')
  )
  writeBinary(
    join(appContentsPath, 'Resources/computer-use-windows/runtime.ps1'),
    Buffer.from('# native Windows provider')
  )
  writeBinary(join(appContentsPath, 'Resources/serve-sim/serve-sim-bin'), universalMachBinary())
  writeBinary(
    join(
      appContentsPath,
      'Resources/Pebble Computer Use.app/Contents/MacOS/pebble-computer-use-macos'
    ),
    universalMachBinary()
  )
}

function createPreparedSidecars(desktopDir, targetTriple, bytes) {
  const extension = targetTriple.includes('windows') ? '.exe' : ''
  for (const name of ['pebble-runtime', 'pebble-control', 'pebble-relay-worker']) {
    writeBinary(
      join(desktopDir, 'src-tauri/binaries', `${name}-${targetTriple}${extension}`),
      bytes
    )
  }
  createPreparedRelayWorkerMatrix(desktopDir)
}

function createUpdaterArtifact(releaseDir, name = 'Pebble.updater.tar.gz') {
  writeBinary(join(releaseDir, 'bundle/updater', name), Buffer.from('updater-payload'))
  writeBinary(
    join(releaseDir, 'bundle/updater', `${name}.sig`),
    Buffer.from('UklHMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=')
  )
}

describe('Tauri release artifact architecture detection', () => {
  it('recognizes x64 ELF, x64 PE, and universal Mach-O binaries', () => {
    expect(detectBinaryArchitectures(elfBinary(0x3e))).toEqual(['x86_64'])
    expect(detectBinaryArchitectures(peBinary(0x8664))).toEqual(['x86_64'])
    expect(detectBinaryArchitectures(universalMachBinary())).toEqual(['aarch64', 'x86_64'])
  })

  it('rejects a valid binary built for the wrong target', () => {
    const desktopDir = temporaryDesktop()
    const binaryPath = join(desktopDir, 'pebble-runtime')
    writeBinary(binaryPath, elfBinary(0x3e))

    expect(() => verifyBinaryArchitecture(binaryPath, 'aarch64-unknown-linux-gnu')).toThrow(
      /expected aarch64/
    )
  })
})

describe.runIf(process.platform !== 'win32')('macOS dyld launch probe', () => {
  it('rejects an early clean exit and accepts a process that remains alive', () => {
    const directory = temporaryDesktop()
    const earlyExit = '/usr/bin/true'
    const staysAlive = join(directory, 'stays-alive')
    writeFileSync(staysAlive, '#!/bin/sh\nsleep 1\n')
    chmodSync(staysAlive, 0o755)

    const earlyProbe = macosDyldProbeCommand(earlyExit, 0.05)
    expect(() => runArtifactCommand(earlyProbe.command, earlyProbe.args)).toThrow(
      /exited during dyld probe/
    )
    const liveProbe = macosDyldProbeCommand(staysAlive, 0.05)
    expect(() => runArtifactCommand(liveProbe.command, liveProbe.args)).not.toThrow()
  })
})

describe('Tauri release artifact inspection', () => {
  it('rejects Linux binaries linked against a newer glibc than the support floor', () => {
    expect(() =>
      verifyLinuxGlibcSymbolCeiling(
        'Name: GLIBC_2.34\nName: GLIBC_2.36',
        '/tmp/pebble-desktop-tauri'
      )
    ).toThrow(/GLIBC_2\.36.*GLIBC_2\.35/)

    expect(() =>
      verifyLinuxGlibcSymbolCeiling('Name: GLIBC_2.35', '/tmp/pebble-runtime')
    ).not.toThrow()
  })
  it('finds a host macOS bundle when a side-library target directory also exists', () => {
    const desktopDir = temporaryDesktop()
    const targetDir = join(desktopDir, 'src-tauri/target')
    mkdirSync(join(targetDir, 'aarch64-apple-darwin/release'), { recursive: true })
    mkdirSync(join(targetDir, 'release/bundle/macos/Pebble.app'), { recursive: true })

    expect(resolveReleaseRoot(targetDir, 'aarch64-apple-darwin', 'macos')).toBe(
      join(targetDir, 'release')
    )
  })

  it('verifies Linux prepared and staged sidecar architecture with deterministic hashes', () => {
    const desktopDir = temporaryDesktop()
    const targetTriple = 'x86_64-unknown-linux-gnu'
    const targetDir = join(desktopDir, 'src-tauri/target')
    const releaseDir = join(targetDir, 'release')
    const bytes = elfBinary(0x3e)
    createPreparedSidecars(desktopDir, targetTriple, bytes)
    writeBinary(join(releaseDir, 'pebble-desktop-tauri'), bytes)
    for (const name of ['pebble-runtime', 'pebble-control', 'pebble-relay-worker']) {
      writeBinary(join(releaseDir, name), bytes)
    }
    writeBinary(join(releaseDir, 'bundle/deb/Pebble.deb'), Buffer.from('deb-placeholder'))
    const commandRunner = vi.fn((command, args, _options) => {
      if (command === 'dpkg-deb' && args[0] === '--extract') {
        createBundledRelayWorkerMatrix(args[2])
      }
      return {
        stderr: '',
        stdout:
          command === 'dpkg-deb' && args[2] === 'Depends'
            ? 'at-spi2-core, gir1.2-atspi-2.0, python3, python3-gi\n'
            : 'amd64\n'
      }
    })

    const result = verifyTauriReleaseArtifacts({
      commandRunner,
      desktopDir,
      platform: 'linux',
      targetDir,
      targetTriple
    })

    expect(result).toEqual(
      expect.objectContaining({ platform: 'linux', schemaVersion: 1, targetTriple })
    )
    expect(result.artifacts).toHaveLength(14)
    expect(result.artifacts.map((artifact) => artifact.role).sort()).toEqual([
      'installer',
      'main-executable',
      'prepared-relay-worker',
      'prepared-relay-worker',
      'prepared-relay-worker',
      'prepared-relay-worker',
      'prepared-relay-worker',
      'prepared-relay-worker',
      'prepared-sidecar',
      'prepared-sidecar',
      'prepared-sidecar',
      'staged-sidecar',
      'staged-sidecar',
      'staged-sidecar'
    ])
    expect(commandRunner).toHaveBeenCalledWith('dpkg-deb', [
      '--field',
      join(releaseDir, 'bundle/deb/Pebble.deb'),
      'Architecture'
    ])
    expect(commandRunner).toHaveBeenCalledWith('dpkg-deb', [
      '--extract',
      join(releaseDir, 'bundle/deb/Pebble.deb'),
      expect.stringContaining('pebble-package-resources-')
    ])
    expect(result.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true)
    expect(result.artifacts.some(({ role }) => role.startsWith('updater-'))).toBe(false)
  })

  it('rejects installers missing either native computer-use provider', () => {
    const desktopDir = temporaryDesktop()
    const targetTriple = 'x86_64-unknown-linux-gnu'
    const targetDir = join(desktopDir, 'src-tauri/target')
    const releaseDir = join(targetDir, 'release')
    const bytes = elfBinary(0x3e)
    createPreparedSidecars(desktopDir, targetTriple, bytes)
    for (const name of [
      'pebble-desktop-tauri',
      'pebble-runtime',
      'pebble-control',
      'pebble-relay-worker'
    ]) {
      writeBinary(join(releaseDir, name), bytes)
    }
    writeBinary(join(releaseDir, 'bundle/deb/Pebble.deb'), Buffer.from('deb-placeholder'))

    expect(() =>
      verifyTauriReleaseArtifacts({
        commandRunner: (command, args, _options) => {
          if (command === 'dpkg-deb' && args[0] === '--extract') {
            createBundledRelayWorkerMatrix(args[2])
            rmSync(join(args[2], 'Resources/computer-use-windows/runtime.ps1'))
          }
          return {
            stderr: '',
            stdout:
              command === 'dpkg-deb' && args[2] === 'Depends'
                ? 'at-spi2-core, gir1.2-atspi-2.0, python3, python3-gi\n'
                : 'amd64\n'
          }
        },
        desktopDir,
        platform: 'linux',
        targetDir,
        targetTriple
      })
    ).toThrow(/installed computer-use-windows provider script/)
  })

  it('requires strict nested codesigning and a stapled notarization ticket on macOS', () => {
    const desktopDir = temporaryDesktop()
    const targetTriple = 'universal-apple-darwin'
    const targetDir = join(desktopDir, 'src-tauri/target')
    const appPath = join(targetDir, targetTriple, 'release/bundle/macos/Pebble.app/Contents/MacOS')
    const bytes = universalMachBinary()
    createPreparedSidecars(desktopDir, targetTriple, bytes)
    writeBinary(join(appPath, 'pebble-desktop-tauri'), bytes)
    for (const name of ['pebble-runtime', 'pebble-control', 'pebble-relay-worker']) {
      writeBinary(join(appPath, name), bytes)
    }
    for (const name of ['libonnxruntime.1.17.1.dylib', 'libsherpa-onnx-c-api.dylib']) {
      writeBinary(join(appPath, '../Frameworks', name), bytes)
    }
    createBundledRelayWorkerMatrix(join(appPath, '..'))
    writeBinary(
      join(targetDir, targetTriple, 'release/bundle/dmg/Pebble.dmg'),
      Buffer.from('notarized-dmg')
    )
    createUpdaterArtifact(join(targetDir, targetTriple, 'release'))
    const commandRunner = vi.fn((command, args) => {
      if (command === 'codesign' && args.includes('--entitlements')) {
        return {
          stderr: [
            '<plist><dict>',
            '<key>com.apple.security.automation.apple-events</key><true/>',
            '<key>com.apple.security.device.audio-input</key><true/>',
            '<key>com.apple.security.device.bluetooth</key><true/>',
            '<key>com.apple.security.device.camera</key><true/>',
            '<key>com.apple.security.device.usb</key><true/>',
            '<key>com.apple.security.personal-information.location</key><true/>',
            '<key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>',
            '<key>com.apple.security.cs.allow-jit</key><true/>',
            '<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>',
            '</dict></plist>'
          ].join(''),
          stdout: ''
        }
      }
      if (command === 'codesign' && args.includes('--display')) {
        return {
          stderr: [
            'Authority=Developer ID Application: Pebble Test (TESTTEAM)',
            'TeamIdentifier=TESTTEAM',
            'flags=0x10000(runtime)'
          ].join('\n'),
          stdout: ''
        }
      }
      return { stderr: '', stdout: '' }
    })

    const result = verifyTauriReleaseArtifacts({
      commandRunner,
      desktopDir,
      expectedAppleTeamId: 'TESTTEAM',
      platform: 'macos',
      targetDir,
      targetTriple
    })

    expect(commandRunner).toHaveBeenCalledTimes(26)
    expect(commandRunner).toHaveBeenCalledWith(
      'codesign',
      expect.arrayContaining(['--verify', '--strict', '--deep'])
    )
    expect(commandRunner).toHaveBeenCalledWith('xcrun', [
      'stapler',
      'validate',
      join(appPath, '..', '..')
    ])
    expect(commandRunner).toHaveBeenCalledWith(process.execPath, [
      '-e',
      expect.stringContaining("child.once('exit'"),
      join(appPath, 'pebble-desktop-tauri'),
      '3'
    ])
    expect(result.artifacts).toHaveLength(28)
    expect(
      result.artifacts.filter((artifact) => artifact.role === 'bundled-relay-worker')
    ).toHaveLength(6)
    expect(
      result.artifacts.filter((artifact) => artifact.role === 'bundled-native-library')
    ).toHaveLength(2)
    expect(
      result.artifacts.filter((artifact) => artifact.role === 'bundled-computer-use-provider')
    ).toHaveLength(2)
    expect(
      result.artifacts.filter((artifact) => artifact.role === 'bundled-emulator-helper')
    ).toHaveLength(1)
    expect(
      result.artifacts.filter((artifact) => artifact.role === 'bundled-computer-use-helper')
    ).toHaveLength(1)
    expect(
      result.artifacts.find((artifact) => artifact.role === 'bundled-computer-use-helper').checks
    ).toContain('entitlements')
    expect(result.artifacts.find((artifact) => artifact.role === 'main-executable').checks).toEqual(
      [
        'architecture',
        'codesign-developer-id',
        'codesign-strict',
        'dyld-launch',
        'entitlements',
        'hardened-runtime',
        'notarization-stapled'
      ]
    )
  })

  it('requires Authenticode on the Windows app, sidecars, and every installer', () => {
    const desktopDir = temporaryDesktop()
    const targetTriple = 'x86_64-pc-windows-msvc'
    const targetDir = join(desktopDir, 'src-tauri/target')
    const releaseDir = join(targetDir, 'release')
    const bytes = peBinary(0x8664)
    createPreparedSidecars(desktopDir, targetTriple, bytes)
    for (const name of [
      'pebble-desktop-tauri',
      'pebble-runtime',
      'pebble-control',
      'pebble-relay-worker'
    ]) {
      writeBinary(join(releaseDir, `${name}.exe`), bytes)
    }
    writeBinary(join(releaseDir, 'bundle/nsis/Pebble-setup.exe'), bytes)
    writeBinary(join(releaseDir, 'bundle/msi/Pebble.msi'), Buffer.from('msi-placeholder'))
    createUpdaterArtifact(releaseDir, 'Pebble.nsis.zip')
    const windowsSignatureVerifier = vi.fn()
    const commandRunner = vi.fn((command, args) => {
      if (command === 'msiexec') {
        createBundledRelayWorkerMatrix(args.at(-1).slice('TARGETDIR='.length))
      }
      if (command.endsWith('Pebble-setup.exe')) {
        createBundledRelayWorkerMatrix(args.at(-1).slice('/D='.length))
      }
      return { stderr: '', stdout: '' }
    })

    const result = verifyTauriReleaseArtifacts({
      commandRunner,
      desktopDir,
      platform: 'windows',
      targetDir,
      targetTriple,
      windowsSignatureVerifier
    })

    expect(windowsSignatureVerifier).toHaveBeenCalledTimes(6)
    expect(commandRunner).toHaveBeenCalledWith(
      'msiexec',
      expect.arrayContaining(['/a', join(releaseDir, 'bundle/msi/Pebble.msi'), '/qn'])
    )
    expect(commandRunner).toHaveBeenCalledWith(join(releaseDir, 'bundle/nsis/Pebble-setup.exe'), [
      '/S',
      expect.stringContaining('/D=')
    ])
    expect(result.artifacts.filter((artifact) => artifact.role === 'installer')).toHaveLength(2)
    expect(
      result.artifacts
        .filter((artifact) =>
          ['installer', 'main-executable', 'staged-sidecar'].includes(artifact.role)
        )
        .every((artifact) => artifact.checks.includes('authenticode-valid'))
    ).toBe(true)
  })

  it('fails before writing evidence when native signature inspection fails', () => {
    const desktopDir = temporaryDesktop()
    const targetTriple = 'x86_64-pc-windows-msvc'
    const targetDir = join(desktopDir, 'src-tauri/target')
    const releaseDir = join(targetDir, 'release')
    const bytes = peBinary(0x8664)
    createPreparedSidecars(desktopDir, targetTriple, bytes)
    for (const name of [
      'pebble-desktop-tauri',
      'pebble-runtime',
      'pebble-control',
      'pebble-relay-worker'
    ]) {
      writeBinary(join(releaseDir, `${name}.exe`), bytes)
    }
    writeBinary(join(releaseDir, 'bundle/nsis/Pebble-setup.exe'), bytes)
    writeBinary(join(releaseDir, 'bundle/msi/Pebble.msi'), Buffer.from('msi-placeholder'))
    createUpdaterArtifact(releaseDir, 'Pebble.nsis.zip')

    expect(() =>
      verifyTauriReleaseArtifacts({
        desktopDir,
        platform: 'windows',
        targetDir,
        targetTriple,
        windowsSignatureVerifier: () => {
          throw new Error('signature status is NotSigned')
        }
      })
    ).toThrow(/NotSigned/)
  })

  it('requires both Windows NSIS and MSI installer formats', () => {
    const desktopDir = temporaryDesktop()
    const targetTriple = 'x86_64-pc-windows-msvc'
    const targetDir = join(desktopDir, 'src-tauri/target')
    const releaseDir = join(targetDir, 'release')
    const bytes = peBinary(0x8664)
    createPreparedSidecars(desktopDir, targetTriple, bytes)
    for (const name of [
      'pebble-desktop-tauri',
      'pebble-runtime',
      'pebble-control',
      'pebble-relay-worker'
    ]) {
      writeBinary(join(releaseDir, `${name}.exe`), bytes)
    }
    writeBinary(join(releaseDir, 'bundle/nsis/Pebble-setup.exe'), bytes)
    createUpdaterArtifact(releaseDir, 'Pebble.nsis.zip')

    expect(() =>
      verifyTauriReleaseArtifacts({
        desktopDir,
        platform: 'windows',
        targetDir,
        targetTriple,
        windowsSignatureVerifier: vi.fn()
      })
    ).toThrow(/Windows MSI installer/)
  })

  it('rejects release bundles without a signed updater payload', () => {
    const desktopDir = temporaryDesktop()
    const targetTriple = 'x86_64-pc-windows-msvc'
    const targetDir = join(desktopDir, 'src-tauri/target')
    const releaseDir = join(targetDir, 'release')
    const bytes = peBinary(0x8664)
    createPreparedSidecars(desktopDir, targetTriple, bytes)
    for (const name of [
      'pebble-desktop-tauri',
      'pebble-runtime',
      'pebble-control',
      'pebble-relay-worker'
    ]) {
      writeBinary(join(releaseDir, `${name}.exe`), bytes)
    }
    writeBinary(join(releaseDir, 'bundle/nsis/Pebble-setup.exe'), bytes)
    writeBinary(join(releaseDir, 'bundle/msi/Pebble.msi'), Buffer.from('msi-placeholder'))

    expect(() =>
      verifyTauriReleaseArtifacts({
        commandRunner: (command, args) => {
          if (command === 'msiexec') {
            createBundledRelayWorkerMatrix(args.at(-1).slice('TARGETDIR='.length))
          }
          if (command.endsWith('Pebble-setup.exe')) {
            createBundledRelayWorkerMatrix(args.at(-1).slice('/D='.length))
          }
          return { stderr: '', stdout: '' }
        },
        desktopDir,
        platform: 'windows',
        targetDir,
        targetTriple,
        windowsSignatureVerifier: vi.fn()
      })
    ).toThrow(/signed Tauri updater artifacts/)
  })

  it('rejects updater payloads that fail cryptographic signature verification', () => {
    const desktopDir = temporaryDesktop()
    const targetTriple = 'x86_64-pc-windows-msvc'
    const targetDir = join(desktopDir, 'src-tauri/target')
    const releaseDir = join(targetDir, 'release')
    const bytes = peBinary(0x8664)
    createPreparedSidecars(desktopDir, targetTriple, bytes)
    for (const name of [
      'pebble-desktop-tauri',
      'pebble-runtime',
      'pebble-control',
      'pebble-relay-worker'
    ]) {
      writeBinary(join(releaseDir, `${name}.exe`), bytes)
    }
    writeBinary(join(releaseDir, 'bundle/nsis/Pebble-setup.exe'), bytes)
    writeBinary(join(releaseDir, 'bundle/msi/Pebble.msi'), Buffer.from('msi-placeholder'))
    createUpdaterArtifact(releaseDir, 'Pebble.nsis.zip')

    expect(() =>
      inspectTauriReleaseArtifacts({
        commandRunner: (command, args) => {
          if (command === 'msiexec') {
            createBundledRelayWorkerMatrix(args.at(-1).slice('TARGETDIR='.length))
          }
          if (command.endsWith('Pebble-setup.exe')) {
            createBundledRelayWorkerMatrix(args.at(-1).slice('/D='.length))
          }
          return { stderr: '', stdout: '' }
        },
        desktopDir,
        platform: 'windows',
        targetDir,
        targetTriple,
        updaterPublicKey: 'production-public-key',
        updaterSignatureVerifier: () => {
          throw new Error('updater signature verification failed')
        },
        windowsSignatureVerifier: vi.fn()
      })
    ).toThrow(/signature verification failed/)
  })
})
