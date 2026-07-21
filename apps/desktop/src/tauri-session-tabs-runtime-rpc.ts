import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab,
  RuntimeTerminalRename
} from '../../../packages/product-core/shared/runtime-types'
import type {
  TabGroupLayoutNode,
  TerminalPaneLayoutNode
} from '../../../packages/product-core/shared/types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { readWorktrees } from './pebble-tauri-workspace-runtime-api'
import {
  isTerminalPaneLayoutNode,
  rehydrateSessionTabViewState,
  scheduleSessionTabViewStateSave,
  type RuntimeSessionTabProps,
  type RuntimeSessionTabViewState
} from './tauri-session-tab-view-state-persistence'
import { callTauriTerminalRuntimeRpc } from './tauri-terminal-runtime-rpc'

type RuntimeSessionStatus = 'starting' | 'running' | 'exited' | 'failed' | 'stopped'

type RuntimeSession = {
  id: string
  projectId?: string
  worktreeId?: string
  cwd: string
  command: string[]
  agentKind?: string
  tabId?: string
  leafId?: string
  status: RuntimeSessionStatus
  updatedAt?: string
}

type RuntimeSessionTabsRpcResult = {
  handled: boolean
  result?: unknown
}

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
function ensureSessionTabViewStateRehydrated(worktreeId: string): Promise<void> {
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
function persistSessionTabViewState(worktreeId: string): void {
  scheduleSessionTabViewStateSave(worktreeId, getSessionTabViewState(worktreeId))
}

export async function callTauriSessionTabsRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeSessionTabsRpcResult> {
  switch (method) {
    case 'session.tabs.list':
      return handled(await readSessionTabs(params))
    case 'session.tabs.listAll':
      return handled({ snapshots: await readAllSessionTabs() })
    case 'session.tabs.createTerminal':
      return handled(await createSessionTerminalTab(params))
    case 'session.tabs.close':
      return handled(await closeSessionTab(params))
    case 'session.tabs.activate':
      return handled(await activateSessionTab(params))
    case 'session.tabs.move':
      return handled(await moveSessionTab(params))
    case 'session.tabs.updatePaneLayout':
      return handled(await updateSessionPaneLayout(params))
    case 'session.tabs.setTabProps':
      return handled(await setSessionTabProps(params))
    case 'terminal.rename':
      return handled(await renameSessionTerminal(params))
    case 'session.tabs.subscribe':
      return handled({ type: 'snapshot', ...(await readSessionTabs(params)) })
    case 'session.tabs.subscribeAll':
      return handled({ type: 'snapshots', snapshots: await readAllSessionTabs() })
    case 'session.tabs.unsubscribe':
    case 'session.tabs.unsubscribeAll':
      return handled({ unsubscribed: true })
    default:
      return { handled: false }
  }
}

async function readSessionTabs(params: unknown): Promise<RuntimeMobileSessionTabsResult> {
  const worktreeId = await resolveWorktreeId(params)
  await ensureSessionTabViewStateRehydrated(worktreeId)
  return sessionTabsSnapshot(worktreeId, await listWorktreeSessions(worktreeId))
}

async function readAllSessionTabs(): Promise<RuntimeMobileSessionTabsResult[]> {
  const sessions = await listSessions()
  const worktreeIds = new Set(
    sessions.map((session) => session.worktreeId).filter((id): id is string => Boolean(id))
  )
  const worktrees = await readWorktrees()
  for (const worktree of worktrees) {
    worktreeIds.add(worktree.id)
  }
  await Promise.all([...worktreeIds].map((id) => ensureSessionTabViewStateRehydrated(id)))
  return [...worktreeIds].map((worktreeId) =>
    sessionTabsSnapshot(
      worktreeId,
      sessions.filter((session) => session.worktreeId === worktreeId)
    )
  )
}

async function createSessionTerminalTab(
  params: unknown
): Promise<RuntimeMobileSessionCreateTerminalResult> {
  const input = readObject(params)
  const createResult = await callTauriTerminalRuntimeRpc('terminal.create', {
    ...input,
    worktree: input.worktree,
    tabId: readString(input.targetGroupId) ? undefined : readString(input.tabId)
  })
  if (!createResult.handled || !createResult.result) {
    throw new Error('session_terminal_create_unhandled')
  }
  const terminal = readObject(readObject(createResult.result).terminal)
  const session = await findSession(readRequiredString(terminal.handle, 'terminal handle'))
  if (!session) {
    throw new Error('session_terminal_not_found')
  }
  if (session.worktreeId) {
    await ensureSessionTabViewStateRehydrated(session.worktreeId)
    const state = getSessionTabViewState(session.worktreeId)
    state.activeTabId = sessionTabId(session)
    state.snapshotVersion += 1
    persistSessionTabViewState(session.worktreeId)
  }
  return {
    tab: mapSessionToTerminalTab(session, true),
    publicationEpoch: publicationEpoch(),
    snapshotVersion: Date.now()
  }
}

async function closeSessionTab(params: unknown): Promise<RuntimeMobileSessionTabsResult> {
  const worktreeId = await resolveWorktreeId(params)
  await ensureSessionTabViewStateRehydrated(worktreeId)
  const tabId = readRequiredString(readObject(params).tabId, 'tab id')
  const sessions = await listWorktreeSessions(worktreeId)
  const target = sessions.find((session) => sessionTabId(session) === tabId || session.id === tabId)
  if (target) {
    await requestRuntimeJson<RuntimeSession>(`/v1/sessions/${encodeURIComponent(target.id)}`, {
      method: 'DELETE'
    })
  }
  const nextSessions = (await listWorktreeSessions(worktreeId)).filter(
    (session) => session.id !== target?.id
  )
  pruneSessionTabViewState(
    worktreeId,
    nextSessions.map((session) => sessionTabId(session))
  )
  const snapshot = sessionTabsSnapshot(worktreeId, nextSessions)
  persistSessionTabViewState(worktreeId)
  return snapshot
}

async function activateSessionTab(params: unknown): Promise<RuntimeMobileSessionTabsResult> {
  const worktreeId = await resolveWorktreeId(params)
  await ensureSessionTabViewStateRehydrated(worktreeId)
  const tabId = readRequiredString(readObject(params).tabId, 'tab id')
  const sessions = await listWorktreeSessions(worktreeId)
  const snapshot = sessionTabsSnapshot(worktreeId, sessions, tabId)
  const state = getSessionTabViewState(worktreeId)
  state.activeTabId = snapshot.activeTabId
  state.activeGroupId = snapshot.activeGroupId
  state.snapshotVersion += 1
  persistSessionTabViewState(worktreeId)
  return sessionTabsSnapshot(worktreeId, sessions, snapshot.activeTabId ?? tabId)
}

async function moveSessionTab(params: unknown): Promise<RuntimeMobileSessionTabMoveResult> {
  const worktreeId = await resolveWorktreeId(params)
  const move = readSessionTabMove(readObject(params))
  const snapshot = await readSessionTabs({ worktree: worktreeId })
  const tabId = resolveTopLevelTabId(snapshot.tabs, move.tabId)
  if (!tabId) {
    throw new Error('tab_not_found')
  }
  const targetGroup = snapshot.tabGroups?.find((group) => group.id === move.targetGroupId)
  if (!targetGroup) {
    throw new Error('target_group_not_found')
  }
  const state = getSessionTabViewState(worktreeId)
  if (move.kind === 'reorder') {
    const tabOrder = normalizeTabOrder(snapshot, targetGroup, move.tabOrder)
    state.tabGroups = (snapshot.tabGroups ?? []).map((group) =>
      group.id === targetGroup.id ? { ...group, tabOrder, activeTabId: tabId } : group
    )
    state.activeGroupId = targetGroup.id
    state.activeTabId = tabId
    state.snapshotVersion += 1
    persistSessionTabViewState(worktreeId)
    return { moved: true }
  }
  if (move.kind === 'move-to-group') {
    state.tabGroups = moveTabToGroup(
      snapshot.tabGroups ?? [],
      tabId,
      move.targetGroupId,
      move.index
    )
    state.activeGroupId = move.targetGroupId
    state.activeTabId = tabId
    state.snapshotVersion += 1
    persistSessionTabViewState(worktreeId)
    return { moved: true }
  }
  const split = splitTabIntoGroup(snapshot, tabId, move)
  state.tabGroups = split.groups
  state.tabGroupLayout = split.layout
  state.activeGroupId = split.activeGroupId
  state.activeTabId = tabId
  state.snapshotVersion += 1
  persistSessionTabViewState(worktreeId)
  return { moved: true }
}

async function updateSessionPaneLayout(params: unknown): Promise<{ updated: true }> {
  const input = readObject(params)
  const worktreeId = await resolveWorktreeId(input)
  const snapshot = await readSessionTabs({ worktree: worktreeId })
  const tabId = resolveTopLevelTabId(snapshot.tabs, readRequiredString(input.tabId, 'tab id'))
  if (!tabId) {
    throw new Error('tab_not_found')
  }
  getSessionTabViewState(worktreeId).paneLayoutByTabId.set(tabId, {
    root: readPaneLayoutRoot(input.root),
    expandedLeafId: readNullableString(input.expandedLeafId),
    ...(readStringRecord(input.titlesByLeafId)
      ? { titlesByLeafId: readStringRecord(input.titlesByLeafId) }
      : {})
  })
  getSessionTabViewState(worktreeId).snapshotVersion += 1
  persistSessionTabViewState(worktreeId)
  return { updated: true }
}

async function setSessionTabProps(params: unknown): Promise<{ updated: true }> {
  const input = readObject(params)
  const worktreeId = await resolveWorktreeId(input)
  const snapshot = await readSessionTabs({ worktree: worktreeId })
  const tabId = resolveTopLevelTabId(snapshot.tabs, readRequiredString(input.tabId, 'tab id'))
  if (!tabId) {
    throw new Error('tab_not_found')
  }
  const props: RuntimeSessionTabProps = {}
  if ('color' in input) {
    props.color = input.color === null ? null : readString(input.color)
  }
  if (typeof input.isPinned === 'boolean') {
    props.isPinned = input.isPinned
  }
  if (input.viewMode === 'terminal' || input.viewMode === 'chat') {
    props.viewMode = input.viewMode
  }
  getSessionTabViewState(worktreeId).tabPropsByTabId.set(tabId, {
    ...getSessionTabViewState(worktreeId).tabPropsByTabId.get(tabId),
    ...props
  })
  getSessionTabViewState(worktreeId).snapshotVersion += 1
  persistSessionTabViewState(worktreeId)
  return { updated: true }
}

async function renameSessionTerminal(params: unknown): Promise<RuntimeTerminalRename> {
  const input = readObject(params)
  const handle = readRequiredString(input.terminal ?? input.handle, 'terminal handle')
  const title = readNullableString(input.title)
  const session = await findSession(handle)
  if (!session) {
    throw new Error('terminal_not_found')
  }
  const tabId = sessionTabId(session)
  if (session.worktreeId) {
    await ensureSessionTabViewStateRehydrated(session.worktreeId)
    const state = getSessionTabViewState(session.worktreeId)
    state.tabPropsByTabId.set(tabId, {
      ...state.tabPropsByTabId.get(tabId),
      customTitle: title
    })
    state.snapshotVersion += 1
    // Why: custom titles are user-authored tab state and must survive renderer
    // reloads and native runtime restarts just like pin/color preferences.
    persistSessionTabViewState(session.worktreeId)
  }
  return { handle: session.id, tabId, title }
}

async function listWorktreeSessions(worktreeId: string): Promise<RuntimeSession[]> {
  return (await listSessions()).filter((session) => session.worktreeId === worktreeId)
}

async function listSessions(): Promise<RuntimeSession[]> {
  return requestRuntimeJson<RuntimeSession[]>('/v1/sessions', { method: 'GET' })
}

async function findSession(id: string): Promise<RuntimeSession | null> {
  return (await listSessions()).find((session) => session.id === id) ?? null
}

async function resolveWorktreeId(params: unknown): Promise<string> {
  const input = readObject(params)
  const selector = normalizeRuntimeWorktreeId(
    readString(input.worktree) ?? readString(input.worktreeId)
  )
  if (!selector) {
    throw new Error('session_tabs_requires_worktree')
  }
  if ((await readWorktrees()).some((worktree) => worktree.id === selector)) {
    return selector
  }
  return selector
}

function sessionTabsSnapshot(
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

function mapSessionToTerminalTab(
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

function getSessionTabViewState(worktreeId: string): RuntimeSessionTabViewState {
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

function buildSessionTabGroups(
  tabs: RuntimeMobileSessionClientTab[],
  state: RuntimeSessionTabViewState,
  activeTopLevelId: string | null
): {
  activeGroupId: string | null
  tabGroups: RuntimeMobileSessionTabGroup[]
  tabGroupLayout: TabGroupLayoutNode | null
} {
  const liveTopLevelIds = tabs.map(topLevelTabId)
  if (liveTopLevelIds.length === 0) {
    return { activeGroupId: null, tabGroups: [], tabGroupLayout: null }
  }
  const live = new Set(liveTopLevelIds)
  const reconciled = reconcileSessionTabGroups(state.tabGroups, liveTopLevelIds, activeTopLevelId)
  const activeGroup =
    reconciled.find((group) => activeTopLevelId && group.tabOrder.includes(activeTopLevelId)) ??
    reconciled.find((group) => group.id === state.activeGroupId) ??
    reconciled[0]
  const groups = reconciled.map((group) => ({
    ...group,
    activeTabId:
      activeTopLevelId && group.tabOrder.includes(activeTopLevelId)
        ? activeTopLevelId
        : group.activeTabId && live.has(group.activeTabId)
          ? group.activeTabId
          : (group.tabOrder[0] ?? null)
  }))
  return {
    activeGroupId: activeGroup?.id ?? null,
    tabGroups: groups,
    tabGroupLayout:
      groups.length > 1 ? (state.tabGroupLayout ?? defaultTabGroupLayout(groups)) : null
  }
}

function reconcileSessionTabGroups(
  groups: RuntimeMobileSessionTabGroup[] | undefined,
  liveTopLevelIds: string[],
  activeTopLevelId: string | null
): RuntimeMobileSessionTabGroup[] {
  if (!groups || groups.length === 0) {
    return [
      {
        id: 'main',
        activeTabId: activeTopLevelId ?? liveTopLevelIds[0] ?? null,
        tabOrder: liveTopLevelIds
      }
    ]
  }
  const live = new Set(liveTopLevelIds)
  const seen = new Set<string>()
  const reconciled = groups
    .map((group) => {
      const tabOrder = group.tabOrder.filter((tabId) => {
        if (!live.has(tabId) || seen.has(tabId)) {
          return false
        }
        seen.add(tabId)
        return true
      })
      return { ...group, tabOrder }
    })
    .filter((group) => group.tabOrder.length > 0)
  const missing = liveTopLevelIds.filter((tabId) => !seen.has(tabId))
  if (reconciled.length === 0) {
    return [
      {
        id: 'main',
        activeTabId: activeTopLevelId ?? liveTopLevelIds[0] ?? null,
        tabOrder: liveTopLevelIds
      }
    ]
  }
  if (missing.length > 0) {
    reconciled[0] = {
      ...reconciled[0],
      tabOrder: [...reconciled[0].tabOrder, ...missing]
    }
  }
  return reconciled
}

function normalizeTabOrder(
  snapshot: RuntimeMobileSessionTabsResult,
  targetGroup: RuntimeMobileSessionTabGroup,
  requestedOrder: string[]
): string[] {
  const normalized = requestedOrder.map((tabId) => {
    const resolved = resolveTopLevelTabId(snapshot.tabs, tabId)
    if (!resolved) {
      throw new Error('invalid_tab_order')
    }
    return resolved
  })
  const seen = new Set(normalized)
  if (seen.size !== normalized.length) {
    throw new Error('duplicate_tab_order')
  }
  const expected = targetGroup.tabOrder
  if (expected.length !== normalized.length || expected.some((tabId) => !seen.has(tabId))) {
    throw new Error('invalid_tab_order')
  }
  return normalized
}

function moveTabToGroup(
  groups: RuntimeMobileSessionTabGroup[],
  tabId: string,
  targetGroupId: string,
  index: number | undefined
): RuntimeMobileSessionTabGroup[] {
  let targetFound = false
  const withoutTab = groups
    .map((group) => ({
      ...group,
      tabOrder: group.tabOrder.filter((candidate) => candidate !== tabId)
    }))
    .filter((group) => group.tabOrder.length > 0 || group.id === targetGroupId)
  const nextGroups = withoutTab.map((group) => {
    if (group.id !== targetGroupId) {
      return group
    }
    targetFound = true
    const nextOrder = [...group.tabOrder]
    const insertAt =
      typeof index === 'number' && Number.isInteger(index) && index >= 0
        ? Math.min(index, nextOrder.length)
        : nextOrder.length
    nextOrder.splice(insertAt, 0, tabId)
    return { ...group, activeTabId: tabId, tabOrder: nextOrder }
  })
  if (!targetFound) {
    throw new Error('target_group_not_found')
  }
  return nextGroups
}

function splitTabIntoGroup(
  snapshot: RuntimeMobileSessionTabsResult,
  tabId: string,
  move: Extract<RuntimeMobileSessionTabMove, { kind: 'split' }>
): { groups: RuntimeMobileSessionTabGroup[]; layout: TabGroupLayoutNode; activeGroupId: string } {
  const sourceGroups = snapshot.tabGroups ?? []
  const targetGroup = sourceGroups.find((group) => group.id === move.targetGroupId)
  if (!targetGroup) {
    throw new Error('target_group_not_found')
  }
  if (targetGroup.tabOrder.length <= 1) {
    return {
      groups: sourceGroups,
      layout: snapshot.tabGroupLayout ?? defaultTabGroupLayout(sourceGroups),
      activeGroupId: targetGroup.id
    }
  }
  const newGroupId = `tauri-split-${Date.now().toString(36)}`
  const groups = sourceGroups
    .map((group) => ({
      ...group,
      tabOrder: group.tabOrder.filter((candidate) => candidate !== tabId)
    }))
    .filter((group) => group.tabOrder.length > 0)
  groups.push({ id: newGroupId, activeTabId: tabId, tabOrder: [tabId] })
  return {
    groups,
    layout: insertTabGroupSplit(
      snapshot.tabGroupLayout ?? defaultTabGroupLayout(sourceGroups),
      move.targetGroupId,
      newGroupId,
      move.splitDirection
    ),
    activeGroupId: newGroupId
  }
}

function insertTabGroupSplit(
  layout: TabGroupLayoutNode,
  targetGroupId: string,
  newGroupId: string,
  splitDirection: Extract<RuntimeMobileSessionTabMove, { kind: 'split' }>['splitDirection']
): TabGroupLayoutNode {
  if (layout.type === 'leaf') {
    if (layout.groupId !== targetGroupId) {
      return layout
    }
    const direction =
      splitDirection === 'left' || splitDirection === 'right' ? 'horizontal' : 'vertical'
    const newLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: newGroupId }
    const oldLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: targetGroupId }
    return splitDirection === 'left' || splitDirection === 'up'
      ? { type: 'split', direction, first: newLeaf, second: oldLeaf, ratio: 0.5 }
      : { type: 'split', direction, first: oldLeaf, second: newLeaf, ratio: 0.5 }
  }
  if (layoutContainsGroup(layout.first, targetGroupId)) {
    return {
      ...layout,
      first: insertTabGroupSplit(layout.first, targetGroupId, newGroupId, splitDirection)
    }
  }
  if (layoutContainsGroup(layout.second, targetGroupId)) {
    return {
      ...layout,
      second: insertTabGroupSplit(layout.second, targetGroupId, newGroupId, splitDirection)
    }
  }
  return layout
}

function layoutContainsGroup(layout: TabGroupLayoutNode, groupId: string): boolean {
  if (layout.type === 'leaf') {
    return layout.groupId === groupId
  }
  return layoutContainsGroup(layout.first, groupId) || layoutContainsGroup(layout.second, groupId)
}

function defaultTabGroupLayout(groups: RuntimeMobileSessionTabGroup[]): TabGroupLayoutNode {
  const leaves = groups.map((group) => ({ type: 'leaf' as const, groupId: group.id }))
  return leaves.slice(1).reduce<TabGroupLayoutNode>(
    (layout, leaf) => ({
      type: 'split',
      direction: 'horizontal',
      first: layout,
      second: leaf,
      ratio: 0.5
    }),
    leaves[0] ?? { type: 'leaf', groupId: 'main' }
  )
}

function resolveTopLevelTabId(
  tabs: RuntimeMobileSessionClientTab[],
  tabId: string | null
): string | null {
  if (!tabId) {
    return null
  }
  const tab = tabs.find(
    (candidate) =>
      candidate.id === tabId ||
      (candidate.type === 'terminal' &&
        (candidate.parentTabId === tabId || candidate.leafId === tabId))
  )
  return tab ? topLevelTabId(tab) : null
}

function topLevelTabId(tab: RuntimeMobileSessionClientTab): string {
  return tab.type === 'terminal' ? tab.parentTabId : tab.id
}

function readSessionTabMove(input: Record<string, unknown>): RuntimeMobileSessionTabMove {
  const kind = readRequiredString(input.kind, 'move kind')
  const base = {
    tabId: readRequiredString(input.tabId, 'tab id'),
    targetGroupId: readRequiredString(input.targetGroupId, 'target group id')
  }
  if (kind === 'reorder') {
    return { ...base, kind, tabOrder: readRequiredStringArray(input.tabOrder, 'tab order') }
  }
  if (kind === 'move-to-group') {
    return { ...base, kind, index: readNumber(input.index) }
  }
  if (kind === 'split') {
    const splitDirection = readRequiredString(input.splitDirection, 'split direction')
    if (
      splitDirection !== 'left' &&
      splitDirection !== 'right' &&
      splitDirection !== 'up' &&
      splitDirection !== 'down'
    ) {
      throw new Error('invalid_split_direction')
    }
    return { ...base, kind, splitDirection }
  }
  throw new Error('invalid_move_kind')
}

function sessionTabId(session: RuntimeSession): string {
  return session.tabId || `tab-${session.id}`
}

function normalizeRuntimeWorktreeId(value: string | null): string | null {
  if (!value) {
    return null
  }
  return value.startsWith('id:') ? value.slice(3) : value
}

function publicationEpoch(): string {
  return String(Date.now())
}

function terminalTitle(session: RuntimeSession): string {
  return session.command.join(' ') || session.agentKind || 'Terminal'
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readRequiredString(value: unknown, label: string): string {
  const result = readString(value)
  if (!result) {
    throw new Error(`${label} is required`)
  }
  return result
}

function readNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : readString(value)
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function readRequiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} is required`)
  }
  return value.map((entry) => readRequiredString(entry, label))
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry
    }
  }
  return result
}

function readPaneLayoutRoot(value: unknown): TerminalPaneLayoutNode | null {
  if (value === null || value === undefined) {
    return null
  }
  if (!isTerminalPaneLayoutNode(value)) {
    throw new Error('invalid_pane_layout')
  }
  return value
}

function handled(result: unknown): RuntimeSessionTabsRpcResult {
  return { handled: true, result }
}
