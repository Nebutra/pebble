import type { PaneManager } from './pane-manager'
import type { PaneRenderingDiagnostics } from './pane-manager-types'

// Why: PaneManager.getRenderingDiagnostics() has existed with no callers, so in
// a release build nothing could report which renderer a terminal actually ended
// up on. DevTools are compiled out of release, the webview console is not
// forwarded to stdout, and breadcrumbs only reach disk during a crash — so a
// pane silently downgraded to xterm's DOM renderer was invisible to everyone,
// including whoever was trying to explain why typing felt slow. This lets the
// settings surface read that state without threading a ref through the tree.

let activePaneManager: PaneManager | null = null

export function registerActivePaneManager(manager: PaneManager): void {
  activePaneManager = manager
}

export function unregisterActivePaneManager(manager: PaneManager): void {
  // Why: panes are rebuilt on worktree switches, and a late teardown must not
  // clear a registration a newer manager already replaced.
  if (activePaneManager === manager) {
    activePaneManager = null
  }
}

export function readTerminalRenderingDiagnostics(): PaneRenderingDiagnostics[] {
  try {
    return activePaneManager?.getRenderingDiagnostics() ?? []
  } catch {
    // A diagnostic read must never take the settings page down with it.
    return []
  }
}

export type TerminalRendererSummary = {
  paneCount: number
  webglPaneCount: number
  /** Set when at least one pane is on DOM because its WebGL context was lost. */
  downgradedByContextLoss: boolean
  /** The reason "auto" gave, so a DOM pane on a supported platform stands out. */
  autoDecisionReason: string | null
}

export function summariseTerminalRenderers(
  diagnostics: readonly PaneRenderingDiagnostics[]
): TerminalRendererSummary {
  return {
    paneCount: diagnostics.length,
    webglPaneCount: diagnostics.filter((pane) => pane.hasWebgl).length,
    downgradedByContextLoss: diagnostics.some(
      (pane) => pane.webglDisabledAfterContextLoss && !pane.hasWebgl
    ),
    autoDecisionReason: diagnostics[0]?.terminalWebglAutoDecision.reason ?? null
  }
}
