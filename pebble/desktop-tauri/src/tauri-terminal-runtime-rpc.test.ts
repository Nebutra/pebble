import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestRuntimeJsonMock, getHostPlatformMock, readWorktreesMock } = vi.hoisted(() => ({
  requestRuntimeJsonMock: vi.fn(),
  getHostPlatformMock: vi.fn(),
  readWorktreesMock: vi.fn()
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock,
  getHostPlatform: getHostPlatformMock
}))

vi.mock('./pebble-tauri-workspace-runtime-api', () => ({
  readWorktrees: readWorktreesMock
}))

import { callTauriTerminalRuntimeRpc } from './tauri-terminal-runtime-rpc'

beforeEach(() => {
  vi.clearAllMocks()
  getHostPlatformMock.mockReturnValue('darwin')
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

describe('callTauriTerminalRuntimeRpc', () => {
  it('resolves the active terminal from live Go sessions for a worktree', async () => {
    requestRuntimeJsonMock.mockResolvedValue([
      {
        id: 'sess-old',
        worktreeId: 'wt-1',
        cwd: '/repo/worktree',
        command: ['zsh'],
        tabId: 'tab-1',
        status: 'running',
        updatedAt: '2026-07-08T10:00:00.000Z'
      },
      {
        id: 'sess-new',
        worktreeId: 'wt-1',
        cwd: '/repo/worktree',
        command: ['zsh'],
        tabId: 'tab-2',
        status: 'running',
        updatedAt: '2026-07-08T10:01:00.000Z'
      },
      {
        id: 'sess-other',
        worktreeId: 'wt-2',
        cwd: '/repo/other',
        command: ['zsh'],
        tabId: 'tab-3',
        status: 'running',
        updatedAt: '2026-07-08T10:02:00.000Z'
      }
    ])

    await expect(
      callTauriTerminalRuntimeRpc('terminal.resolveActive', { worktree: 'id:wt-1' })
    ).resolves.toEqual({
      handled: true,
      result: { handle: 'sess-new' }
    })
  })

  it('resolves a pane key to its backing runtime terminal handle', async () => {
    requestRuntimeJsonMock.mockResolvedValue([
      {
        id: 'sess-1',
        worktreeId: 'wt-1',
        cwd: '/repo/worktree',
        command: ['zsh'],
        tabId: 'tab-1',
        leafId: '11111111-1111-4111-8111-111111111111',
        status: 'running'
      }
    ])

    await expect(
      callTauriTerminalRuntimeRpc('terminal.resolvePane', {
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111'
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        terminal: {
          handle: 'sess-1',
          tabId: 'tab-1',
          leafId: '11111111-1111-4111-8111-111111111111',
          ptyId: 'sess-1'
        }
      }
    })
  })

  it('creates a real Go runtime session for terminal.create', async () => {
    requestRuntimeJsonMock.mockResolvedValue({
      id: 'sess-1',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      cwd: '/repo/worktree',
      command: ['/bin/sh', '-lc', 'npm test'],
      agentKind: 'codex',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      status: 'running'
    })

    await expect(
      callTauriTerminalRuntimeRpc('terminal.create', {
        worktree: 'id:wt-1',
        command: 'npm test',
        agent: 'codex',
        cols: 120,
        rows: 32
      })
    ).resolves.toMatchObject({
      handled: true,
      result: {
        terminal: {
          handle: 'sess-1',
          ptyId: 'sess-1',
          worktreeId: 'wt-1',
          title: '/bin/sh -lc npm test'
        }
      }
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/sessions', {
      method: 'POST',
      timeoutMs: 15_000,
      body: expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'wt-1',
        cwd: '/repo/worktree',
        command: ['/bin/sh', '-lc', 'npm test'],
        agentKind: 'codex',
        cols: 120,
        rows: 32
      })
    })
  })

  it('closes a runtime terminal session through the Go session endpoint', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === '/v1/sessions' && options?.method === 'GET') {
        return [
          {
            id: 'sess-1',
            worktreeId: 'wt-1',
            cwd: '/repo/worktree',
            command: ['zsh'],
            tabId: 'tab-1',
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
          status: 'stopped'
        }
      }
      throw new Error(`unexpected runtime request ${path}`)
    })

    await expect(
      callTauriTerminalRuntimeRpc('terminal.close', { terminal: 'sess-1' })
    ).resolves.toEqual({
      handled: true,
      result: {
        close: {
          handle: 'sess-1',
          tabId: 'tab-1',
          ptyKilled: true
        }
      }
    })
  })
})

function waitRuntimeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sess-1',
    worktreeId: 'wt-1',
    cwd: '/workspace/pebble',
    command: ['claude'],
    agentKind: 'claude',
    status: 'running',
    updatedAt: '2026-05-13T01:00:00Z',
    ...overrides
  }
}

describe('callTauriTerminalRuntimeRpc wait/agentStatus', () => {
  it('delegates terminal.wait to the runtime blocking wait route', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce({
      sessionId: 'sess-1',
      condition: 'tui-idle',
      satisfied: true,
      timedOut: false,
      status: 'running',
      hookAgentState: 'idle',
      exitCode: null
    })

    const result = await callTauriTerminalRuntimeRpc('terminal.wait', {
      terminal: 'sess-1',
      for: 'tui-idle',
      timeoutMs: 2000
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/sessions/sess-1/wait', {
      method: 'POST',
      body: { for: 'tui-idle', timeoutMs: 2000 },
      timeoutMs: 7000
    })
    expect(result).toEqual({
      handled: true,
      result: {
        wait: {
          handle: 'sess-1',
          condition: 'tui-idle',
          satisfied: true,
          status: 'running',
          exitCode: null
        }
      }
    })
  })

  it('reports exit-satisfied when the runtime no longer knows the session', async () => {
    requestRuntimeJsonMock.mockRejectedValueOnce(new Error('session not found'))

    const result = await callTauriTerminalRuntimeRpc('terminal.wait', {
      terminal: 'sess-gone',
      for: 'exit'
    })

    expect(result).toEqual({
      handled: true,
      result: {
        wait: {
          handle: 'sess-gone',
          condition: 'exit',
          satisfied: true,
          status: 'exited',
          exitCode: null
        }
      }
    })
  })

  it('never satisfies tui-idle for a session the runtime cannot resolve', async () => {
    requestRuntimeJsonMock.mockRejectedValueOnce(new Error('session not found'))

    const result = await callTauriTerminalRuntimeRpc('terminal.wait', {
      terminal: 'sess-gone',
      for: 'tui-idle'
    })

    expect(result).toMatchObject({
      handled: true,
      result: { wait: { satisfied: false, status: 'exited' } }
    })
  })

  it('surfaces hook-reported agent readiness on terminal.agentStatus', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce([
      waitRuntimeSession({ hookAgentState: 'permission' })
    ])

    const result = await callTauriTerminalRuntimeRpc('terminal.agentStatus', {
      terminal: 'sess-1'
    })

    expect(result).toEqual({
      handled: true,
      result: {
        agentStatus: { handle: 'sess-1', isRunningAgent: true, status: 'permission' }
      }
    })
  })

  it('assumes working for an agent PTY without hook events yet', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce([waitRuntimeSession()])

    const result = await callTauriTerminalRuntimeRpc('terminal.agentStatus', {
      terminal: 'sess-1'
    })

    expect(result).toMatchObject({
      handled: true,
      result: { agentStatus: { isRunningAgent: true, status: 'working' } }
    })
  })

  it('reports no agent status for a non-agent session', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce([
      waitRuntimeSession({ agentKind: '', hookAgentState: 'idle' })
    ])

    const result = await callTauriTerminalRuntimeRpc('terminal.agentStatus', {
      terminal: 'sess-1'
    })

    expect(result).toMatchObject({
      handled: true,
      result: { agentStatus: { isRunningAgent: false, status: null } }
    })
  })
})
