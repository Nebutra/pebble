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

const fakeMacosSigningEnvironment = {
  APPLE_CERTIFICATE: 'test-certificate',
  APPLE_CERTIFICATE_PASSWORD: 'test-certificate-password',
  APPLE_TEAM_ID: 'TESTTEAM',
  PEBBLE_MAC_RELEASE: '1',
  TAURI_SIGNING_PRIVATE_KEY: 'private-key-material',
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'private-key-password',
  TAURI_UPDATER_PUBLIC_KEY: 'UlNJRzAxRkFLRVBST0RVQ1RJT05LRVkxMjM0NTY3ODkw'
}

const fakeAppleIdEnvironment = {
  ...fakeMacosSigningEnvironment,
  APPLE_ID: 'release@example.test',
  APPLE_PASSWORD: 'test-app-password'
}

const fakeAppleApiEnvironment = {
  ...fakeMacosSigningEnvironment,
  APPLE_API_KEY: 'TESTKEY123',
  APPLE_API_ISSUER: '12345678-1234-4abc-8abc-1234567890ab',
  APPLE_API_KEY_PATH: '/runner/temp/apple-api-key.p8'
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

  it('requires certificate and team credentials for either notarization mode', () => {
    expect(() =>
      validateMacosReleaseEnvironment({
        APPLE_API_KEY: 'TESTKEY123',
        APPLE_API_ISSUER: 'test-issuer',
        APPLE_API_KEY_PATH: '/runner/temp/apple-api-key.p8'
      })
    ).toThrow('APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_TEAM_ID')
    expect(() => validateMacosReleaseEnvironment(fakeAppleIdEnvironment)).not.toThrow()
    expect(() => validateMacosReleaseEnvironment(fakeAppleApiEnvironment)).not.toThrow()
    expect(() =>
      validateMacosReleaseEnvironment({ ...fakeAppleApiEnvironment, PEBBLE_MAC_RELEASE: '' })
    ).toThrow(/PEBBLE_MAC_RELEASE/)
  })

  it('rejects missing and partial notarization modes while naming only environment keys', () => {
    expect(() => validateMacosReleaseEnvironment(fakeMacosSigningEnvironment)).toThrow(
      'APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH or APPLE_ID, APPLE_PASSWORD'
    )
    expect(() =>
      validateMacosReleaseEnvironment({
        ...fakeMacosSigningEnvironment,
        APPLE_API_KEY: 'TESTKEY123'
      })
    ).toThrow('APPLE_API_ISSUER, APPLE_API_KEY_PATH')
    expect(() =>
      validateMacosReleaseEnvironment({
        ...fakeMacosSigningEnvironment,
        APPLE_ID: 'release@example.test'
      })
    ).toThrow('APPLE_PASSWORD')
  })

  it('rejects complete or partial mixtures of API-key and Apple ID notarization modes', () => {
    expect(() =>
      validateMacosReleaseEnvironment({
        ...fakeAppleApiEnvironment,
        APPLE_ID: 'release@example.test',
        APPLE_PASSWORD: 'test-app-password'
      })
    ).toThrow(/Mixed macOS notarization modes/)
    expect(() =>
      validateMacosReleaseEnvironment({
        ...fakeAppleIdEnvironment,
        APPLE_API_KEY: 'TESTKEY123'
      })
    ).toThrow(/Mixed macOS notarization modes/)
    let error
    try {
      validateMacosReleaseEnvironment({
        ...fakeAppleIdEnvironment,
        APPLE_API_KEY: 'private-key-value-that-must-not-appear'
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(error.message).not.toContain('private-key-value-that-must-not-appear')
  })

  it('does not accept blank values as a complete notarization mode', () => {
    expect(() =>
      validateMacosReleaseEnvironment({ ...fakeAppleApiEnvironment, APPLE_API_ISSUER: '  ' })
    ).toThrow('APPLE_API_ISSUER')
    expect(() =>
      validateMacosReleaseEnvironment({ ...fakeAppleIdEnvironment, APPLE_PASSWORD: '' })
    ).toThrow('APPLE_PASSWORD')
  })

  it('requires a UUID issuer and a safe absolute API-key path without printing values', () => {
    const invalidIssuer = 'issuer-value-that-must-not-appear'
    expect(() =>
      validateMacosReleaseEnvironment({
        ...fakeAppleApiEnvironment,
        APPLE_API_ISSUER: invalidIssuer
      })
    ).toThrow('APPLE_API_ISSUER must be a UUID')
    try {
      validateMacosReleaseEnvironment({
        ...fakeAppleApiEnvironment,
        APPLE_API_ISSUER: invalidIssuer
      })
    } catch (error) {
      expect(error.message).not.toContain(invalidIssuer)
    }
    expect(() =>
      validateMacosReleaseEnvironment({
        ...fakeAppleApiEnvironment,
        APPLE_API_KEY_PATH: 'relative/apple-api-key.p8'
      })
    ).toThrow('APPLE_API_KEY_PATH must be an absolute path')
    expect(() =>
      validateMacosReleaseEnvironment({
        ...fakeAppleApiEnvironment,
        APPLE_API_KEY_PATH: '/runner/temp/apple-api-key.p8\nINJECTED=1'
      })
    ).toThrow('APPLE_API_KEY_PATH must be an absolute path without line breaks')
  })

  it('keeps Apple credentials scoped to the macOS release leg', () => {
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
        environment: fakeAppleApiEnvironment,
        config: releaseConfig(),
        macosConfig: macosPlatformConfig
      })
    ).not.toThrow()
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
