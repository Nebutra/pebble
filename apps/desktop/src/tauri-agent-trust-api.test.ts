import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, runtimeCallMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  runtimeCallMock: vi.fn()
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { createPebbleAgentTrustApi } from './tauri-agent-trust-api'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { call: runtimeCallMock } }
  })
})

describe('createPebbleAgentTrustApi', () => {
  it('routes local trust presets through the native command', async () => {
    invokeMock.mockResolvedValue(undefined)
    await createPebbleAgentTrustApi().markTrusted({
      preset: 'codex',
      workspacePath: '/tmp/pebble'
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_trust_mark_trusted', {
      input: { preset: 'codex', workspacePath: '/tmp/pebble' }
    })
  })

  it('writes remote trust through the paired runtime instead of local Rust', async () => {
    runtimeCallMock.mockResolvedValue({ ok: true, result: { trusted: true } })
    await createPebbleAgentTrustApi().markTrusted({
      preset: 'cursor',
      workspacePath: '/remote/worktree',
      connectionId: 'runtime-1'
    })
    expect(runtimeCallMock).toHaveBeenCalledWith({
      selector: 'runtime-1',
      method: 'agentTrust.markTrusted',
      params: { preset: 'cursor', workspacePath: '/remote/worktree' },
      timeoutMs: 15_000
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('surfaces remote trust failures without falling back to local HOME', async () => {
    runtimeCallMock.mockResolvedValue({
      ok: false,
      error: { code: 'agent_trust_failed', message: 'remote config is invalid' }
    })
    await expect(
      createPebbleAgentTrustApi().markTrusted({
        preset: 'copilot',
        workspacePath: '/remote/worktree',
        connectionId: 'runtime-1'
      })
    ).rejects.toThrow('remote config is invalid')
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
