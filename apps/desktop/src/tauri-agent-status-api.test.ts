// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getRuntimeResourceJsonMock, invokeMock } = vi.hoisted(() => ({
  getRuntimeResourceJsonMock: vi.fn(),
  invokeMock: vi.fn(() => Promise.resolve(null))
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

vi.mock('./runtime-bridge', () => ({
  createRuntimeResourceGetCommand: (input: unknown) => input,
  getRuntimeResourceJson: getRuntimeResourceJsonMock
}))

import {
  emitRuntimeAgentSessionStatus,
  installTauriAgentStatusApi,
  type TauriRuntimeAgentSession
} from './tauri-agent-status-api'

function session(overrides: Partial<TauriRuntimeAgentSession> = {}): TauriRuntimeAgentSession {
  return {
    id: 'session-1',
    status: 'running',
    agentKind: 'codex',
    tabId: 'tab-1',
    leafId: '11111111-1111-4111-8111-111111111111',
    prompt: 'Implement the feature',
    updatedAt: '2026-07-08T10:00:00.000Z',
    ...overrides
  }
}

function installApi(): void {
  ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    agentStatus: {}
  }
  installTauriAgentStatusApi()
  window.api.agentStatus.drop('tab-failed:22222222-2222-4222-8222-222222222222')
  window.api.agentStatus.drop('tab-stopped:33333333-3333-4333-8333-333333333333')
}

describe('installTauriAgentStatusApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invokeMock.mockResolvedValue(null)
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    delete (window as unknown as { api?: unknown }).api
  })

  it('maps failed runtime session snapshots to blocked agent status', async () => {
    installApi()
    getRuntimeResourceJsonMock.mockResolvedValue({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify([
        session({
          id: 'session-failed',
          status: 'failed',
          tabId: 'tab-failed',
          leafId: '22222222-2222-4222-8222-222222222222'
        })
      ])
    })

    await expect(window.api.agentStatus.getSnapshot()).resolves.toEqual([
      expect.objectContaining({
        state: 'blocked',
        agentType: 'codex',
        paneKey: 'tab-failed:22222222-2222-4222-8222-222222222222'
      })
    ])
  })

  it('propagates runtime session snapshot failures instead of returning fake empty status', async () => {
    installApi()
    getRuntimeResourceJsonMock.mockResolvedValue({
      transport: 'disconnected',
      httpStatus: null,
      error: 'agent session runtime unavailable',
      body: null
    })

    await expect(window.api.agentStatus.getSnapshot()).rejects.toThrow(
      'agent session runtime unavailable'
    )
  })

  it('preserves stopped runtime sessions as interrupted done status', () => {
    installApi()
    const events: unknown[] = []
    window.api.agentStatus.onSet((event) => {
      events.push(event)
    })

    emitRuntimeAgentSessionStatus(
      session({
        id: 'session-stopped',
        status: 'stopped',
        tabId: 'tab-stopped',
        leafId: '33333333-3333-4333-8333-333333333333'
      })
    )

    expect(events).toEqual([
      expect.objectContaining({
        state: 'done',
        interrupted: true,
        paneKey: 'tab-stopped:33333333-3333-4333-8333-333333333333'
      })
    ])
  })

  it('surfaces and clears legacy numeric pane sessions instead of dropping them', async () => {
    installApi()
    const unsupportedEvents: unknown[] = []
    const clearEvents: unknown[] = []
    window.api.agentStatus.onMigrationUnsupported((entry) => unsupportedEvents.push(entry))
    window.api.agentStatus.onMigrationUnsupportedClear((entry) => clearEvents.push(entry))
    getRuntimeResourceJsonMock.mockResolvedValue({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify([session({ id: 'legacy-pty', tabId: 'legacy-tab', leafId: '42' })])
    })

    await expect(window.api.agentStatus.getSnapshot()).resolves.toEqual([])
    expect(unsupportedEvents).toEqual([
      expect.objectContaining({
        ptyId: 'legacy-pty',
        paneKey: 'legacy-tab:42',
        reason: 'legacy-numeric-pane-key',
        source: 'local'
      })
    ])
    await expect(window.api.agentStatus.getMigrationUnsupportedSnapshot()).resolves.toEqual(
      unsupportedEvents
    )

    window.api.agentStatus.dropByTabPrefix('legacy-tab')
    expect(clearEvents).toEqual([{ ptyId: 'legacy-pty' }])
    await expect(window.api.agentStatus.getMigrationUnsupportedSnapshot()).resolves.toEqual([])
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('write_settings_document', {
        name: 'agent-migration-unsupported',
        contents: '[]'
      })
    })
  })
})
