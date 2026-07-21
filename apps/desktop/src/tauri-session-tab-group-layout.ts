import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabsResult
} from '../../../packages/product-core/shared/runtime-types'
import type { TabGroupLayoutNode } from '../../../packages/product-core/shared/types'
import type { RuntimeSessionTabViewState } from './tauri-session-tab-view-state-persistence'

export function buildSessionTabGroups(
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

export function normalizeTabOrder(
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

export function moveTabToGroup(
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

export function splitTabIntoGroup(
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

export function defaultTabGroupLayout(
  groups: RuntimeMobileSessionTabGroup[]
): TabGroupLayoutNode {
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

export function resolveTopLevelTabId(
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

export function topLevelTabId(tab: RuntimeMobileSessionClientTab): string {
  return tab.type === 'terminal' ? tab.parentTabId : tab.id
}
