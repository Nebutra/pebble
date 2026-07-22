import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  validateUpdaterPublicKey,
  validateUpdaterSigningEnvironment
} from './prepare-tauri-release-config.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')
const defaultConfigPath = resolve(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json')
const defaultMacosConfigPath = resolve(repoRoot, 'apps/desktop/src-tauri/tauri.macos.conf.json')
const supportedPlatforms = new Set(['linux', 'macos', 'windows'])
const requiredExternalBinaries = [
  'binaries/pebble-control',
  'binaries/pebble-relay-worker',
  'binaries/pebble-runtime'
]
const macosSigningEnvironment = ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_TEAM_ID']
const appleApiNotarizationEnvironment = ['APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH']
const appleIdNotarizationEnvironment = ['APPLE_ID', 'APPLE_PASSWORD']
const appleApiIssuerUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function hasEnvironmentVariable(environment, name) {
  const value = environment[name]
  return typeof value === 'string' && value.trim() !== ''
}

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

  if (config?.bundle?.macOS?.entitlements !== '../../../resources/build/entitlements.mac.plist') {
    throw new Error('Tauri macOS release config must use the repository-owned main entitlements.')
  }
  if (config?.bundle?.createUpdaterArtifacts !== true) {
    throw new Error('Tauri release config must enable signed updater artifacts.')
  }
  if (
    !Array.isArray(config?.plugins?.updater?.endpoints) ||
    config.plugins.updater.endpoints.length === 0
  ) {
    throw new Error('Tauri release config must retain updater endpoints.')
  }
  validateUpdaterPublicKey(config?.plugins?.updater?.pubkey)
}

export function validateMacosPlatformConfig(config) {
  if (config?.build?.beforeBundleCommand !== 'node scripts/prepare-macos-bundle-resources.mjs') {
    throw new Error('Tauri macOS bundling must prepare signed platform resources before sealing.')
  }
  const helperSource = '../../../native/computer-use-macos/.build/release/Pebble Computer Use.app'
  if (config?.bundle?.resources?.[helperSource] !== 'Pebble Computer Use.app') {
    throw new Error('Tauri macOS bundling must include the signed computer-use helper app.')
  }
}

export function validateMacosReleaseEnvironment(environment) {
  const missing = missingEnvironmentVariables(environment, macosSigningEnvironment)
  if (missing.length > 0) {
    throw new Error(`Missing macOS signing environment: ${missing.join(', ')}.`)
  }

  const apiValues = appleApiNotarizationEnvironment.filter((name) =>
    hasEnvironmentVariable(environment, name)
  )
  const appleIdValues = appleIdNotarizationEnvironment.filter((name) =>
    hasEnvironmentVariable(environment, name)
  )
  // Why: Tauri must receive one unambiguous notarytool authentication mode;
  // accepting mixed secrets can silently select credentials maintainers did not intend.
  if (apiValues.length > 0 && appleIdValues.length > 0) {
    throw new Error(
      `Mixed macOS notarization modes are not allowed: ${[
        ...appleApiNotarizationEnvironment,
        ...appleIdNotarizationEnvironment
      ].join(', ')}.`
    )
  }
  if (apiValues.length > 0) {
    const missingApiValues = missingEnvironmentVariables(
      environment,
      appleApiNotarizationEnvironment
    )
    if (missingApiValues.length > 0) {
      throw new Error(
        `Incomplete App Store Connect API-key notarization environment; missing: ${missingApiValues.join(', ')}.`
      )
    }
    if (!appleApiIssuerUuidPattern.test(environment.APPLE_API_ISSUER.trim())) {
      throw new Error('APPLE_API_ISSUER must be a UUID for App Store Connect notarization.')
    }
    const apiKeyPath = environment.APPLE_API_KEY_PATH.trim()
    if (/\r|\n/u.test(apiKeyPath) || !isAbsolute(apiKeyPath)) {
      throw new Error('APPLE_API_KEY_PATH must be an absolute path without line breaks.')
    }
  } else if (appleIdValues.length > 0) {
    const missingAppleIdValues = missingEnvironmentVariables(
      environment,
      appleIdNotarizationEnvironment
    )
    if (missingAppleIdValues.length > 0) {
      throw new Error(
        `Incomplete Apple ID notarization environment; missing: ${missingAppleIdValues.join(', ')}.`
      )
    }
  } else {
    throw new Error(
      `Missing macOS notarization environment; provide either ${appleApiNotarizationEnvironment.join(', ')} or ${appleIdNotarizationEnvironment.join(', ')}.`
    )
  }
  if (environment.PEBBLE_MAC_RELEASE !== '1') {
    throw new Error('PEBBLE_MAC_RELEASE must be 1 for hardened-runtime helper signing.')
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

export function validateReleasePreflight({
  platform,
  environment = process.env,
  config,
  macosConfig
}) {
  if (!supportedPlatforms.has(platform)) {
    throw new Error(`Unsupported Tauri release platform: ${platform || '<missing>'}.`)
  }

  validateTauriReleaseConfig(config)
  const signingEnvironment = validateUpdaterSigningEnvironment(environment)
  // Why: release config preparation may inject only the public trust root;
  // preflight proves it is the same key supplied to the signing workflow.
  if (config.plugins.updater.pubkey !== signingEnvironment.publicKey) {
    throw new Error(
      'Tauri release config updater public key does not match the signing environment.'
    )
  }
  if (platform === 'macos') {
    validateMacosReleaseEnvironment(environment)
    validateMacosPlatformConfig(macosConfig)
  } else if (platform === 'windows') {
    validateWindowsReleaseConfig(config)
  }

  return { platform, externalBinaries: [...requiredExternalBinaries] }
}

export function main(argv = process.argv.slice(2), environment = process.env) {
  const platform = argv[0]
  const configPath = resolve(argv[1] || defaultConfigPath)
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const macosConfig =
    platform === 'macos' ? JSON.parse(readFileSync(defaultMacosConfigPath, 'utf8')) : undefined
  const result = validateReleasePreflight({ platform, environment, config, macosConfig })
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
