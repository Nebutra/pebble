import { describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/types'
import {
  BROWSER_GUEST_HIDDEN_WORKTREE_RETENTION_LIMIT,
  browserTabVisibilityPageIds,
  selectBrowserGuestEvictionWorktreeIds,
  touchBrowserGuestWorktreeRecency,
  worktreeHoldsLiveBrowserGuests
} from './browser-guest-worktree-retention'

function browserTab(
  id: string,
  pageIds: string[] = [],
  activePageId: string | null = null
): BrowserWorkspace {
  return {
    id,
    worktreeId: 'wt-1',
    label: id,
    sessionProfileId: null,
    pageIds,
    activePageId,
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  } as BrowserWorkspace
}

function page(id: string, workspaceId: string): BrowserPage {
  return {
    id,
    workspaceId,
    worktreeId: 'wt-1',
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  } as BrowserPage
}

type SelectionOverrides = Partial<Parameters<typeof selectBrowserGuestEvictionWorktreeIds>[0]>

function selectEvicted(overrides: SelectionOverrides): string[] {
  return selectBrowserGuestEvictionWorktreeIds({
    orderedWorktreeIds: [],
    activeWorktreeId: null,
    isRetained: () => true,
    holdsLiveGuests: () => true,
    isEvictable: () => true,
    ...overrides
  })
}

describe('selectBrowserGuestEvictionWorktreeIds', () => {
  const sixWorktrees = ['wt-1', 'wt-2', 'wt-3', 'wt-4', 'wt-5', 'wt-6']

  it('is a no-op while retained guest-holding worktrees fit the budget', () => {
    expect(
      selectEvicted({
        orderedWorktreeIds: sixWorktrees.slice(0, BROWSER_GUEST_HIDDEN_WORKTREE_RETENTION_LIMIT)
      })
    ).toEqual([])
  })

  it('evicts the least-recently-activated worktrees beyond the budget', () => {
    expect(selectEvicted({ orderedWorktreeIds: sixWorktrees })).toEqual(['wt-5', 'wt-6'])
  })

  it('never evicts or counts the active worktree', () => {
    expect(selectEvicted({ orderedWorktreeIds: sixWorktrees, activeWorktreeId: 'wt-1' })).toEqual([
      'wt-6'
    ])
    expect(selectEvicted({ orderedWorktreeIds: sixWorktrees, activeWorktreeId: 'wt-6' })).toEqual([
      'wt-5'
    ])
  })

  it('counts only worktrees that actually hold live guests', () => {
    const holders = new Set(['wt-5', 'wt-6'])
    expect(
      selectEvicted({
        orderedWorktreeIds: sixWorktrees,
        holdsLiveGuests: (worktreeId) => holders.has(worktreeId)
      })
    ).toEqual([])
  })

  it('skips worktrees that are no longer retained', () => {
    expect(
      selectEvicted({
        orderedWorktreeIds: sixWorktrees,
        isRetained: (worktreeId) => worktreeId !== 'wt-1' && worktreeId !== 'wt-2'
      })
    ).toEqual([])
  })

  it('keeps a non-evictable worktree retained over budget instead of evicting it', () => {
    expect(
      selectEvicted({
        orderedWorktreeIds: sixWorktrees,
        isEvictable: (worktreeId) => worktreeId !== 'wt-5'
      })
    ).toEqual(['wt-6'])
  })
})

describe('worktreeHoldsLiveBrowserGuests', () => {
  it('detects live page guests and legacy tab-keyed guests', () => {
    const live = new Set(['page-1', 'legacy-tab'])
    expect(
      worktreeHoldsLiveBrowserGuests(
        [browserTab('ws-1', ['page-1']), browserTab('legacy-tab')],
        { 'ws-1': [page('page-1', 'ws-1')] },
        (id) => live.has(id)
      )
    ).toBe(true)
    expect(
      worktreeHoldsLiveBrowserGuests(
        [browserTab('ws-1', ['page-2'])],
        { 'ws-1': [page('page-2', 'ws-1')] },
        (id) => live.has(id)
      )
    ).toBe(false)
  })
})

describe('browserTabVisibilityPageIds', () => {
  it('prefers pageIds and falls back to activePageId or tab id', () => {
    expect(browserTabVisibilityPageIds(browserTab('t1', ['p1', 'p2']))).toEqual(['p1', 'p2'])
    expect(browserTabVisibilityPageIds(browserTab('t1', [], 'active-1'))).toEqual(['active-1'])
    expect(browserTabVisibilityPageIds(browserTab('t1'))).toEqual(['t1'])
  })
})

describe('touchBrowserGuestWorktreeRecency', () => {
  it('moves the activated worktree to the front without duplicates', () => {
    const recency = ['wt-a', 'wt-b', 'wt-c']
    touchBrowserGuestWorktreeRecency(recency, 'wt-c')
    expect(recency).toEqual(['wt-c', 'wt-a', 'wt-b'])
    touchBrowserGuestWorktreeRecency(recency, 'wt-new')
    expect(recency).toEqual(['wt-new', 'wt-c', 'wt-a', 'wt-b'])
  })
})
