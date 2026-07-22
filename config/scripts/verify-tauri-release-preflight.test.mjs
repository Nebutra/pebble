import { describe, expect, it } from 'vitest'

import {
  validateMacosReleaseEnvironment,
  validateMacosPlatformConfig,
  validateReleasePreflight,
  validateTauriReleaseConfig,
  validateWindowsReleaseConfig
} from './verify-tauri-release-preflight.mjs'

function releaseConfig(overrides = {}) {
  return {
    build: {
      beforeBuildCommand: 'node scripts/prepare-go-sidecars.mjs && npm run build'
    },
    bundle: {
      createUpdaterArtifacts: true,
      externalBin: [
        'binaries/pebble-runtime',
        'binaries/pebble-control',
        'binaries/pebble-relay-worker'
      ],
      macOS: {
        entitlements: '../../../resources/build/entitlements.mac.plist',
        hardenedRuntime: true
      }
    },
    plugins: {
      updater: {
        endpoints: ['https://example.test/latest.json'],
        pubkey: 'UlNJRzAxRkFLRVBST0RVQ1RJT05LRVkxMjM0NTY3ODkw'
      }
    },
    ...overrides
  }
}

const fakeMacosEnvironment = {
  APPLE_CERTIFICATE: 'test-certificate',
  APPLE_CERTIFICATE_PASSWORD: 'test-certificate-password',
  APPLE_ID: 'release@example.test',
  APPLE_PASSWORD: 'test-app-password',
  APPLE_TEAM_ID: 'TESTTEAM',
  PEBBLE_MAC_RELEASE: '1',
  TAURI_SIGNING_PRIVATE_KEY: 'private-key-material',
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'private-key-password',
  TAURI_UPDATER_PUBLIC_KEY: 'UlNJRzAxRkFLRVBST0RVQ1RJT05LRVkxMjM0NTY3ODkw'
}

const fakeUpdaterEnvironment = {
  TAURI_SIGNING_PRIVATE_KEY: 'private-key-material',
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'private-key-password',
  TAURI_UPDATER_PUBLIC_KEY: 'UlNJRzAxRkFLRVBST0RVQ1RJT05LRVkxMjM0NTY3ODkw'
}

const macosPlatformConfig = {
  build: { beforeBundleCommand: 'node scripts/prepare-macos-bundle-resources.mjs' },
  bundle: {
    resources: {
      '../../../native/computer-use-macos/.build/release/Pebble Computer Use.app':
        'Pebble Computer Use.app'
    }
  }
}

const windowsReleaseConfig = {
  certificateThumbprint: 'A'.repeat(40),
  digestAlgorithm: 'sha256',
  timestampUrl: 'http://timestamp.digicert.com'
}

describe('Tauri release preflight', () => {
  it('accepts the exact target-qualified sidecar contract', () => {
    expect(() => validateTauriReleaseConfig(releaseConfig())).not.toThrow()
  })

  it('rejects missing, extra, or unprepared sidecars', () => {
    expect(() =>
      validateTauriReleaseConfig(
        releaseConfig({
          bundle: {
            externalBin: ['binaries/pebble-runtime'],
            macOS: { hardenedRuntime: true }
          }
        })
      )
    ).toThrow(/exactly/)

    expect(() =>
      validateTauriReleaseConfig(
        releaseConfig({
          build: { beforeBuildCommand: 'npm run build' }
        })
      )
    ).toThrow(/prepare target-qualified/)
  })

  it('requires hardened runtime and forbids ad-hoc release signing', () => {
    expect(() =>
      validateTauriReleaseConfig(
        releaseConfig({
          bundle: {
            externalBin: [
              'binaries/pebble-runtime',
              'binaries/pebble-control',
              'binaries/pebble-relay-worker'
            ],
            macOS: {
              entitlements: '../../../resources/build/entitlements.mac.plist',
              hardenedRuntime: false
            }
          }
        })
      )
    ).toThrow(/hardened runtime/)

    expect(() =>
      validateTauriReleaseConfig(
        releaseConfig({
          bundle: {
            externalBin: [
              'binaries/pebble-runtime',
              'binaries/pebble-control',
              'binaries/pebble-relay-worker'
            ],
            macOS: {
              entitlements: '../../../resources/build/entitlements.mac.plist',
              hardenedRuntime: true,
              signingIdentity: '-'
            }
          }
        })
      )
    ).toThrow(/ad-hoc/)
  })

  it('reports every missing macOS credential without reading real secrets', () => {
    expect(() => validateMacosReleaseEnvironment({ APPLE_ID: 'release@example.test' })).toThrow(
      'APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_PASSWORD, APPLE_TEAM_ID'
    )
    expect(() => validateMacosReleaseEnvironment(fakeMacosEnvironment)).not.toThrow()
    expect(() =>
      validateMacosReleaseEnvironment({ ...fakeMacosEnvironment, PEBBLE_MAC_RELEASE: '' })
    ).toThrow(/PEBBLE_MAC_RELEASE/)
  })

  it('requires macOS pre-bundle helper staging and the repository entitlements', () => {
    expect(() => validateMacosPlatformConfig(macosPlatformConfig)).not.toThrow()
    expect(() => validateMacosPlatformConfig({ build: {}, bundle: {} })).toThrow(
      /prepare signed platform resources/
    )
    expect(() =>
      validateTauriReleaseConfig(
        releaseConfig({
          bundle: {
            ...releaseConfig().bundle,
            macOS: { hardenedRuntime: true }
          }
        })
      )
    ).toThrow(/repository-owned main entitlements/)
  })

  it('only requires Apple credentials for the macOS release leg', () => {
    expect(
      validateReleasePreflight({
        platform: 'linux',
        environment: fakeUpdaterEnvironment,
        config: releaseConfig()
      })
    ).toEqual(
      expect.objectContaining({
        platform: 'linux',
        externalBinaries: [
          'binaries/pebble-control',
          'binaries/pebble-relay-worker',
          'binaries/pebble-runtime'
        ]
      })
    )
    expect(() =>
      validateReleasePreflight({
        platform: 'windows',
        environment: fakeUpdaterEnvironment,
        config: releaseConfig({
          bundle: {
            externalBin: [
              'binaries/pebble-runtime',
              'binaries/pebble-control',
              'binaries/pebble-relay-worker'
            ],
            createUpdaterArtifacts: true,
            macOS: {
              entitlements: '../../../resources/build/entitlements.mac.plist',
              hardenedRuntime: true
            },
            windows: windowsReleaseConfig
          }
        })
      })
    ).not.toThrow()
    expect(() =>
      validateReleasePreflight({
        platform: 'macos',
        environment: fakeUpdaterEnvironment,
        config: releaseConfig(),
        macosConfig: macosPlatformConfig
      })
    ).toThrow(/Missing macOS/)
  })

  it('requires an imported Windows code-signing identity and timestamp metadata', () => {
    expect(() =>
      validateWindowsReleaseConfig({ bundle: { windows: windowsReleaseConfig } })
    ).not.toThrow()
    expect(() => validateWindowsReleaseConfig({ bundle: { windows: {} } })).toThrow(/thumbprint/)
    expect(() =>
      validateWindowsReleaseConfig({
        bundle: { windows: { ...windowsReleaseConfig, digestAlgorithm: 'sha1' } }
      })
    ).toThrow(/SHA-256/)
  })

  it('rejects unknown platform names', () => {
    expect(() =>
      validateReleasePreflight({
        platform: 'darwin',
        environment: fakeUpdaterEnvironment,
        config: releaseConfig()
      })
    ).toThrow(/Unsupported/)
  })
})
