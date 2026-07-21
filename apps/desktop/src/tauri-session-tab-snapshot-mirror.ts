import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../packages/product-core/shared/runtime-types'
import {
  rehydrateSessionTabViewState,
  scheduleSessionTabViewStateSave,
  type RuntimeSessionTabViewState
} from './tauri-session-tab-view-state-persistence'
import {
  type RuntimeSession,
  publicationEpoch,
  sessionTabId,
  terminalTitle
} from './tauri-session-tabs-rpc-value-readers'
import { buildSessionTabGroups, resolveTopLevelTabId } from './tauri-session-tab-group-layout'

const sessionTabViewStateByWorktree = new Map<string, RuntimeSessionTabViewState>()
// Memoized per worktree so the runtime snapshot is fetched once; the resolved
// promise stays as a "already rehydrated" marker for later calls.
const sessionTabRehydrationByWorktree = new Map<string, Promise<void>>()

export function clearTauriSessionTabViewStateForTests(): void {
  sessionTabViewStateByWorktree.clear()
  sessionTabRehydrationByWorktree.clear()
}

// Why: the mirror's tab/group/pane state is module memory only; seeding it from
// the runtime's persisted snapshot on first access is what keeps tab layouts
// from resetting on every window reload or runtime restart.
export function ensureSessionTabViewStateRehydrated(worktreeId: string): Promise<void> {
  const existing = sessionTabRehydrationByWorktree.get(worktreeId)
  if (existing) {
    return existing
  }
  const rehydration = rehydrateSessionTabViewState(worktreeId, getSessionTabViewState(worktreeId))
  sessionTabRehydrationByWorktree.set(worktreeId, rehydration)
  return rehydration
}

// Why: every mutating RPC schedules a debounced snapshot write so the layout a
// user just arranged survives the next reload; the persistence module owns the
// debounce/serialization against /v1/session-tab-layouts/{worktreeId}.
export function persistSessionTabViewState(worktreeId: string): void {
  scheduleSessionTabViewStateSave(worktreeId, getSessionTabViewState(worktreeId))
}

export function sessionTabsSnapshot(
  worktreeId: string,
  sessions: RuntimeSession[],
  preferredTabId?: string
): RuntimeMobileSessionTabsResult {
  const liveSessions = sessions.filter((session) => session.status !== 'stopped')
  const state = getSessionTabViewState(worktreeId)
  const rawTabs = liveSessions.map((session) => mapSessionToTerminalTab(session, false))
  pruneSessionTabViewState(
    worktreeId,
    rawTabs.map((tab) => tab.parentTabId)
  )
  const activeTopLevelId =
    resolveTopLevelTabId(rawTabs, preferredTabId ?? null) ??
    resolveTopLevelTabId(rawTabs, state.activeTabId ?? null) ??
    rawTabs.at(-1)?.parentTabId ??
    null
  const activeSession =
    liveSessions.find((session) => sessionTabId(session) === activeTopLevelId) ?? null
  const activeTabId = activeSession ? sessionTabId(activeSession) : activeTopLevelId
  const tabs = rawTabs.map((tab) => applySessionTabViewState(tab, state, activeTopLevelId))
  const { activeGroupId, tabGroups, tabGroupLayout } = buildSessionTabGroups(
    tabs,
    state,
    activeTopLevelId
  )
  return {
    worktree: worktreeId,
    publicationEpoch: publicationEpoch(),
    snapshotVersion: Math.max(Date.now(), state.snapshotVersion),
    activeGroupId,
    activeTabId,
    activeTabType: activeTabId ? 'terminal' : null,
    tabGroups,
    tabGroupLayout,
    tabs
  }
}

export function mapSessionToTerminalTab(
  session: RuntimeSession,
  isActive: boolean
): RuntimeMobileSessionTerminalClientTab {
  const tabId = sessionTabId(session)
  const leafId = session.leafId || tabId
  return {
    type: 'terminal',
    id: leafId,
    title: terminalTitle(session),
    parentTabId: tabId,
    leafId,
    ptyId: session.id,
    terminal: session.id,
    status: 'ready',
    startupCwd: session.cwd,
    isActive
  }
}

export function getSessionTabViewState(worktreeId: string): RuntimeSessionTabViewState {
  const existing = sessionTabViewStateByWorktree.get(worktreeId)
  if (existing) {
    return existing
  }
  const created: RuntimeSessionTabViewState = {
    tabPropsByTabId: new Map(),
    paneLayoutByTabId: new Map(),
    snapshotVersion: Date.now()
  }
  sessionTabViewStateByWorktree.set(worktreeId, created)
  return created
}

function pruneSessionTabViewState(worktreeId: string, liveTopLevelTabIds: string[]): void {
  const state = getSessionTabViewState(worktreeId)
  const live = new Set(liveTopLevelTabIds)
  for (const tabId of state.tabPropsByTabId.keys()) {
    if (!live.has(tabId)) {
      state.tabPropsByTabId.delete(tabId)
    }
  }
  for (const tabId of state.paneLayoutByTabId.keys()) {
    if (!live.has(tabId)) {
      state.paneLayoutByTabId.delete(tabId)
    }
  }
  if (state.tabGroups) {
    state.tabGroups = state.tabGroups
      .map((group) => ({
        ...group,
        tabOrder: group.tabOrder.filter((tabId) => live.has(tabId)),
        recentTabIds: group.recentTabIds?.filter((tabId) => live.has(tabId))
      }))
      .filter((group) => group.tabOrder.length > 0)
  }
}

function applySessionTabViewState(
  tab: RuntimeMobileSessionTerminalClientTab,
  state: RuntimeSessionTabViewState,
  activeTopLevelId: string | null
): RuntimeMobileSessionTerminalClientTab {
  const props = state.tabPropsByTabId.get(tab.parentTabId)
  const paneLayout = state.paneLayoutByTabId.get(tab.parentTabId)
  return {
    ...tab,
    ...(props?.color !== undefined ? { color: props.color } : {}),
    ...(props?.customTitle !== undefined ? { customTitle: props.customTitle } : {}),
    ...(props?.isPinned !== undefined ? { isPinned: props.isPinned } : {}),
    ...(props?.viewMode !== undefined ? { viewMode: props.viewMode } : {}),
    ...(paneLayout
      ? {
          parentLayout: {
            root: paneLayout.root,
            activeLeafId: tab.leafId,
            expandedLeafId: paneLayout.expandedLeafId,
            ...(paneLayout.titlesByLeafId ? { titlesByLeafId: paneLayout.titlesByLeafId } : {})
          }
        }
      : {}),
    isActive: tab.parentTabId === activeTopLevelId || tab.id === activeTopLevelId
  }
}

export { pruneSessionTabViewState }

export type { RuntimeMobileSessionClientTab }
