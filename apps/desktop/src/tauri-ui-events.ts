import type { KeybindingActionId } from '../../../packages/product-core/shared/keybindings'

export type TauriEmptyUiEvent =
  | 'openSettings'
  | 'openSetupGuide'
  | 'openFeatureTour'
  | 'openCrashReport'
  | 'toggleLeftSidebar'
  | 'toggleRightSidebar'
  | 'toggleWorktreePalette'
  | 'toggleFloatingTerminal'
  | 'openQuickOpen'
  | 'toggleQuickCommandsMenu'
  | 'openNewWorkspace'
  | 'deleteCurrentWorkspace'
  | 'openWorkspaceBoard'
  | 'openTasks'
  | 'switchRecentTab'
  | 'dictationKeyDown'
  | 'appMenuPaste'

export type TauriIndexedUiEvent = 'jumpToWorktreeIndex' | 'jumpToTabIndex'
export type TauriWorktreeHistoryDirection = 'back' | 'forward'
export type TauriZoomDirection = 'in' | 'out' | 'reset'

const emptyUiEventListeners = new Map<TauriEmptyUiEvent, Set<() => void>>()
const indexedUiEventListeners = new Map<TauriIndexedUiEvent, Set<(index: number) => void>>()
const terminalZoomListeners = new Set<(direction: TauriZoomDirection) => void>()
const terminalShortcutCapturedListeners = new Set<
  (data: { actionId: KeybindingActionId }) => void
>()
const worktreeHistoryNavigateListeners = new Set<
  (direction: TauriWorktreeHistoryDirection) => void
>()

export function subscribeTauriEmptyUiEvent(
  event: TauriEmptyUiEvent
): (callback: () => void) => () => void {
  return (callback) => {
    const listeners = getEmptyUiEventListeners(event)
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  }
}

export function emitTauriEmptyUiEvent(event: TauriEmptyUiEvent): void {
  for (const listener of getEmptyUiEventListeners(event)) {
    listener()
  }
}

export function subscribeTauriIndexedUiEvent(
  event: TauriIndexedUiEvent
): (callback: (index: number) => void) => () => void {
  return (callback) => {
    const listeners = getIndexedUiEventListeners(event)
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  }
}

export function emitTauriIndexedUiEvent(event: TauriIndexedUiEvent, index: number): void {
  for (const listener of getIndexedUiEventListeners(event)) {
    listener(index)
  }
}

export function subscribeTauriTerminalZoom(
  callback: (direction: TauriZoomDirection) => void
): () => void {
  terminalZoomListeners.add(callback)
  return () => {
    terminalZoomListeners.delete(callback)
  }
}

export function emitTauriTerminalZoom(direction: TauriZoomDirection): void {
  for (const listener of terminalZoomListeners) {
    listener(direction)
  }
}

export function subscribeTauriTerminalShortcutCaptured(
  callback: (data: { actionId: KeybindingActionId }) => void
): () => void {
  terminalShortcutCapturedListeners.add(callback)
  return () => {
    terminalShortcutCapturedListeners.delete(callback)
  }
}

export function emitTauriTerminalShortcutCaptured(actionId: KeybindingActionId): void {
  for (const listener of terminalShortcutCapturedListeners) {
    listener({ actionId })
  }
}

export function subscribeTauriWorktreeHistoryNavigate(
  callback: (direction: TauriWorktreeHistoryDirection) => void
): () => void {
  worktreeHistoryNavigateListeners.add(callback)
  return () => {
    worktreeHistoryNavigateListeners.delete(callback)
  }
}

export function emitTauriWorktreeHistoryNavigate(direction: TauriWorktreeHistoryDirection): void {
  for (const listener of worktreeHistoryNavigateListeners) {
    listener(direction)
  }
}

function getEmptyUiEventListeners(event: TauriEmptyUiEvent): Set<() => void> {
  const existing = emptyUiEventListeners.get(event)
  if (existing) {
    return existing
  }
  const created = new Set<() => void>()
  emptyUiEventListeners.set(event, created)
  return created
}

function getIndexedUiEventListeners(event: TauriIndexedUiEvent): Set<(index: number) => void> {
  const existing = indexedUiEventListeners.get(event)
  if (existing) {
    return existing
  }
  const created = new Set<(index: number) => void>()
  indexedUiEventListeners.set(event, created)
  return created
}
