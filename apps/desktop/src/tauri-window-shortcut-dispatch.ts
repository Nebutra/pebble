import type { WindowShortcutAction } from '../../../packages/product-core/shared/window-shortcut-policy'
import {
  emitTauriEmptyUiEvent,
  emitTauriIndexedUiEvent,
  emitTauriTerminalZoom,
  emitTauriWorktreeHistoryNavigate
} from './tauri-ui-events'
import { reloadTauriWebview } from './tauri-webview-reload'

// Maps a resolved window shortcut action to its renderer UI event; split out of
// tauri-window-shortcut-bridge.ts so the capture-phase bridge stays focused.
export function sendTauriWindowShortcutAction(action: WindowShortcutAction): void {
  switch (action.type) {
    case 'zoom':
      emitTauriTerminalZoom(action.direction)
      return
    case 'openSettings':
      emitTauriEmptyUiEvent('openSettings')
      return
    case 'forceReload':
      reloadTauriWebview(true)
      return
    case 'toggleWorktreePalette':
      emitTauriEmptyUiEvent('toggleWorktreePalette')
      return
    case 'toggleFloatingTerminal':
      emitTauriEmptyUiEvent('toggleFloatingTerminal')
      return
    case 'toggleLeftSidebar':
      emitTauriEmptyUiEvent('toggleLeftSidebar')
      return
    case 'toggleRightSidebar':
      emitTauriEmptyUiEvent('toggleRightSidebar')
      return
    case 'openQuickOpen':
      emitTauriEmptyUiEvent('openQuickOpen')
      return
    case 'toggleQuickCommandsMenu':
      emitTauriEmptyUiEvent('toggleQuickCommandsMenu')
      return
    case 'openNewWorkspace':
      emitTauriEmptyUiEvent('openNewWorkspace')
      return
    case 'deleteCurrentWorkspace':
      emitTauriEmptyUiEvent('deleteCurrentWorkspace')
      return
    case 'openWorkspaceBoard':
      emitTauriEmptyUiEvent('openWorkspaceBoard')
      return
    case 'openTasks':
      emitTauriEmptyUiEvent('openTasks')
      return
    case 'switchRecentTab':
      emitTauriEmptyUiEvent('switchRecentTab')
      return
    case 'jumpToWorktreeIndex':
      emitTauriIndexedUiEvent('jumpToWorktreeIndex', action.index)
      return
    case 'jumpToTabIndex':
      emitTauriIndexedUiEvent('jumpToTabIndex', action.index)
      return
    case 'worktreeHistoryNavigate':
      emitTauriWorktreeHistoryNavigate(action.direction)
      return
    case 'dictationKeyDown':
      emitTauriEmptyUiEvent('dictationKeyDown')
  }
}
