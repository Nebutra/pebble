import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { prepareAppleApiKey } from './prepare-apple-api-key.mjs'

const temporaryDirectories = []

function temporaryEnvironment(overrides = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'pebble-apple-api-key-'))
  temporaryDirectories.push(directory)
  const githubEnvironmentPath = resolve(directory, 'github-env')
  writeFileSync(githubEnvironmentPath, '', 'utf8')
  return {
    APPLE_API_KEY_P8: '-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----\n',
    GITHUB_ENV: githubEnvironmentPath,
    RUNNER_TEMP: directory,
    ...overrides
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('App Store Connect API key preparation', () => {
  it('writes newline-preserving P8 contents only under runner temp with owner-only permissions', () => {
    const environment = temporaryEnvironment()
    const result = prepareAppleApiKey({ environment, platform: 'darwin' })

    expect(result.prepared).toBe(true)
    expect(readFileSync(result.privateKeyPath, 'utf8')).toBe(environment.APPLE_API_KEY_P8)
    expect(statSync(result.privateKeyPath).mode & 0o777).toBe(0o600)
    const pathWithinRunnerTemp = relative(environment.RUNNER_TEMP, result.privateKeyPath)
    expect(isAbsolute(pathWithinRunnerTemp)).toBe(false)
    expect(pathWithinRunnerTemp.startsWith('..')).toBe(false)
    const githubEnvironment = readFileSync(environment.GITHUB_ENV, 'utf8')
    expect(githubEnvironment).toBe(`APPLE_API_KEY_PATH=${result.privateKeyPath}\n`)
    expect(githubEnvironment).not.toContain('test-only')
  })

  it('does nothing when the API-key secret is absent so Apple ID fallback remains available', () => {
    const environment = temporaryEnvironment({ APPLE_API_KEY_P8: '' })

    expect(prepareAppleApiKey({ environment, platform: 'darwin' })).toEqual({ prepared: false })
    expect(readFileSync(environment.GITHUB_ENV, 'utf8')).toBe('')
  })

  it('rejects materialization outside macOS', () => {
    expect(() =>
      prepareAppleApiKey({ environment: temporaryEnvironment(), platform: 'linux' })
    ).toThrow(/macOS release runner/)
  })

  it('requires both runner-managed path variables before writing the key', () => {
    expect(() =>
      prepareAppleApiKey({
        environment: { APPLE_API_KEY_P8: 'test-private-key' },
        platform: 'darwin'
      })
    ).toThrow('RUNNER_TEMP')
    expect(() =>
      prepareAppleApiKey({
        environment: {
          APPLE_API_KEY_P8: 'test-private-key',
          RUNNER_TEMP: temporaryEnvironment().RUNNER_TEMP
        },
        platform: 'darwin'
      })
    ).toThrow('GITHUB_ENV')
  })

  it('rejects relative or line-broken runner paths before writing the key', () => {
    const environment = temporaryEnvironment()
    expect(() =>
      prepareAppleApiKey({
        environment: { ...environment, RUNNER_TEMP: 'relative-runner-temp' },
        platform: 'darwin'
      })
    ).toThrow(/RUNNER_TEMP must be an absolute path/)
    expect(() =>
      prepareAppleApiKey({
        environment: { ...environment, RUNNER_TEMP: `${environment.RUNNER_TEMP}\nINJECTED=1` },
        platform: 'darwin'
      })
    ).toThrow(/RUNNER_TEMP must not contain line breaks/)
    expect(() =>
      prepareAppleApiKey({
        environment: { ...environment, GITHUB_ENV: `${environment.GITHUB_ENV}\nINJECTED=1` },
        platform: 'darwin'
      })
    ).toThrow(/GITHUB_ENV must not contain line breaks/)
  })
})
