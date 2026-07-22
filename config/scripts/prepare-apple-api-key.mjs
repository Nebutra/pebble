#!/usr/bin/env node

import { appendFileSync, chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function requiredEnvironmentValue(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required to prepare the App Store Connect API key.`)
  }
  return value
}

function requiredAbsolutePath(environment, name) {
  const value = requiredEnvironmentValue(environment, name)
  if (/\r|\n/u.test(value)) {
    throw new Error(`${name} must not contain line breaks.`)
  }
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`)
  }
  return resolve(value)
}

export function prepareAppleApiKey({
  environment = process.env,
  platform = process.platform
} = {}) {
  const privateKey = environment.APPLE_API_KEY_P8
  if (typeof privateKey !== 'string' || privateKey.trim() === '') {
    return { prepared: false }
  }
  if (platform !== 'darwin') {
    throw new Error('APPLE_API_KEY_P8 may only be materialized on a macOS release runner.')
  }

  const runnerTemp = requiredAbsolutePath(environment, 'RUNNER_TEMP')
  const githubEnvironmentPath = requiredAbsolutePath(environment, 'GITHUB_ENV')
  const privateKeyDirectory = mkdtempSync(resolve(runnerTemp, 'pebble-apple-api-key-'))
  const privateKeyPath = resolve(privateKeyDirectory, 'apple-api-key.p8')

  // Why: notarization requires a file path, but the private key must remain an
  // ephemeral runner-only secret that cannot follow a pre-created symlink.
  writeFileSync(privateKeyPath, privateKey, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  chmodSync(privateKeyPath, 0o600)
  appendFileSync(githubEnvironmentPath, `APPLE_API_KEY_PATH=${privateKeyPath}\n`, 'utf8')
  return { prepared: true, privateKeyPath }
}

export function main() {
  const result = prepareAppleApiKey()
  if (result.prepared) {
    console.log('Prepared the App Store Connect API key for notarization.')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
