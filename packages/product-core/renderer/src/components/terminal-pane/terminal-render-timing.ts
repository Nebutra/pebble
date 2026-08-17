// Why: with the renderer confirmed to be on WebGL and undowngraded, and the PTY
// round trip measured at 4-5ms, the remaining candidate for slow typing is the
// work the renderer does per output chunk — a stack of scans and store writes
// that runs before anything reaches xterm. Guessing which of them costs is what
// this file exists to stop.
//
// Samples are counted, not stored, so the measurement cannot itself become the
// slow thing it is measuring.

export type RenderTimingPhase = 'chunk' | 'write'

export type RenderTimingSummary = {
  count: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

// Buckets in milliseconds. A histogram keeps this O(1) per sample and bounded in
// memory no matter how much output a session produces.
const BUCKET_UPPER_BOUNDS_MS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, Infinity]

type PhaseState = { counts: number[]; total: number; max: number }

const phases = new Map<RenderTimingPhase, PhaseState>()

function stateFor(phase: RenderTimingPhase): PhaseState {
  const existing = phases.get(phase)
  if (existing) {
    return existing
  }
  const created: PhaseState = { counts: BUCKET_UPPER_BOUNDS_MS.map(() => 0), total: 0, max: 0 }
  phases.set(phase, created)
  return created
}

export function recordRenderTiming(phase: RenderTimingPhase, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return
  }
  const state = stateFor(phase)
  const index = BUCKET_UPPER_BOUNDS_MS.findIndex((bound) => durationMs <= bound)
  state.counts[index === -1 ? BUCKET_UPPER_BOUNDS_MS.length - 1 : index]! += 1
  state.total += 1
  state.max = Math.max(state.max, durationMs)
}

function quantile(state: PhaseState, fraction: number): number {
  const target = state.total * fraction
  let seen = 0
  for (let index = 0; index < state.counts.length; index += 1) {
    seen += state.counts[index]!
    if (seen >= target) {
      const bound = BUCKET_UPPER_BOUNDS_MS[index]!
      // The open-ended top bucket has no bound to report, so use the real max.
      return Number.isFinite(bound) ? bound : state.max
    }
  }
  return state.max
}

export function summariseRenderTiming(phase: RenderTimingPhase): RenderTimingSummary | null {
  const state = phases.get(phase)
  if (!state || state.total === 0) {
    return null
  }
  return {
    count: state.total,
    p50Ms: quantile(state, 0.5),
    p95Ms: quantile(state, 0.95),
    maxMs: Math.round(state.max * 100) / 100
  }
}

export function resetRenderTimingForTests(): void {
  phases.clear()
}
