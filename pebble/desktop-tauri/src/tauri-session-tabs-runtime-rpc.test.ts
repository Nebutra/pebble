import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestRuntimeJsonMock, readWorktreesMock, loadLayoutMock, scheduleLayoutSaveMock } =
  vi.hoisted(() => ({
    requestRuntimeJsonMock: vi.fn(),
    readWorktreesMock: vi.fn(),
    loadLayoutMock: vi.fn(),
    scheduleLayoutSaveMock: vi.fn()
  }))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock,
  getHostPlatform: () => 'darwin'
}))

vi.mock('./pebble-tauri-workspace-runtime-api', () => ({
  readWorktrees: readWorktreesMock
}))

vi.mock('./tauri-session-tab-layout-persistence', () => ({
  loadSessionTabLayout: loadLayoutMock,
  scheduleSessionTabLayoutSave: scheduleLayoutSaveMock
}))

import {
  callTauriSessionTabsRuntimeRpc,
  clearTauriSessionTabViewStateForTests
} from './tauri-session-tabs-runtime-rpc'

beforeEach(() => {
  vi.clearAllMocks()
  clearTauriSessionTabViewStateForTests()
  loadLayoutMock.mockResolvedValue(null)
  readWorktreesMock.mockResolvedValue([
    {
      id: 'wt-1',
      repoId: 'repo-1',
      projectId: 'project-1',
      path: '/repo/worktree',
      hostId: 'local'
    }
  ])
})

describe('callTauriSessionTabsRuntimeRpc', () => {
  function mockRuntimeSessions(
    sessions: {
      id: string
      tabId: string
      leafId: string
      command?: string[]
      status?: string
    }[]
  ): void {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/sessions' && options?.method === 'GET') {
          return sessions.map((session) => ({
            id: session.id,
            worktreeId: 'wt-1',
            cwd: '/repo/worktree',
            command: session.command ?? ['zsh'],
            tabId: session.tabId,
            leafId: session.leafId,
            status: session.status ?? 'running'
          }))
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
  }

  it('builds session.tabs.list from real Go runtime sessions', async () => {
    requestRuntimeJsonMock.mockResolvedValue([
      {
        id: 'sess-1',
        worktreeId: 'wt-1',
        cwd: '/repo/worktree',
        command: ['zsh'],
        tabId: 'tab-1',
        leafId: 'leaf-1',
        status: 'running'
      }
    ])

    await expect(
      callTauriSessionTabsRuntimeRpc('session.tabs.list', { worktree: 'id:wt-1' })
    ).resolves.toMatchObject({
      handled: true,
      result: {
        worktree: 'wt-1',
        activeGroupId: 'main',
        activeTabId: 'tab-1',
        activeTabType: 'terminal',
        tabGroups: [
          {
            id: 'main',
            activeTabId: 'tab-1',
            tabOrder: ['tab-1']
          }
        ],
        tabs: [
          {
            type: 'terminal',
            id: 'leaf-1',
            parentTabId: 'tab-1',
            leafId: 'leaf-1',
            ptyId: 'sess-1',
            terminal: 'sess-1',
            status: 'ready',
            isActive: true
          }
        ]
      }
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/sessions', { method: 'GET' })
  })

  it('persists session.tabs.move reorder in the Tauri session-tab snapshot', async () => {
    mockRuntimeSessions([
      { id: 'sess-1', tabId: 'tab-1', leafId: 'leaf-1' },
      { id: 'sess-2', tabId: 'tab-2', leafId: 'leaf-2' }
    ])

    await expect(
      callTauriSessionTabsRuntimeRpc('session.tabs.move', {
        worktree: 'id:wt-1',
        tabId: 'tab-2',
        targetGroupId: 'main',
        kind: 'reorder',
        tabOrder: ['tab-2', 'tab-1']
      })
    ).resolves.toEqual({ handled: true, result: { moved: true } })

    await expect(
      callTauriSessionTabsRuntimeRpc('session.tabs.list', { worktree: 'id:wt-1' })
    ).resolves.toMatchObject({
      handled: true,
      result: {
        activeGroupId: 'main',
        activeTabId: 'tab-2',
        tabGroups: [
          {
            id: 'main',
            activeTabId: 'tab-2',
            tabOrder: ['tab-2', 'tab-1']
          }
        ]
      }
    })
  })

  it('applies session tab props and pane layout updates to snapshots', async () => {
    mockRuntimeSessions([{ id: 'sess-1', tabId: 'tab-1', leafId: 'leaf-1' }])

    await callTauriSessionTabsRuntimeRpc('session.tabs.setTabProps', {
      worktree: 'id:wt-1',
      tabId: 'tab-1',
      color: '#f97316',
      isPinned: true,
      viewMode: 'chat'
    })
    await callTauriSessionTabsRuntimeRpc('session.tabs.updatePaneLayout', {
      worktree: 'id:wt-1',
      tabId: 'tab-1',
      root: { type: 'leaf', leafId: 'leaf-1' },
      expandedLeafId: 'leaf-1',
      titlesByLeafId: { 'leaf-1': 'Agent' }
    })

    await expect(
      callTauriSessionTabsRuntimeRpc('session.tabs.list', { worktree: 'id:wt-1' })
    ).resolves.toMatchObject({
      handled: true,
      result: {
        tabs: [
          {
            parentTabId: 'tab-1',
            color: '#f97316',
            isPinned: true,
            viewMode: 'chat',
            parentLayout: {
              root: { type: 'leaf', leafId: 'leaf-1' },
              activeLeafId: 'leaf-1',
              expandedLeafId: 'leaf-1',
              titlesByLeafId: { 'leaf-1': 'Agent' }
            }
          }
        ]
      }
    })
  })

  it('returns local session tab subscription snapshots and unsubscribe acknowledgements', async () => {
    mockRuntimeSessions([{ id: 'sess-1', tabId: 'tab-1', leafId: 'leaf-1' }])

    await expect(
      callTauriSessionTabsRuntimeRpc('session.tabs.subscribe', { worktree: 'id:wt-1' })
    ).resolves.toMatchObject({
      handled: true,
      result: {
        type: 'snapshot',
        worktree: 'wt-1',
        tabs: [{ parentTabId: 'tab-1' }]
      }
    })

    await expect(
      callTauriSessionTabsRuntimeRpc('session.tabs.unsubscribe', {
        worktree: 'id:wt-1',
        subscriptionId: 'sub-1'
      })
    ).resolves.toEqual({ handled: true, result: { unsubscribed: true } })
  })

  it('rehydrates persisted tab layout on first access per worktree', async () => {
    mockRuntimeSessions([
      { id: 'sess-1', tabId: 'tab-1', leafId: 'leaf-1' },
      { id: 'sess-2', tabId: 'tab-2', leafId: 'leaf-2' }
    ])
    loadLayoutMock.mockResolvedValue({
      worktreeId: 'wt-1',
      activeTabId: 'tab-2',
      activeGroupId: 'main',
      tabGroups: [{ id: 'main', activeTabId: 'tab-2', tabOrder: ['tab-2', 'tab-1'] }],
      paneLayoutByTabId: {
        'tab-1': { root: { type: 'leaf', leafId: 'leaf-1' }, expandedLeafId: null }
      },
      tabPropsByTabId: { 'tab-1': { color: '#f97316', isPinned: true } },
      snapshotVersion: 7,
      updatedAt: '2026-01-01T00:00:00Z'
    })

    await expect(
      callTauriSessionTabsRuntimeRpc('session.tabs.list', { worktree: 'id:wt-1' })
    ).resolves.toMatchObject({
      handled: true,
      result: {
        activeTabId: 'tab-2',
        tabGroups: [{ id: 'main', activeTabId: 'tab-2', tabOrder: ['tab-2', 'tab-1'] }],
        tabs: [
          { parentTabId: 'tab-1', color: '#f97316', isPinned: true },
          { parentTabId: 'tab-2', isActive: true }
        ]
      }
    })
    expect(loadLayoutMock).toHaveBeenCalledWith('wt-1')

    // Second call reuses the rehydrated state — the snapshot loads once.
    await callTauriSessionTabsRuntimeRpc('session.tabs.list', { worktree: 'id:wt-1' })
    expect(loadLayoutMock).toHaveBeenCalledTimes(1)
  })

  it('ignores a corrupt persisted layout and falls back to live sessions', async () => {
    mockRuntimeSessions([{ id: 'sess-1', tabId: 'tab-1', leafId: 'leaf-1' }])
    loadLayoutMock.mockResolvedValue({
      worktreeId: 'wt-1',
      activeTabId: 42,
      tabGroups: [{ id: '', tabOrder: 'not-an-array' }],
      paneLayoutByTabId: { 'tab-1': { root: { type: 'split' } } },
      snapshotVersion: 'nope',
      updatedAt: ''
    })

    await expect(
      callTauriSessionTabsRuntimeRpc('session.tabs.list', { worktree: 'id:wt-1' })
    ).resolves.toMatchObject({
      handled: true,
      result: {
        activeTabId: 'tab-1',
        tabGroups: [{ id: 'main', tabOrder: ['tab-1'] }]
      }
    })
  })

  it('schedules a debounced layout write-back on session.tabs.move', async () => {
    mockRuntimeSessions([
      { id: 'sess-1', tabId: 'tab-1', leafId: 'leaf-1' },
      { id: 'sess-2', tabId: 'tab-2', leafId: 'leaf-2' }
    ])

    await callTauriSessionTabsRuntimeRpc('session.tabs.move', {
      worktree: 'id:wt-1',
      tabId: 'tab-2',
      targetGroupId: 'main',
      kind: 'reorder',
      tabOrder: ['tab-2', 'tab-1']
    })

    expect(scheduleLayoutSaveMock).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        activeTabId: 'tab-2',
        activeGroupId: 'main',
        tabGroups: [expect.objectContaining({ id: 'main', tabOrder: ['tab-2', 'tab-1'] })]
      })
    )
  })

  it('schedules layout write-backs for tab props, pane layout, and close', async () => {
    mockRuntimeSessions([{ id: 'sess-1', tabId: 'tab-1', leafId: 'leaf-1' }])

    await callTauriSessionTabsRuntimeRpc('session.tabs.setTabProps', {
      worktree: 'id:wt-1',
      tabId: 'tab-1',
      color: '#f97316'
    })
    expect(scheduleLayoutSaveMock).toHaveBeenLastCalledWith(
      'wt-1',
      expect.objectContaining({ tabPropsByTabId: { 'tab-1': { color: '#f97316' } } })
    )

    await callTauriSessionTabsRuntimeRpc('session.tabs.updatePaneLayout', {
      worktree: 'id:wt-1',
      tabId: 'tab-1',
      root: { type: 'leaf', leafId: 'leaf-1' },
      expandedLeafId: null
    })
    expect(scheduleLayoutSaveMock).toHaveBeenLastCalledWith(
      'wt-1',
      expect.objectContaining({
        paneLayoutByTabId: {
          'tab-1': { root: { type: 'leaf', leafId: 'leaf-1' }, expandedLeafId: null }
        }
      })
    )
  })

  it('closes the backing Go session for session.tabs.close', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/sessions' && options?.method === 'GET') {
          return [
            {
              id: 'sess-1',
              worktreeId: 'wt-1',
              cwd: '/repo/worktree',
              command: ['zsh'],
              tabId: 'tab-1',
              leafId: 'leaf-1',
              status: 'running'
            }
          ]
        }
        if (path === '/v1/sessions/sess-1' && options?.method === 'DELETE') {
          return {
            id: 'sess-1',
            worktreeId: 'wt-1',
            cwd: '/repo/worktree',
            command: ['zsh'],
            tabId: 'tab-1',
            leafId: 'leaf-1',
            status: 'stopped'
          }
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )

    await expect(
      callTauriSessionTabsRuntimeRpc('session.tabs.close', {
        worktree: 'id:wt-1',
        tabId: 'tab-1'
      })
    ).resolves.toMatchObject({
      handled: true,
      result: {
        worktree: 'wt-1',
        activeTabId: null,
        tabs: []
      }
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/sessions/sess-1', {
      method: 'DELETE'
    })
  })
})
