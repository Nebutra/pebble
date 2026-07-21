import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  configureRuntimePtyEventExitMock,
  getRuntimeResourceJsonMock,
  reportRuntimePtyUnavailableMock,
  requestRuntimeResourceJsonMock,
  stopRuntimeProcessMock,
  writeRuntimePtyInputMock
} = vi.hoisted(() => ({
  configureRuntimePtyEventExitMock: vi.fn(),
  getRuntimeResourceJsonMock: vi.fn(),
  reportRuntimePtyUnavailableMock: vi.fn(),
  requestRuntimeResourceJsonMock: vi.fn(),
  stopRuntimeProcessMock: vi.fn(),
  writeRuntimePtyInputMock: vi.fn()
}))

const { readSelectedClaudeWslAuthMock } = vi.hoisted(() => ({
  readSelectedClaudeWslAuthMock: vi.fn()
}))

vi.mock('./tauri-accounts-api', () => ({
  hasSelectedTauriClaudeHostAccount: () => false,
  readSelectedTauriClaudeWslAuth: readSelectedClaudeWslAuthMock,
  readSelectedTauriCodexHome: () => null,
  readSelectedTauriCodexWslHome: () => null
}))

vi.mock('./runtime-bridge', () => ({
  createRuntimeResourceGetCommand: (input: unknown) => input,
  createRuntimeResourceRequestCommand: (input: unknown) => input,
  getRuntimeResourceJson: getRuntimeResourceJsonMock,
  requestRuntimeResourceJson: requestRuntimeResourceJsonMock,
  stopRuntimeProcess: stopRuntimeProcessMock,
  writeRuntimePtyInput: writeRuntimePtyInputMock
}))

const { ensurePebbleRuntimeProcessMock } = vi.hoisted(() => ({
  ensurePebbleRuntimeProcessMock: vi.fn()
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: ensurePebbleRuntimeProcessMock
}))

vi.mock('./tauri-agent-status-api', () => ({
  markRuntimeAgentSessionStopped: vi.fn(),
  recordRuntimeAgentSessionSpawn: vi.fn()
}))

vi.mock('./tauri-runtime-pty-events', () => ({
  addRuntimePtyDataListener: vi.fn(),
  addRuntimePtyExitListener: vi.fn(),
  addRuntimePtyReplayListener: vi.fn(),
  configureRuntimePtyEventExit: configureRuntimePtyEventExitMock,
  ensureRuntimePtyEventDelivery: vi.fn(),
  reportRuntimePtyUnavailable: reportRuntimePtyUnavailableMock
}))

import { installTauriRuntimePtyApi } from './tauri-runtime-pty-api'

describe('installTauriRuntimePtyApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.window = {
      __TAURI_INTERNALS__: {},
      api: {
        pty: {},
        worktrees: { listAll: vi.fn().mockResolvedValue([]) }
      }
    } as unknown as Window & typeof globalThis
  })

  it('maps pty session lists from runtime sessions', async () => {
    getRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify([
        {
          id: 'sess-1',
          projectId: 'project-1',
          cwd: '/workspace/app',
          command: ['zsh']
        }
      ])
    })

    installTauriRuntimePtyApi()

    await expect(window.api.pty.listSessions()).resolves.toEqual([
      {
        id: 'sess-1',
        cwd: '/workspace/app',
        title: 'zsh'
      }
    ])
    expect(getRuntimeResourceJsonMock).toHaveBeenCalledWith({
      path: '/v1/sessions',
      timeoutMs: 1500
    })
  })

  it('propagates session list runtime failures instead of returning fake empty terminals', async () => {
    getRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'disconnected',
      httpStatus: null,
      error: 'terminal runtime unavailable',
      body: null
    })

    installTauriRuntimePtyApi()

    await expect(window.api.pty.listSessions()).rejects.toThrow('terminal runtime unavailable')
  })

  it('backs PTY management with native runtime sessions and termination', async () => {
    getRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify([
        {
          id: 'sess-managed',
          status: 'running',
          cwd: '/workspace/app',
          cols: 120,
          rows: 40,
          pid: 4242,
          startedAt: '2026-07-18T01:02:03.000Z'
        }
      ])
    })
    requestRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify({ id: 'sess-managed', status: 'stopped' })
    })
    installTauriRuntimePtyApi()

    await expect(window.api.pty.management.listSessions()).resolves.toEqual({
      sessions: [
        {
          sessionId: 'sess-managed',
          state: 'running',
          shellState: 'ready',
          isAlive: true,
          pid: 4242,
          cwd: '/workspace/app',
          cols: 120,
          rows: 40,
          createdAt: Date.parse('2026-07-18T01:02:03.000Z'),
          protocolVersion: 1
        }
      ],
      degraded: false
    })
    await expect(window.api.pty.management.killOne({ sessionId: 'sess-managed' })).resolves.toEqual(
      { success: true }
    )
    expect(requestRuntimeResourceJsonMock).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/v1/sessions/sess-managed',
      bodyJson: null,
      timeoutMs: 1500
    })
  })

  it('restarts the Rust-managed runtime process', async () => {
    stopRuntimeProcessMock.mockResolvedValue({ running: false })
    getRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'disconnected',
      httpStatus: null,
      body: null
    })
    ensurePebbleRuntimeProcessMock.mockResolvedValue(undefined)
    installTauriRuntimePtyApi()

    await expect(window.api.pty.management.restart()).resolves.toEqual({ success: true })
    expect(stopRuntimeProcessMock).toHaveBeenCalledOnce()
    expect(ensurePebbleRuntimeProcessMock).toHaveBeenCalledOnce()
  })

  it('sends terminal input through the native keep-alive data plane', async () => {
    vi.useFakeTimers()
    writeRuntimePtyInputMock.mockResolvedValue(true)
    installTauriRuntimePtyApi()

    const accepted = window.api.pty.writeAccepted('sess-input', 'pebble')
    await vi.advanceTimersByTimeAsync(4)

    await expect(accepted).resolves.toBe(true)
    expect(writeRuntimePtyInputMock).toHaveBeenCalledWith('sess-input', 'pebble')
    vi.useRealTimers()
  })

  it('spawns branded setup terminals as projectless ephemeral sessions', async () => {
    requestRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 201,
      body: JSON.stringify({
        id: 'sess-setup',
        projectId: '',
        cwd: '/Users/test',
        command: ['/bin/sh']
      })
    })

    installTauriRuntimePtyApi()

    await expect(
      window.api.pty.spawn({
        cwd: '/Users/test',
        worktreeId: 'ephemeral-setup-terminal:computer-use',
        cols: 80,
        rows: 24
      })
    ).resolves.toMatchObject({ id: 'sess-setup' })

    const command = requestRuntimeResourceJsonMock.mock.calls[0]?.[0] as {
      bodyJson: string
    }
    expect(JSON.parse(command.bodyJson)).toMatchObject({
      projectId: '',
      ephemeral: true,
      cwd: '/Users/test'
    })
    expect(JSON.parse(command.bodyJson)).not.toHaveProperty('worktreeId')
  })

  it('starts resolved WSL projects inside the distro and performs Linux-side cwd', async () => {
    vi.mocked(window.api.worktrees.listAll).mockResolvedValue([
      {
        id: 'worktree-wsl',
        projectId: 'project-wsl',
        path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
      }
    ] as never)
    requestRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 201,
      body: JSON.stringify({
        id: 'sess-wsl',
        projectId: 'project-wsl',
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
        command: ['wsl.exe']
      })
    })

    installTauriRuntimePtyApi()
    await window.api.pty.spawn({
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
      worktreeId: 'worktree-wsl',
      command: 'codex',
      launchAgent: 'codex',
      cols: 100,
      rows: 30,
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'project-wsl',
          distro: 'Ubuntu',
          reason: 'project-override',
          cacheKey: 'wsl:Ubuntu'
        }
      }
    })

    const request = requestRuntimeResourceJsonMock.mock.calls[0]?.[0] as {
      bodyJson: string
    }
    const body = JSON.parse(request.bodyJson) as {
      command: string[]
      environment?: string[]
    }
    expect(body.command.slice(0, 2)).toEqual(['/bin/bash', '-lc'])
    expect(body.command[2]).toContain('exec codex')
    expect(body.command.join(' ')).not.toContain('wsl.exe')
    expect(body).not.toHaveProperty('environment')
  })

  it('routes WSL Claude terminals through the selected managed config directory', async () => {
    readSelectedClaudeWslAuthMock.mockReturnValue(
      '/home/dev/.local/share/pebble/claude-accounts/account-1/auth'
    )
    vi.mocked(window.api.worktrees.listAll).mockResolvedValue([
      {
        id: 'worktree-claude-wsl',
        projectId: 'project-claude-wsl',
        path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
      }
    ] as never)
    requestRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 201,
      body: JSON.stringify({
        id: 'sess-claude-wsl',
        projectId: 'project-claude-wsl',
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
        command: ['wsl.exe']
      })
    })

    installTauriRuntimePtyApi()
    await window.api.pty.spawn({
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
      worktreeId: 'worktree-claude-wsl',
      command: 'claude',
      launchAgent: 'claude',
      env: { ANTHROPIC_API_KEY: 'must-not-leak' },
      cols: 100,
      rows: 30,
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'project-claude-wsl',
          distro: 'Ubuntu',
          reason: 'project-override',
          cacheKey: 'wsl:Ubuntu'
        }
      }
    })

    const request = requestRuntimeResourceJsonMock.mock.calls[0]?.[0] as {
      bodyJson: string
    }
    const body = JSON.parse(request.bodyJson) as { command: string[] }
    expect(body.command[2]).toContain(
      "export CLAUDE_CONFIG_DIR='/home/dev/.local/share/pebble/claude-accounts/account-1/auth'"
    )
    expect(body.command[2]).not.toContain('ANTHROPIC_API_KEY')
    expect(body.command[2]).toContain('exec claude')
  })

  it('retries a cold runtime and returns prompt output as spawn replay', async () => {
    vi.useFakeTimers()
    requestRuntimeResourceJsonMock
      .mockResolvedValueOnce({
        transport: 'disconnected',
        httpStatus: null,
        error: 'runtime transport failed: starting',
        body: null
      })
      .mockResolvedValueOnce({
        transport: 'connected',
        httpStatus: 201,
        body: JSON.stringify({
          id: 'sess-retry',
          projectId: '',
          cwd: '/Users/test',
          command: ['/bin/sh']
        })
      })
    getRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify({ chunks: [{ stream: 'stdout', content: '$ ' }] })
    })

    installTauriRuntimePtyApi()
    const spawned = window.api.pty.spawn({
      cwd: '/Users/test',
      worktreeId: 'ephemeral-setup-terminal:orchestration',
      cols: 80,
      rows: 24
    })
    await vi.advanceTimersByTimeAsync(500)

    await expect(spawned).resolves.toMatchObject({
      id: 'sess-retry',
      replay: '$ '
    })
    expect(requestRuntimeResourceJsonMock).toHaveBeenCalledTimes(2)
    expect(getRuntimeResourceJsonMock).toHaveBeenCalledWith({
      path: '/v1/sessions/sess-retry/tail?limit=200',
      timeoutMs: 5000
    })
    vi.useRealTimers()
  })

  it('waits for the real shell prompt after a transient zsh clear sequence', async () => {
    vi.useFakeTimers()
    requestRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 201,
      body: JSON.stringify({
        id: 'sess-zsh',
        projectId: '',
        cwd: '/Users/test',
        command: ['zsh']
      })
    })
    getRuntimeResourceJsonMock
      .mockResolvedValueOnce({
        transport: 'connected',
        httpStatus: 200,
        body: JSON.stringify({
          chunks: [{ stream: 'stdout', content: '\u001b[1m%\r \r' }]
        })
      })
      .mockResolvedValue({
        transport: 'connected',
        httpStatus: 200,
        body: JSON.stringify({
          chunks: [
            { stream: 'stdout', content: '\u001b[1m%\r \r' },
            { stream: 'stdout', content: '\r\npebble\r\n❯ ' }
          ]
        })
      })

    installTauriRuntimePtyApi()
    const spawned = window.api.pty.spawn({
      cwd: '/Users/test',
      worktreeId: 'ephemeral-setup-terminal:computer-use',
      cols: 80,
      rows: 24
    })
    await vi.advanceTimersByTimeAsync(500)

    await expect(spawned).resolves.toMatchObject({
      id: 'sess-zsh',
      replay: expect.stringContaining('❯ ')
    })
    expect(getRuntimeResourceJsonMock.mock.calls.length).toBeGreaterThanOrEqual(5)
    vi.useRealTimers()
  })

  it('reports a stopped PTY when native exit delivery was missed', async () => {
    vi.useFakeTimers()
    requestRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 201,
      body: JSON.stringify({
        id: 'sess-stopped',
        projectId: '',
        cwd: '/Users/test',
        command: ['zsh'],
        status: 'running'
      })
    })
    getRuntimeResourceJsonMock.mockImplementation(async (command: { path: string }) => {
      if (command.path.includes('/tail?')) {
        return {
          transport: 'connected',
          httpStatus: 200,
          body: JSON.stringify({
            chunks: [{ stream: 'stdout', content: '$ ' }]
          })
        }
      }
      if (command.path === '/v1/sessions') {
        return {
          transport: 'connected',
          httpStatus: 200,
          body: JSON.stringify([{ id: 'sess-stopped', status: 'stopped' }])
        }
      }
      throw new Error(`unexpected runtime request ${command.path}`)
    })

    installTauriRuntimePtyApi()
    const spawned = window.api.pty.spawn({
      cwd: '/Users/test',
      worktreeId: 'ephemeral-setup-terminal:computer-use',
      cols: 80,
      rows: 24
    })
    await vi.advanceTimersByTimeAsync(1_600)
    await spawned

    expect(reportRuntimePtyUnavailableMock).toHaveBeenCalledWith('sess-stopped', 'stopped')
    vi.useRealTimers()
  })
})
