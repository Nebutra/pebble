import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'

const recordRendererCrashBreadcrumb = vi.fn()
vi.mock('../../lib/crash-diagnostics', () => ({
  recordRendererCrashBreadcrumb: (...args: unknown[]) => recordRendererCrashBreadcrumb(...args)
}))

const { resolveActiveTabOwnerWorktreeId, _resetDuplicateTabOwnerBreadcrumbsForTests } =
  await import('./active-tab-owner-worktree')

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

beforeEach(() => {
  recordRendererCrashBreadcrumb.mockClear()
  _resetDuplicateTabOwnerBreadcrumbsForTests()
})

describe('resolveActiveTabOwnerWorktreeId', () => {
  it('returns the sole owner and stays quiet', () => {
    const owner = resolveActiveTabOwnerWorktreeId(
      { 'wt-a': [tab('t1', 'wt-a')], 'wt-b': [tab('t2', 'wt-b')] },
      'wt-a',
      't1'
    )
    expect(owner).toBe('wt-a')
    expect(recordRendererCrashBreadcrumb).not.toHaveBeenCalled()
  })

  it('returns null when no worktree owns the tab', () => {
    expect(resolveActiveTabOwnerWorktreeId({ 'wt-a': [tab('t1', 'wt-a')] }, 'wt-a', 'gone')).toBe(
      null
    )
  })

  it('prefers the active worktree over an earlier-scanned duplicate', () => {
    // Why regression (#66 / upstream #11950): first-match ownership skipped activeTabId
    // while reallocating activeTabIdByWorktree, retriggering repair indefinitely.
    const owner = resolveActiveTabOwnerWorktreeId(
      { 'wt-other': [tab('t1', 'wt-other')], 'wt-active': [tab('t1', 'wt-active')] },
      'wt-active',
      't1'
    )
    expect(owner).toBe('wt-active')
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_tab_id_owned_by_multiple_worktrees',
      { ownerCount: 2, resolvedToActiveWorktree: true }
    )
  })

  it('falls back to first match when the active worktree is not an owner', () => {
    const owner = resolveActiveTabOwnerWorktreeId(
      { 'wt-x': [tab('t1', 'wt-x')], 'wt-y': [tab('t1', 'wt-y')] },
      'wt-active',
      't1'
    )
    expect(owner).toBe('wt-x')
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_tab_id_owned_by_multiple_worktrees',
      { ownerCount: 2, resolvedToActiveWorktree: false }
    )
  })

  // Why: a truthiness guard on the active id would drop this back to first-match.
  it('prefers a falsy-but-valid active worktree id', () => {
    const owner = resolveActiveTabOwnerWorktreeId(
      { 'wt-other': [tab('t1', 'wt-other')], '': [tab('t1', '')] },
      '',
      't1'
    )
    expect(owner).toBe('')
  })

  it('breadcrumbs a given tab id once per verdict so it cannot flood the ring', () => {
    const map = {
      'wt-other': [tab('t1', 'wt-other')],
      'wt-active': [tab('t1', 'wt-active')]
    }
    resolveActiveTabOwnerWorktreeId(map, 'wt-active', 't1')
    resolveActiveTabOwnerWorktreeId(map, 'wt-active', 't1')
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledTimes(1)
  })
})
