import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

import { createPebbleAgentHooksApi } from './tauri-agent-hooks-api'
import type { AgentHookInstallStatus } from '../../../src/shared/agent-hook-types'

function fallbackStatus(agent: AgentHookInstallStatus['agent']): AgentHookInstallStatus {
  return {
    agent,
    state: 'not_installed' as const,
    configPath: '',
    managedHooksPresent: false,
    detail: 'fallback'
  }
}

function fallbackApi(): Parameters<typeof createPebbleAgentHooksApi>[0] {
  return {
    claudeStatus: () => Promise.resolve(fallbackStatus('claude')),
    openClaudeStatus: () => Promise.resolve(fallbackStatus('openclaude')),
    codexStatus: () => Promise.resolve(fallbackStatus('codex')),
    geminiStatus: () => Promise.resolve(fallbackStatus('gemini')),
    antigravityStatus: () => Promise.resolve(fallbackStatus('antigravity')),
    ampStatus: () => Promise.resolve(fallbackStatus('amp')),
    cursorStatus: () => Promise.resolve(fallbackStatus('cursor')),
    droidStatus: () => Promise.resolve(fallbackStatus('droid')),
    commandCodeStatus: () => Promise.resolve(fallbackStatus('command-code')),
    grokStatus: () => Promise.resolve(fallbackStatus('grok')),
    copilotStatus: () => Promise.resolve(fallbackStatus('copilot')),
    hermesStatus: () => Promise.resolve(fallbackStatus('hermes')),
    devinStatus: () => Promise.resolve(fallbackStatus('devin')),
    kimiStatus: () => Promise.resolve(fallbackStatus('kimi'))
  }
}

describe('createPebbleAgentHooksApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.window = { __TAURI_INTERNALS__: {} } as unknown as Window & typeof globalThis
  })

  it('routes claude and openclaude status through the Rust command', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'agent_hooks_claude_status') {
        return {
          agent: 'claude',
          state: 'installed',
          configPath: '/home/user/.claude/settings.json',
          managedHooksPresent: true,
          detail: null
        }
      }
      if (command === 'agent_hooks_openclaude_status') {
        return {
          agent: 'openclaude',
          state: 'not_installed',
          configPath: '/home/user/.openclaude/settings.json',
          managedHooksPresent: false,
          detail: null
        }
      }
      throw new Error(`unexpected invoke ${command}`)
    })

    const api = createPebbleAgentHooksApi(fallbackApi())

    await expect(api.claudeStatus()).resolves.toMatchObject({
      agent: 'claude',
      state: 'installed',
      managedHooksPresent: true
    })
    await expect(api.openClaudeStatus()).resolves.toMatchObject({
      agent: 'openclaude',
      state: 'not_installed'
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_claude_status')
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_openclaude_status')
  })

  it('reports an explicit gap for agents without a native status check', async () => {
    const api = createPebbleAgentHooksApi(fallbackApi())

    const status = await api.cursorStatus()
    expect(status.agent).toBe('cursor')
    expect(status.state).toBe('error')
    expect(status.detail).toMatch(/not yet implemented/)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('reports an explicit gap for kimi status', async () => {
    const api = createPebbleAgentHooksApi(fallbackApi())

    const status = await api.kimiStatus()
    expect(status.agent).toBe('kimi')
    expect(status.state).toBe('error')
    expect(status.detail).toMatch(/not yet implemented/)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('falls back to the web preload status when Tauri internals are unavailable', async () => {
    globalThis.window = {} as unknown as Window & typeof globalThis
    const claudeStatus = vi.fn(() => Promise.resolve(fallbackStatus('claude')))
    const api = createPebbleAgentHooksApi({
      ...fallbackApi(),
      claudeStatus
    })

    await api.claudeStatus()
    expect(claudeStatus).toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
