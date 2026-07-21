import type { RateLimitState } from '../../../packages/product-core/shared/rate-limit-types'
import { requestRuntimeJson } from './pebble-runtime-http-bridge'

let syncQueue: Promise<void> = Promise.resolve()

export function installTauriAccountsSnapshotSync(): void {
  window.api.rateLimits.onUpdate((rateLimits) => {
    queueAccountsSnapshotSync(rateLimits)
  })
  void window.api.rateLimits
    .get()
    .then((rateLimits) => queueAccountsSnapshotSync(rateLimits))
    .catch(() => undefined)
}

export function queueAccountsSnapshotSync(rateLimits?: RateLimitState): Promise<void> {
  const next = syncQueue.then(async () => {
    const [claude, codex, currentRateLimits] = await Promise.all([
      window.api.claudeAccounts.list(),
      window.api.codexAccounts.list(),
      rateLimits ? Promise.resolve(rateLimits) : window.api.rateLimits.get()
    ])
    await requestRuntimeJson('/v1/accounts/snapshot', {
      method: 'PUT',
      timeoutMs: 5000,
      body: { claude, codex, rateLimits: currentRateLimits }
    })
  })
  syncQueue = next.catch(() => undefined)
  return next
}
