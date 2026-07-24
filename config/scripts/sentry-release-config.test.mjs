import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'

import {
  resolveNativeSentryReleaseDirectory,
  resolveSentryReleaseConfig,
  verifyObservabilityReleaseConfig
} from './sentry-release-config.mjs'
import { redactSentryCliOutput } from './sentry-cli-process.mjs'

const configured = {
  PEBBLE_BUILD_IDENTITY: 'rc',
  PEBBLE_SENTRY_DSN: 'https://public@example.invalid/1',
  PEBBLE_SENTRY_DIST: 'rc-aarch64-apple-darwin',
  SENTRY_AUTH_TOKEN: 'secret',
  SENTRY_ORG: 'nebutra',
  SENTRY_PROJECT: 'pebble-desktop'
}

describe('Sentry release configuration', () => {
  it('keeps local and unconfigured builds as no-ops', () => {
    expect(resolveSentryReleaseConfig({ env: {}, version: '1.2.3' })).toBeNull()
    expect(
      resolveSentryReleaseConfig({
        env: { ...configured, PEBBLE_BUILD_IDENTITY: 'dev' },
        version: '1.2.3'
      })
    ).toBeNull()
  })

  it('uses one release and distribution contract across artifact types', () => {
    expect(
      resolveSentryReleaseConfig({
        env: configured,
        version: '1.2.3',
        targetTriple: 'aarch64-apple-darwin'
      })
    ).toEqual({
      release: 'pebble@1.2.3',
      dist: 'rc-aarch64-apple-darwin',
      org: 'nebutra',
      project: 'pebble-desktop'
    })
  })

  it('fails without printing secret values when configured credentials are incomplete', () => {
    expect(() =>
      resolveSentryReleaseConfig({
        env: { ...configured, SENTRY_AUTH_TOKEN: '', SENTRY_PROJECT: '' },
        version: '1.2.3'
      })
    ).toThrow('SENTRY_AUTH_TOKEN, SENTRY_PROJECT')
  })

  it('rejects a distribution that does not match the target triple', () => {
    expect(() =>
      resolveSentryReleaseConfig({
        env: configured,
        version: '1.2.3',
        targetTriple: 'x86_64-pc-windows-msvc'
      })
    ).toThrow('does not match the release target triple')
  })

  it('rejects malformed DSNs without including their value', () => {
    expect(() =>
      resolveSentryReleaseConfig({
        env: { ...configured, PEBBLE_SENTRY_DSN: 'not-a-dsn' },
        version: '1.2.3'
      })
    ).toThrow('PEBBLE_SENTRY_DSN is invalid')
  })

  it('requires both vendors before a stable or RC release', () => {
    expect(() =>
      verifyObservabilityReleaseConfig({
        env: { ...configured, PEBBLE_POSTHOG_WRITE_KEY: '' },
        version: '1.2.3',
        targetTriple: 'aarch64-apple-darwin'
      })
    ).toThrow('PEBBLE_POSTHOG_WRITE_KEY')
    expect(
      verifyObservabilityReleaseConfig({
        env: { ...configured, PEBBLE_POSTHOG_WRITE_KEY: 'phc_public' },
        version: '1.2.3',
        targetTriple: 'aarch64-apple-darwin'
      }).release
    ).toBe('pebble@1.2.3')
  })

  it('keeps native debug uploads inside the explicit Cargo target directory', () => {
    const repoRoot = resolve('test-repo')
    expect(
      resolveNativeSentryReleaseDirectory({
        repoRoot,
        targetReleaseDir: 'universal-apple-darwin/release'
      })
    ).toBe(
      resolve(repoRoot, 'apps/desktop/src-tauri/target/universal-apple-darwin/release')
    )
    for (const targetReleaseDir of ['../release', '/tmp/release', 'C:\\temp\\release', '']) {
      expect(() =>
        resolveNativeSentryReleaseDirectory({ repoRoot, targetReleaseDir })
      ).toThrow('safe relative path')
    }
  })

  it('redacts every release credential from Sentry CLI failures', () => {
    const env = {
      SENTRY_AUTH_TOKEN: 'auth-secret',
      PEBBLE_SENTRY_DSN: 'https://public@example.invalid/1',
      PEBBLE_POSTHOG_WRITE_KEY: 'phc_public_secret'
    }
    const output = redactSentryCliOutput(
      `${env.SENTRY_AUTH_TOKEN} ${env.PEBBLE_SENTRY_DSN} ${env.PEBBLE_POSTHOG_WRITE_KEY}`,
      env
    )
    expect(output).toBe('<redacted> <redacted> <redacted>')
  })
})
