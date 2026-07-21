import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

import { createPebbleAgentHooksApi, reconcileTauriManagedAgentHooks } from './tauri-agent-hooks-api'
import type { AgentHookInstallStatus } from '../../../packages/product-core/shared/agent-hook-types'

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
      if (command === 'agent_hooks_gemini_status') {
        return {
          agent: 'gemini',
          state: 'installed',
          configPath: '/home/user/.gemini/settings.json',
          managedHooksPresent: true,
          detail: null
        }
      }
      if (command === 'agent_hooks_cursor_status') {
        return {
          agent: 'cursor',
          state: 'installed',
          configPath: '/home/user/.cursor/hooks.json',
          managedHooksPresent: true,
          detail: null
        }
      }
      if (command === 'agent_hooks_droid_status') {
        return {
          agent: 'droid',
          state: 'installed',
          configPath: '/home/user/.factory/settings.json',
          managedHooksPresent: true,
          detail: null
        }
      }
      if (command === 'agent_hooks_command_code_status') {
        return {
          agent: 'command-code',
          state: 'installed',
          configPath: '/home/user/.commandcode/settings.json',
          managedHooksPresent: true,
          detail: null
        }
      }
      if (command === 'agent_hooks_grok_status') {
        return {
          agent: 'grok',
          state: 'installed',
          configPath: '/home/user/.grok/hooks/pebble-status.json',
          managedHooksPresent: true,
          detail: null
        }
      }
      if (command === 'agent_hooks_devin_status') {
        return {
          agent: 'devin',
          state: 'installed',
          configPath: '/home/user/.config/devin/config.json',
          managedHooksPresent: true,
          detail: null
        }
      }
      if (command === 'agent_hooks_kimi_status') {
        return {
          agent: 'kimi',
          state: 'installed',
          configPath: '/home/user/.kimi-code/config.toml',
          managedHooksPresent: true,
          detail: null
        }
      }
      if (command === 'agent_hooks_amp_status') {
        return {
          agent: 'amp',
          state: 'installed',
          configPath: '/home/user/.config/amp/plugins/pebble-agent-status.ts',
          managedHooksPresent: true,
          detail: null
        }
      }
      if (command === 'agent_hooks_copilot_status') {
        return {
          agent: 'copilot',
          state: 'installed',
          configPath: '/home/user/.copilot/hooks/pebble.json',
          managedHooksPresent: true,
          detail: null
        }
      }
      if (command === 'agent_hooks_antigravity_status') {
        return {
          agent: 'antigravity',
          state: 'installed',
          configPath: '/home/user/.gemini/config/hooks.json',
          managedHooksPresent: true,
          detail: null
        }
      }
      if (command === 'agent_hooks_hermes_status') {
        return {
          agent: 'hermes',
          state: 'installed',
          configPath: '/home/user/.hermes/config.yaml',
          managedHooksPresent: true,
          detail: null
        }
      }
      if (command === 'agent_hooks_codex_status') {
        return {
          agent: 'codex',
          state: 'installed',
          configPath: '/home/user/codex-runtime-home/home/hooks.json',
          managedHooksPresent: true,
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
    await expect(api.geminiStatus()).resolves.toMatchObject({
      agent: 'gemini',
      state: 'installed'
    })
    await expect(api.cursorStatus()).resolves.toMatchObject({
      agent: 'cursor',
      state: 'installed'
    })
    await expect(api.droidStatus()).resolves.toMatchObject({
      agent: 'droid',
      state: 'installed'
    })
    await expect(api.commandCodeStatus()).resolves.toMatchObject({
      agent: 'command-code',
      state: 'installed'
    })
    await expect(api.grokStatus()).resolves.toMatchObject({
      agent: 'grok',
      state: 'installed'
    })
    await expect(api.devinStatus()).resolves.toMatchObject({
      agent: 'devin',
      state: 'installed'
    })
    await expect(api.kimiStatus()).resolves.toMatchObject({
      agent: 'kimi',
      state: 'installed'
    })
    await expect(api.ampStatus()).resolves.toMatchObject({
      agent: 'amp',
      state: 'installed'
    })
    await expect(api.copilotStatus()).resolves.toMatchObject({
      agent: 'copilot',
      state: 'installed'
    })
    await expect(api.antigravityStatus()).resolves.toMatchObject({
      agent: 'antigravity',
      state: 'installed'
    })
    await expect(api.hermesStatus()).resolves.toMatchObject({
      agent: 'hermes',
      state: 'installed'
    })
    await expect(api.codexStatus()).resolves.toMatchObject({
      agent: 'codex',
      state: 'installed'
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_claude_status')
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_openclaude_status')
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_gemini_status')
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_cursor_status')
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_droid_status')
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_command_code_status')
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_grok_status')
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_devin_status')
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_kimi_status')
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_amp_status')
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_copilot_status')
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_antigravity_status')
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_hermes_status')
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_codex_status')
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

  it('reports native inspection failures without claiming the agent is unsupported', async () => {
    invokeMock.mockRejectedValue(new Error('config permission denied'))
    const api = createPebbleAgentHooksApi(fallbackApi())

    await expect(api.codexStatus()).resolves.toMatchObject({
      agent: 'codex',
      state: 'error',
      managedHooksPresent: false,
      detail: expect.stringContaining('config permission denied')
    })
    const status = await api.codexStatus()
    expect(status.detail).not.toContain('not yet implemented')
  })

  it('reconciles Claude-compatible hooks through the native mutation command', async () => {
    invokeMock.mockResolvedValue([])

    await reconcileTauriManagedAgentHooks(false)

    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_apply_claude_compatible', {
      enabled: false
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_apply_gemini', {
      enabled: false
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_apply_cursor', {
      enabled: false
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_apply_droid', {
      enabled: false
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_apply_command_code', {
      enabled: false
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_apply_grok', {
      enabled: false
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_apply_devin', {
      enabled: false
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_apply_kimi', {
      enabled: false
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_apply_amp', {
      enabled: false
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_apply_copilot', {
      enabled: false
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_apply_antigravity', {
      enabled: false
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_apply_hermes', {
      enabled: false
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_hooks_apply_codex', {
      enabled: false
    })
  })
})
