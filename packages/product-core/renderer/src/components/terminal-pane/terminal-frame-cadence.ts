// Why: every layer we control measured fast — 4ms through the runtime, 5ms
// through the user's real shell, 0.25ms median for the renderer's own per-chunk
// work, on a pane confirmed to be on WebGL. Ten milliseconds of work cannot feel
// slow, so the delay has to be after the work: frames that are drawn but not
// presented. This measures the cadence the page actually gets.
//
// Sampled in short bursts rather than a standing loop. A permanent
// requestAnimationFrame loop keeps the page animating and defeats idle
// throttling — it would spend real battery to observe a frame rate, and change
// the thing it is observing.

export type FrameCadenceSummary = {
  frames: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

export const FRAME_CADENCE_BURST_FRAMES = 60

type RequestFrame = (callback: (timestamp: number) => void) => void

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0
  }
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  return Math.round(sorted[index]! * 100) / 100
}

/**
 * Records the gaps between consecutive animation frames.
 *
 * A page keeping up returns gaps near the display interval; a page whose frames
 * are queued behind a saturated compositor returns gaps far larger, which is the
 * distinction this exists to make.
 */
export function sampleFrameCadence(
  requestFrame: RequestFrame,
  frames: number = FRAME_CADENCE_BURST_FRAMES
): Promise<FrameCadenceSummary> {
  return new Promise((resolve) => {
    const gaps: number[] = []
    let previous: number | null = null
    let remaining = Math.max(2, frames)

    const step = (timestamp: number): void => {
      if (previous !== null) {
        gaps.push(timestamp - previous)
      }
      previous = timestamp
      remaining -= 1
      if (remaining > 0) {
        requestFrame(step)
        return
      }
      const sorted = [...gaps].sort((a, b) => a - b)
      resolve({
        frames: gaps.length,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted.length > 0 ? Math.round(sorted.at(-1)! * 100) / 100 : 0
      })
    }

    requestFrame(step)
  })
}

export function browserRequestFrame(callback: (timestamp: number) => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(callback)
    return
  }
  // Why: a host without rAF still has to settle the promise, or the report that
  // awaits it would never be written.
  setTimeout(() => callback(Date.now()), 16)
}
