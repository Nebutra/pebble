type RegisteredPaneManager = {
  resetWebglTextureAtlases(): void
  fitAllPanes?: () => void
  refreshAllPanes?: () => void
  /** When false, heavy atlas reset/repaint is deferred until the surface is revealed. */
  isVisibleForAtlasRecovery?: () => boolean
}

const liveManagers = new Set<RegisteredPaneManager>()

export function registerLivePaneManager(manager: RegisteredPaneManager): void {
  liveManagers.add(manager)
}

export function unregisterLivePaneManager(manager: RegisteredPaneManager): void {
  liveManagers.delete(manager)
}

function managersEligibleForAtlasRecovery(): RegisteredPaneManager[] {
  // Why (#66 / Orca #12061): a global fanout over dozens of hidden worktree
  // managers multiplies CPU/heap on ordinary fullscreen/visibility returns.
  // Managers that opt in with isVisibleForAtlasRecovery === false are skipped;
  // missing the hook keeps legacy "reset everyone" behavior.
  return Array.from(liveManagers).filter(
    (manager) => manager.isVisibleForAtlasRecovery?.() !== false
  )
}

/**
 * Resets the WebGL glyph atlases of live pane managers eligible for recovery.
 *
 * Why: @xterm/addon-webgl keeps a module-global atlas cache, so terminals with
 * identical font configs share one glyph texture atlas. Clearing it through a
 * single manager invalidates the cached glyph coordinates of every other
 * sharing terminal without rebuilding their render models, which paints them
 * as garbled glyphs. Recovery resets must therefore rebuild all *visible*
 * terminals — hidden surfaces take the heavy path on reveal instead.
 */
export function resetAllTerminalWebglAtlases(): void {
  for (const manager of managersEligibleForAtlasRecovery()) {
    try {
      manager.resetWebglTextureAtlases()
    } catch {
      // Why: stale WebGL recovery is best-effort during pane teardown; one
      // disposed manager should not prevent sibling terminals from repainting.
    }
  }
}

export function resetAndRefreshAllTerminalWebglAtlases(): void {
  const recoveryManagers = managersEligibleForAtlasRecovery()
  const resetManagers: RegisteredPaneManager[] = []
  for (const manager of recoveryManagers) {
    try {
      manager.resetWebglTextureAtlases()
      resetManagers.push(manager)
    } catch {
      // Why: recovery is best-effort during pane teardown; a disposed manager
      // should not block sibling terminals from rebuilding and repainting.
    }
  }
  for (const manager of resetManagers) {
    try {
      manager.refreshAllPanes?.()
    } catch {
      // Why: a pane can unmount between atlas reset and repaint; later
      // managers still need to repaint from their xterm buffers.
    }
  }
}

export function refitAndRefreshAllTerminalPanes(): void {
  for (const manager of liveManagers) {
    try {
      // Why: after bulk desktop restore, background panes may have correct
      // cols/rows but a stale xterm renderer until focus forces a repaint.
      manager.fitAllPanes?.()
      manager.refreshAllPanes?.()
    } catch {
      // Why: restore-all is best-effort across live managers during teardown.
    }
  }
}
