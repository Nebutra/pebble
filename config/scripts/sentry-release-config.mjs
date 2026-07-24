import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path'

const RELEASE_CHANNELS = new Set(['stable', 'rc'])

export function resolveSentryReleaseConfig({ env, version, targetTriple }) {
  const channel = env.PEBBLE_BUILD_IDENTITY?.trim()
  const dsn = env.PEBBLE_SENTRY_DSN?.trim()
  if (!dsn || !RELEASE_CHANNELS.has(channel)) {
    return null
  }
  validateSentryDsn(dsn)

  const required = ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT', 'PEBBLE_SENTRY_DIST']
  const missing = required.filter((name) => !env[name]?.trim())
  if (missing.length) {
    throw new Error(`Sentry release configuration is missing: ${missing.join(', ')}`)
  }

  const dist = env.PEBBLE_SENTRY_DIST.trim()
  if (!dist.startsWith(`${channel}-`)) {
    throw new Error('PEBBLE_SENTRY_DIST must begin with the release channel.')
  }
  if (targetTriple && dist !== `${channel}-${targetTriple}`) {
    throw new Error('PEBBLE_SENTRY_DIST does not match the release target triple.')
  }

  return {
    release: `pebble@${version}`,
    dist,
    org: env.SENTRY_ORG.trim(),
    project: env.SENTRY_PROJECT.trim()
  }
}

export function verifyObservabilityReleaseConfig({ env, version, targetTriple }) {
  const required = ['PEBBLE_POSTHOG_WRITE_KEY', 'PEBBLE_SENTRY_DSN']
  const missing = required.filter((name) => !env[name]?.trim())
  if (missing.length) {
    throw new Error(`Observability release configuration is missing: ${missing.join(', ')}`)
  }
  const config = resolveSentryReleaseConfig({ env, version, targetTriple })
  if (!config) {
    throw new Error('PEBBLE_BUILD_IDENTITY must be stable or rc for an observability release.')
  }
  return config
}

export function resolveNativeSentryReleaseDirectory({ repoRoot, targetReleaseDir }) {
  const value = targetReleaseDir?.trim()
  if (!value || isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error('TAURI_RELEASE_TARGET_RELEASE_DIR must be a safe relative path.')
  }
  const targetRoot = resolve(repoRoot, 'apps/desktop/src-tauri/target')
  const releaseDir = resolve(targetRoot, value)
  const contained = relative(targetRoot, releaseDir)
  if (
    !contained ||
    contained === '..' ||
    contained.startsWith(`..${sep}`) ||
    isAbsolute(contained)
  ) {
    throw new Error('TAURI_RELEASE_TARGET_RELEASE_DIR must be a safe relative path.')
  }
  return releaseDir
}

function validateSentryDsn(dsn) {
  let parsed
  try {
    parsed = new URL(dsn)
  } catch {
    throw new Error('PEBBLE_SENTRY_DSN is invalid.')
  }
  if (parsed.protocol !== 'https:' || !parsed.username || !/^\/\d+\/?$/.test(parsed.pathname)) {
    throw new Error('PEBBLE_SENTRY_DSN is invalid.')
  }
}
