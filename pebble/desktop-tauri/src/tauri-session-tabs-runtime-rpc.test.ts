import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestRuntimeJsonMock, readWorktreesMock } = vi.hoisted(() => ({
  requestRuntimeJsonMock: vi.fn(),
  readWorktreesMock: vi.fn()
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock,
  getHostPlatform: () => 'darwin'
}))

vi.mock('./pebble-tauri-workspace-runtime-api', () => ({
  readWorktrees: readWorktreesMock
}))

import {
  callTauriSessionTabsRuntimeRpc,
  clearTauriSessionTabViewStateForTests
} from './tauri-session-tabs-runtime-rpc'

beforeEach(() => {
  vi.clearAllMocks()
  clearTauriSessionTabViewStateForTests()
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
