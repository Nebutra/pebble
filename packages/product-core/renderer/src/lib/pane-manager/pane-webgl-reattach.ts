import type { ManagedPaneInternal } from './pane-manager-types'
import { attachWebgl, clearTerminalWebglAttachBackoff, disposeWebgl } from './pane-webgl-renderer'
import { canRecoverWebglAfterContextLoss } from './terminal-webgl-context-loss-recovery'

// Why: this is the path the renderer's own comment promised would retry after a
// context loss — but it also checked the latch, so it never did. Ask the policy
// instead: a pane whose cool-off has passed and whose attempts are not spent
// gets WebGL back, rather than staying on xterm's slowest renderer all session.
function mayAttachWebglAfterContextLoss(pane: ManagedPaneInternal): boolean {
  if (!pane.webglDisabledAfterContextLoss) {
    return true
  }
  return canRecoverWebglAfterContextLoss(
    {
      contextLossCount: pane.webglContextLossCount ?? 0,
      lastContextLossAt: pane.webglLastContextLossAt ?? null
    },
    Date.now()
  )
}

export function reattachWebglIfNeeded(pane: ManagedPaneInternal): void {
  if (pane.gpuRenderingEnabled && !pane.webglAddon && mayAttachWebglAfterContextLoss(pane)) {
    attachWebgl(pane)
  }
}

export function rebuildAttachedWebgl(pane: ManagedPaneInternal): void {
  if (!pane.webglAddon || pane.webglDisabledAfterContextLoss) {
    return
  }
  disposeWebgl(pane)
  // Why: the live addon just proved context creation works, so a stale attach
  // backoff from an earlier failure must not downgrade this pane to DOM.
  clearTerminalWebglAttachBackoff()
  attachWebgl(pane)
}
