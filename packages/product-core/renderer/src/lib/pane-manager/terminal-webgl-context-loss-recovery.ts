// Why: a lost WebGL context used to pin a pane to the DOM renderer for the rest
// of the session. Nothing cleared the latch except the user changing the GPU
// setting by hand — the reattach path checks it too, so the "next rendering
// resume retries it" the renderer comments promise never happened. One transient
// hiccup under GPU pressure therefore left a terminal permanently on xterm's
// slowest renderer, which reads as typing that starts fine and then stays laggy.
//
// Recovering unconditionally is not the answer either: recreating the context
// immediately can loop the loss and leave xterm blank. Recover a bounded number
// of times, each after a cool-off, then stay on DOM for good.

export const WEBGL_CONTEXT_LOSS_RECOVERY_ATTEMPTS = 2

export const WEBGL_CONTEXT_LOSS_COOL_OFF_MS = 60_000

export type WebglContextLossState = {
  /** How many times this pane has lost its context since the last clean attach. */
  contextLossCount: number
  /** When the most recent loss happened, or null if it has never lost one. */
  lastContextLossAt: number | null
}

/**
 * Reports whether a pane pinned to DOM by a context loss may try WebGL again.
 *
 * A pane that has spent its attempts stays on DOM, so a display that genuinely
 * cannot hold a context is not asked repeatedly.
 */
export function canRecoverWebglAfterContextLoss(
  state: WebglContextLossState,
  now: number
): boolean {
  if (state.contextLossCount <= 0) {
    return true
  }
  if (state.contextLossCount > WEBGL_CONTEXT_LOSS_RECOVERY_ATTEMPTS) {
    return false
  }
  if (state.lastContextLossAt === null) {
    return true
  }
  return now - state.lastContextLossAt >= WEBGL_CONTEXT_LOSS_COOL_OFF_MS
}

/** Records a loss, moving the pane one step closer to staying on DOM for good. */
export function recordWebglContextLoss(
  state: WebglContextLossState,
  now: number
): WebglContextLossState {
  return { contextLossCount: state.contextLossCount + 1, lastContextLossAt: now }
}

/**
 * Clears the history once a context has held.
 *
 * Why: without this, losses accumulate across an entire session and a pane that
 * ran happily for hours between two unrelated hiccups would be treated as one
 * that cannot hold a context at all.
 */
export function forgetWebglContextLosses(): WebglContextLossState {
  return { contextLossCount: 0, lastContextLossAt: null }
}
