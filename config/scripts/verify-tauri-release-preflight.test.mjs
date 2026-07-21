import { describe, expect, it } from 'vitest'

import {
  validateMacosReleaseEnvironment,
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
      externalBin: ['binaries/pebble-runtime', 'binaries/pebble-relay-worker'],
      macOS: {
        hardenedRuntime: true
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
  APPLE_TEAM_ID: 'TESTTEAM'
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
            externalBin: ['binaries/pebble-runtime', 'binaries/pebble-relay-worker'],
            macOS: { hardenedRuntime: false }
          }
        })
      )
    ).toThrow(/hardened runtime/)

    expect(() =>
      validateTauriReleaseConfig(
        releaseConfig({
          bundle: {
            externalBin: ['binaries/pebble-runtime', 'binaries/pebble-relay-worker'],
            macOS: { hardenedRuntime: true, signingIdentity: '-' }
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
  })

  it('only requires Apple credentials for the macOS release leg', () => {
    expect(
      validateReleasePreflight({ platform: 'linux', environment: {}, config: releaseConfig() })
    ).toEqual(
      expect.objectContaining({
        platform: 'linux',
        externalBinaries: ['binaries/pebble-relay-worker', 'binaries/pebble-runtime']
      })
    )
    expect(() =>
      validateReleasePreflight({
        platform: 'windows',
        environment: {},
        config: releaseConfig({
          bundle: {
            externalBin: ['binaries/pebble-runtime', 'binaries/pebble-relay-worker'],
            macOS: { hardenedRuntime: true },
            windows: windowsReleaseConfig
          }
        })
      })
    ).not.toThrow()
    expect(() =>
      validateReleasePreflight({ platform: 'macos', environment: {}, config: releaseConfig() })
    ).toThrow(/Missing macOS/)
  })

  it('requires an imported Windows code-signing identity and timestamp metadata', () => {
    expect(() => validateWindowsReleaseConfig({ bundle: { windows: windowsReleaseConfig } })).not.toThrow()
    expect(() => validateWindowsReleaseConfig({ bundle: { windows: {} } })).toThrow(/thumbprint/)
    expect(() =>
      validateWindowsReleaseConfig({
        bundle: { windows: { ...windowsReleaseConfig, digestAlgorithm: 'sha1' } }
      })
    ).toThrow(/SHA-256/)
  })

  it('rejects unknown platform names', () => {
    expect(() =>
      validateReleasePreflight({ platform: 'darwin', environment: {}, config: releaseConfig() })
    ).toThrow(/Unsupported/)
  })
})
