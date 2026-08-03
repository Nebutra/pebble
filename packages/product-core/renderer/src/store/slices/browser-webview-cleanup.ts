import type { BrowserPage, BrowserWorkspace } from '../../../../shared/types'
import {
  getExplicitBrowserPageZoomLevel,
  rememberExplicitBrowserPageZoomLevel
} from '../../components/browser-pane/browser-page-zoom'
import {
  destroyPersistentWebview,
  moveFocusToRendererBeforeFocusedWebviewHidden
} from '../../components/browser-pane/webview-registry'

export { moveFocusToRendererBeforeFocusedWebviewHidden }

export function destroyRemovedBrowserWebview(browserPageId: string): void {
  destroyPersistentWebview(browserPageId)
}

export function collectBrowserWebviewIds(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>,
  browserPagesByWorkspace: Record<string, BrowserPage[]>
): Set<string> {
  const ids = new Set<string>()
  for (const pages of Object.values(browserPagesByWorkspace)) {
    for (const page of pages) {
      ids.add(page.id)
    }
  }

  for (const tabs of Object.values(browserTabsByWorktree)) {
    for (const tab of tabs) {
      if ((browserPagesByWorkspace[tab.id] ?? []).length === 0) {
        ids.add(tab.id)
      }
    }
  }
  return ids
}

// Why: guest-budget eviction destroys every guest a hidden worktree retains
// while its tabs/pages stay in the store, so a revisit rebuilds from state.
// Eviction is not a user close — re-remember zoom past the destroy-path forget
// (#68 / Orca #12194).
export function destroyWorktreeBrowserGuests(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>,
  browserPagesByWorkspace: Record<string, BrowserPage[]>,
  worktreeId: string
): void {
  for (const tab of browserTabsByWorktree[worktreeId] ?? []) {
    const pages = browserPagesByWorkspace[tab.id] ?? []
    const guestIds = pages.length === 0 ? [tab.id] : pages.map((page) => page.id)
    for (const guestId of guestIds) {
      const explicitZoomLevel = getExplicitBrowserPageZoomLevel(guestId)
      destroyRemovedBrowserWebview(guestId)
      if (explicitZoomLevel !== null) {
        rememberExplicitBrowserPageZoomLevel(guestId, explicitZoomLevel)
      }
    }
  }
}

export function destroyWorkspaceWebviews(
  browserPagesByWorkspace: Record<string, BrowserPage[]>,
  workspaceId: string
): void {
  const pages = browserPagesByWorkspace[workspaceId] ?? []
  if (pages.length === 0) {
    // Why: legacy sessions persisted before pages existed still key their
    // webview by workspace id. Preserve the legacy destroy as a fallback.
    destroyRemovedBrowserWebview(workspaceId)
    return
  }
  for (const page of pages) {
    destroyRemovedBrowserWebview(page.id)
  }
}
