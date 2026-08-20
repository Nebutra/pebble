// Why: every layer around the terminal has been measured and is fast — 2-4ms
// through the runtime, 0.25ms of renderer work per chunk, under 1ms for xterm to
// parse and paint in WKWebView, 59fps with no dropped frames. The one segment
// with no number is the trip from the runtime reading bytes off the PTY to this
// renderer handing them to a listener. This measures it.
//
// Counted into buckets, never stored, so measuring cannot become the slow thing.

export type LatencySummary = {
  count: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

const BUCKET_UPPER_BOUNDS_MS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, Infinity]

export type LatencyHistogram = {
  record: (durationMs: number) => void
  summarise: () => LatencySummary | null
  reset: () => void
}

export function createLatencyHistogram(): LatencyHistogram {
  let counts = BUCKET_UPPER_BOUNDS_MS.map(() => 0)
  let total = 0
  let max = 0

  const quantile = (fraction: number): number => {
    const target = total * fraction
    let seen = 0
    for (let index = 0; index < counts.length; index += 1) {
      seen += counts[index]!
      if (seen >= target) {
        const bound = BUCKET_UPPER_BOUNDS_MS[index]!
        // The open-ended top bucket has no bound to report, so use the real max.
        return Number.isFinite(bound) ? bound : Math.round(max * 100) / 100
      }
    }
    return Math.round(max * 100) / 100
  }

  return {
    record(durationMs) {
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        return
      }
      const index = BUCKET_UPPER_BOUNDS_MS.findIndex((bound) => durationMs <= bound)
      counts[index === -1 ? BUCKET_UPPER_BOUNDS_MS.length - 1 : index]! += 1
      total += 1
      max = Math.max(max, durationMs)
    },
    summarise() {
      if (total === 0) {
        return null
      }
      return {
        count: total,
        p50Ms: quantile(0.5),
        p95Ms: quantile(0.95),
        maxMs: Math.round(max * 100) / 100
      }
    },
    reset() {
      counts = BUCKET_UPPER_BOUNDS_MS.map(() => 0)
      total = 0
      max = 0
    }
  }
}
