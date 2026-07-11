import type { RuntimeMobileSessionTabGroup } from '../../../src/shared/runtime-types'
import type { TabGroupLayoutNode, TerminalPaneLayoutNode } from '../../../src/shared/types'
import {
  loadSessionTabLayout,
  scheduleSessionTabLayoutSave,
  type SessionTabLayoutSnapshot
} from './tauri-session-tab-layout-persistence'

// Serialization boundary between the session-tab mirror's in-memory view state
// (tauri-session-tabs-runtime-rpc.ts) and the Go runtime's persisted
// /v1/session-tab-layouts snapshots. Layouts round-trip through the runtime as
// opaque JSON, so everything read back is validated structurally — a corrupt or
// stale snapshot must degrade to live-session defaults, never crash the RPC.

export type RuntimeSessionTabProps = {
  color?: string | null
  isPinned?: boolean
  viewMode?: 'terminal' | 'chat'
}

export type RuntimeSessionPaneLayout = {
  root: TerminalPaneLayoutNode | null
  expandedLeafId: string | null
  titlesByLeafId?: Record<string, string>
}

export type RuntimeSessionTabViewState = {
  activeTabId?: string | null
  activeGroupId?: string | null
  tabGroups?: RuntimeMobileSessionTabGroup[]
  tabGroupLayout?: TabGroupLayoutNode | null
  tabPropsByTabId: Map<string, RuntimeSessionTabProps>
  paneLayoutByTabId: Map<string, RuntimeSessionPaneLayout>
  snapshotVersion: number
}

export async function rehydrateSessionTabViewState(
  worktreeId: string,
  state: RuntimeSessionTabViewState
): Promise<void> {
  const snapshot = await loadSessionTabLayout(worktreeId)
  if (snapshot) {
    applyPersistedSessionTabLayout(state, snapshot)
  }
}

export function scheduleSessionTabViewStateSave(
  worktreeId: string,
  state: RuntimeSessionTabViewState
): void {
  scheduleSessionTabLayoutSave(worktreeId, {
    ...(state.activeTabId ? { activeTabId: state.activeTabId } : {}),
    ...(state.activeGroupId ? { activeGroupId: state.activeGroupId } : {}),
    ...(state.tabGroups ? { tabGroups: state.tabGroups } : {}),
    ...(state.tabGroupLayout ? { tabGroupLayout: state.tabGroupLayout } : {}),
    paneLayoutByTabId: Object.fromEntries(state.paneLayoutByTabId),
    tabPropsByTabId: Object.fromEntries(state.tabPropsByTabId)
  })
}

function applyPersistedSessionTabLayout(
  state: RuntimeSessionTabViewState,
  snapshot: SessionTabLayoutSnapshot
): void {
  state.activeTabId = readNonEmptyString(snapshot.activeTabId)
  state.activeGroupId = readNonEmptyString(snapshot.activeGroupId)
  const tabGroups = readPersistedTabGroups(snapshot.tabGroups)
  if (tabGroups) {
    state.tabGroups = tabGroups
  }
  if (isTabGroupLayoutNode(snapshot.tabGroupLayout)) {
    state.tabGroupLayout = snapshot.tabGroupLayout
  }
  for (const [tabId, layout] of Object.entries(asRecord(snapshot.paneLayoutByTabId) ?? {})) {
    const paneLayout = readPersistedPaneLayout(layout)
    if (paneLayout) {
      state.paneLayoutByTabId.set(tabId, paneLayout)
    }
  }
  for (const [tabId, props] of Object.entries(asRecord(snapshot.tabPropsByTabId) ?? {})) {
    const tabProps = readPersistedTabProps(props)
    if (tabProps) {
      state.tabPropsByTabId.set(tabId, tabProps)
    }
  }
  if (typeof snapshot.snapshotVersion === 'number' && Number.isFinite(snapshot.snapshotVersion)) {
    state.snapshotVersion = Math.max(state.snapshotVersion, snapshot.snapshotVersion)
  }
}

function readPersistedTabGroups(value: unknown): RuntimeMobileSessionTabGroup[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined
  }
  const groups: RuntimeMobileSessionTabGroup[] = []
  for (const entry of value) {
    const group = asRecord(entry)
    const id = readNonEmptyString(group?.id)
    // Why: reject the whole array on a malformed group instead of dropping
    // entries — a half-restored group set would silently reshuffle tabs.
    if (!group || !id || !Array.isArray(group.tabOrder)) {
      return undefined
    }
    groups.push({
      id,
      activeTabId: readNonEmptyString(group.activeTabId),
      tabOrder: group.tabOrder.filter((tabId): tabId is string => typeof tabId === 'string'),
      ...(Array.isArray(group.recentTabIds)
        ? {
            recentTabIds: group.recentTabIds.filter(
              (tabId): tabId is string => typeof tabId === 'string'
            )
          }
        : {})
    })
  }
  return groups
}

function isTabGroupLayoutNode(value: unknown): value is TabGroupLayoutNode {
  const node = asRecord(value)
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return typeof node.groupId === 'string' && node.groupId.length > 0
  }
  if (node.type !== 'split') {
    return false
  }
  return (
    (node.direction === 'horizontal' || node.direction === 'vertical') &&
    (node.ratio === undefined ||
      (typeof node.ratio === 'number' && node.ratio >= 0 && node.ratio <= 1)) &&
    isTabGroupLayoutNode(node.first) &&
    isTabGroupLayoutNode(node.second)
  )
}

function readPersistedPaneLayout(value: unknown): RuntimeSessionPaneLayout | null {
  const layout = asRecord(value)
  if (!layout) {
    return null
  }
  const root =
    layout.root === null || layout.root === undefined
      ? null
      : isTerminalPaneLayoutNode(layout.root)
        ? layout.root
        : undefined
  if (root === undefined) {
    return null
  }
  const titlesByLeafId = readStringRecord(layout.titlesByLeafId)
  return {
    root,
    expandedLeafId: readNonEmptyString(layout.expandedLeafId),
    ...(titlesByLeafId ? { titlesByLeafId } : {})
  }
}

function readPersistedTabProps(value: unknown): RuntimeSessionTabProps | null {
  const input = asRecord(value)
  if (!input) {
    return null
  }
  const props: RuntimeSessionTabProps = {}
  if (input.color === null || typeof input.color === 'string') {
    props.color = input.color
  }
  if (typeof input.isPinned === 'boolean') {
    props.isPinned = input.isPinned
  }
  if (input.viewMode === 'terminal' || input.viewMode === 'chat') {
    props.viewMode = input.viewMode
  }
  return Object.keys(props).length > 0 ? props : null
}

export function isTerminalPaneLayoutNode(value: unknown): value is TerminalPaneLayoutNode {
  const node = asRecord(value)
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return typeof node.leafId === 'string' && node.leafId.length > 0
  }
  if (node.type !== 'split') {
    return false
  }
  return (
    (node.direction === 'horizontal' || node.direction === 'vertical') &&
    (node.ratio === undefined ||
      (typeof node.ratio === 'number' && node.ratio >= 0 && node.ratio <= 1)) &&
    isTerminalPaneLayoutNode(node.first) &&
    isTerminalPaneLayoutNode(node.second)
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) {
    return undefined
  }
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') {
      result[key] = entry
    }
  }
  return result
}
