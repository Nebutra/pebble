import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const defaultConfigPath = resolve(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json')
const rootPackagePath = resolve(repoRoot, 'package.json')
const placeholderPublicKey =
  'UlNJRzAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA='

export function validateUpdaterPublicKey(value) {
  const publicKey = value?.trim() ?? ''
  if (!publicKey || publicKey === placeholderPublicKey || isPlaceholderSigningValue(publicKey)) {
    throw new Error('TAURI_UPDATER_PUBLIC_KEY must contain the production updater public key.')
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(publicKey)) {
    throw new Error('TAURI_UPDATER_PUBLIC_KEY must be base64 encoded.')
  }
  return publicKey
}

export function validateSigningPrivateKey(value) {
  if (!value?.trim() || isPlaceholderSigningValue(value)) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY must be configured for release packaging.')
  }
}

export function validateSigningPrivateKeyPassword(value) {
  if (!value?.trim() || isPlaceholderSigningValue(value)) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY_PASSWORD must be configured for release packaging.')
  }
}

export function validateUpdaterSigningEnvironment(environment) {
  const validators = [
    ['TAURI_UPDATER_PUBLIC_KEY', validateUpdaterPublicKey],
    ['TAURI_SIGNING_PRIVATE_KEY', validateSigningPrivateKey],
    ['TAURI_SIGNING_PRIVATE_KEY_PASSWORD', validateSigningPrivateKeyPassword]
  ]
  const invalid = validators
    .filter(([name, validate]) => {
      try {
        validate(environment[name])
        return false
      } catch {
        return true
      }
    })
    .map(([name]) => name)
  if (invalid.length > 0) {
    throw new Error(
      `Missing or placeholder Tauri updater signing environment: ${invalid.join(', ')}.`
    )
  }
  return { publicKey: validateUpdaterPublicKey(environment.TAURI_UPDATER_PUBLIC_KEY) }
}

function isPlaceholderSigningValue(value) {
  return new Set([
    'changeme',
    'example',
    'not-configured',
    'placeholder',
    'replace-me',
    'todo'
  ]).has(value.trim().toLowerCase())
}

export function validateReleaseVersion(value) {
  const version = value?.trim().replace(/^v/i, '') ?? ''
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('TAURI_RELEASE_VERSION must be a valid semver release version.')
  }
  return version
}

export function applyReleaseUpdaterConfig(config, publicKey, version, options = {}) {
  const updater = config.plugins?.updater
  if (!updater || !Array.isArray(updater.endpoints) || updater.endpoints.length === 0) {
    throw new Error('Tauri updater endpoints must be configured before release packaging.')
  }
  const next = {
    ...config,
    version,
    bundle: {
      ...config.bundle,
      createUpdaterArtifacts: true
    },
    plugins: {
      ...config.plugins,
      updater: {
        ...updater,
        pubkey: publicKey
      }
    }
  }
  if (options.platform === 'windows') {
    const certificateThumbprint = options.windowsCertificateThumbprint?.trim() ?? ''
    if (!/^[A-Fa-f0-9]{40,64}$/.test(certificateThumbprint)) {
      throw new Error('TAURI_WINDOWS_CERTIFICATE_THUMBPRINT must be a certificate thumbprint.')
    }
    next.bundle.windows = {
      ...next.bundle.windows,
      certificateThumbprint,
      digestAlgorithm: 'sha256',
      timestampUrl: 'http://timestamp.digicert.com'
    }
  }
  return next
}

export async function prepareTauriReleaseConfig({
  configPath,
  platform,
  publicKey,
  version,
  windowsCertificateThumbprint
}) {
  const source = JSON.parse(await readFile(configPath, 'utf8'))
  const next = applyReleaseUpdaterConfig(
    source,
    validateUpdaterPublicKey(publicKey),
    validateReleaseVersion(version),
    { platform, windowsCertificateThumbprint }
  )
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}

if (process.argv[1] === import.meta.filename) {
  const signingEnvironment = validateUpdaterSigningEnvironment(process.env)
  const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8'))
  await prepareTauriReleaseConfig({
    configPath: resolve(process.env.TAURI_CONFIG_PATH || defaultConfigPath),
    platform: process.env.TAURI_RELEASE_PLATFORM,
    publicKey: signingEnvironment.publicKey,
    version: process.env.TAURI_RELEASE_VERSION || rootPackage.version,
    windowsCertificateThumbprint: process.env.TAURI_WINDOWS_CERTIFICATE_THUMBPRINT
  })
}
