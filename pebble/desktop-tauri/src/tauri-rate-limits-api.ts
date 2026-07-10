import type { PreloadApi } from '../../../src/preload/api-types'

// Why: rateLimits reads live usage from each provider's authenticated
// session — OAuth-token refresh, OS Keychain reads, and CLI-shelled fetchers
// for Claude/Codex/Gemini/MiniMax (src/main/rate-limits/service.ts, ~1500
// lines) plus the codexAccounts/claudeAccounts credential store it depends
// on. There is no persisted snapshot to read independently of that
// credential/OAuth machinery, and no Go-runtime home for it (rate limits are
// per-desktop-session, not provider-scoped state the Go runtime owns). Same
// explicit-gap call as tauri-accounts-api.ts: stays on the web preload's
// honest "no providers configured" empty state rather than a half-ported
// fetch path.
type RateLimitsApi = NonNullable<Partial<PreloadApi>['rateLimits']>

export function createPebbleRateLimitsApi(base: RateLimitsApi): RateLimitsApi {
  return { ...base }
}
