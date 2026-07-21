import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '../..')
const defaultConfigPath = resolve(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json')
const supportedPlatforms = new Set(['linux', 'macos', 'windows'])
const requiredExternalBinaries = ['binaries/pebble-relay-worker', 'binaries/pebble-runtime']

function missingEnvironmentVariables(environment, names) {
  return names.filter((name) => {
    const value = environment[name]
    return typeof value !== 'string' || value.trim() === ''
  })
}

export function validateTauriReleaseConfig(config) {
  const externalBinaries = config?.bundle?.externalBin
  if (!Array.isArray(externalBinaries)) {
    throw new Error('Tauri release config must declare bundle.externalBin.')
  }

  const actual = [...externalBinaries].sort()
  if (JSON.stringify(actual) !== JSON.stringify(requiredExternalBinaries)) {
    throw new Error(
      `Tauri release external binaries must be exactly: ${requiredExternalBinaries.join(', ')}.`
    )
  }

  const beforeBuildCommand = config?.build?.beforeBuildCommand
  if (
    typeof beforeBuildCommand !== 'string' ||
    !beforeBuildCommand.includes('scripts/prepare-go-sidecars.mjs')
  ) {
    throw new Error('Tauri release build must prepare target-qualified Go sidecars.')
  }

  if (config?.bundle?.macOS?.hardenedRuntime !== true) {
    throw new Error('Tauri macOS release config must explicitly enable hardened runtime.')
  }

  if (config?.bundle?.macOS?.signingIdentity === '-') {
    throw new Error('Tauri release config must not use an ad-hoc macOS signing identity.')
  }
}

export function validateMacosReleaseEnvironment(environment) {
  const required = [
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_TEAM_ID'
  ]
  const missing = missingEnvironmentVariables(environment, required)
  if (missing.length > 0) {
    throw new Error(`Missing macOS signing/notarization environment: ${missing.join(', ')}.`)
  }
}

export function validateWindowsReleaseConfig(config) {
  const windows = config?.bundle?.windows
  if (!/^[A-Fa-f0-9]{40,64}$/.test(windows?.certificateThumbprint ?? '')) {
    throw new Error('Windows release config must contain an imported certificate thumbprint.')
  }
  if (windows.digestAlgorithm !== 'sha256') {
    throw new Error('Windows release config must use SHA-256 Authenticode digests.')
  }
  if (!/^https?:\/\//u.test(windows.timestampUrl ?? '')) {
    throw new Error('Windows release config must define an Authenticode timestamp URL.')
  }
}

export function validateReleasePreflight({ platform, environment = process.env, config }) {
  if (!supportedPlatforms.has(platform)) {
    throw new Error(`Unsupported Tauri release platform: ${platform || '<missing>'}.`)
  }

  validateTauriReleaseConfig(config)
  if (platform === 'macos') {
    validateMacosReleaseEnvironment(environment)
  } else if (platform === 'windows') {
    validateWindowsReleaseConfig(config)
  }

  return { platform, externalBinaries: [...requiredExternalBinaries] }
}

export function main(argv = process.argv.slice(2), environment = process.env) {
  const platform = argv[0]
  const configPath = resolve(argv[1] || defaultConfigPath)
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const result = validateReleasePreflight({ platform, environment, config })
  console.log(
    `Verified ${result.platform} Tauri release preflight with ${result.externalBinaries.length} sidecars.`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
