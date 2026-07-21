import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getRuntimeResourceJsonMock, requestRuntimeResourceJsonMock } = vi.hoisted(() => ({
  getRuntimeResourceJsonMock: vi.fn(),
  requestRuntimeResourceJsonMock: vi.fn()
}))

vi.mock('./runtime-bridge', () => ({
  createRuntimeResourceGetCommand: (input: unknown) => input,
  createRuntimeResourceRequestCommand: (input: unknown) => input,
  getRuntimeResourceJson: getRuntimeResourceJsonMock,
  requestRuntimeResourceJson: requestRuntimeResourceJsonMock,
  writeRuntimePtyInput: vi.fn()
}))

vi.mock('./tauri-accounts-api', () => ({
  hasSelectedTauriClaudeHostAccount: () => false,
  readSelectedTauriClaudeWslAuth: () => null,
  readSelectedTauriCodexHome: () => null,
  readSelectedTauriCodexWslHome: () => null
}))

vi.mock('./tauri-agent-status-api', () => ({
  markRuntimeAgentSessionStopped: vi.fn(),
  recordRuntimeAgentSessionSpawn: vi.fn()
}))

vi.mock('./tauri-runtime-pty-events', () => ({
  addRuntimePtyDataListener: vi.fn(),
  addRuntimePtyExitListener: vi.fn(),
  addRuntimePtyReplayListener: vi.fn(),
  configureRuntimePtyEventExit: vi.fn(),
  ensureRuntimePtyEventDelivery: vi.fn(),
  reportRuntimePtyUnavailable: vi.fn()
}))

import { installTauriRuntimePtyApi } from './tauri-runtime-pty-api'

describe('Tauri runtime PTY inspection', () => {
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

  it('reads foreground and child-process state from one runtime status probe', async () => {
    getRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify({
        id: 'sess-inspect',
        foregroundProcess: 'codex',
        hasChildProcesses: true
      })
    })
    installTauriRuntimePtyApi()

    await expect(
      Promise.all([
        window.api.pty.getForegroundProcess('sess-inspect'),
        window.api.pty.hasChildProcesses('sess-inspect')
      ])
    ).resolves.toEqual(['codex', true])
    expect(getRuntimeResourceJsonMock).toHaveBeenCalledTimes(1)
    expect(getRuntimeResourceJsonMock).toHaveBeenCalledWith({
      path: '/v1/sessions/sess-inspect/status',
      timeoutMs: 5000
    })
  })

  it('preserves non-throwing inspection fallbacks for an expired PTY', async () => {
    getRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 404,
      body: JSON.stringify({ error: 'session not found' })
    })
    installTauriRuntimePtyApi()

    await expect(
      Promise.all([
        window.api.pty.getForegroundProcess('sess-expired'),
        window.api.pty.hasChildProcesses('sess-expired')
      ])
    ).resolves.toEqual([null, false])
    expect(getRuntimeResourceJsonMock).toHaveBeenCalledTimes(1)
  })

  it('does not fabricate a cwd for an expired PTY', async () => {
    getRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 404,
      body: JSON.stringify({ error: 'session not found' })
    })
    installTauriRuntimePtyApi()

    await expect(window.api.pty.getCwd('sess-expired')).resolves.toBe('')
  })

  it('routes PTY signals through the runtime session endpoint', async () => {
    requestRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify({ status: 'accepted' })
    })
    installTauriRuntimePtyApi()

    window.api.pty.signal('sess-signal', 'SIGWINCH')

    await vi.waitFor(() => {
      expect(requestRuntimeResourceJsonMock).toHaveBeenCalledWith({
        method: 'POST',
        path: '/v1/sessions/sess-signal/signal',
        bodyJson: JSON.stringify({ signal: 'SIGWINCH' }),
        timeoutMs: 1500
      })
    })
  })
})
