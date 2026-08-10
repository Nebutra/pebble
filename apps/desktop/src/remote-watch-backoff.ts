/// First retry waits a second; the cap stops a long outage from spinning.
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000
/// Beyond this the doubling only overflows; the cap already applies.
const RETRY_MAX_ATTEMPT = 30

// Why: every remote watcher retries on its own timer, so a host that stays down
// fanned out one reconnect per watched target every fixed interval — over SSH
// each of those is a process spawn. Capped exponential backoff bounds that to
// one attempt per watcher per 30s while still recovering a 10s outage quickly.
export function remoteWatchRetryDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) {
    return RETRY_BASE_MS
  }
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(attempt, RETRY_MAX_ATTEMPT), RETRY_MAX_MS)
}
