const TOKEN_STORAGE_KEY = 'pebble.local-runtime.bearer-token'

function createLocalRuntimeBearerToken(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('Secure random UUID support is required for the local runtime.')
  }
  return `${globalThis.crypto.randomUUID()}${globalThis.crypto.randomUUID()}`.replaceAll('-', '')
}

function readOrCreateLocalRuntimeBearerToken(): string {
  try {
    // Why: Tauri can host launch and primary WebViews in separate browsing
    // sessions. Origin storage keeps their managed-runtime credential unified.
    const existing = globalThis.localStorage?.getItem(TOKEN_STORAGE_KEY)
    if (existing && /^[a-f0-9]{64}$/.test(existing)) {
      return existing
    }
    const created = createLocalRuntimeBearerToken()
    globalThis.localStorage?.setItem(TOKEN_STORAGE_KEY, created)
    return created
  } catch {
    return createLocalRuntimeBearerToken()
  }
}

// The token stays inside the trusted local renderer origin and runtime child environment.
export const LOCAL_RUNTIME_BEARER_TOKEN = readOrCreateLocalRuntimeBearerToken()
