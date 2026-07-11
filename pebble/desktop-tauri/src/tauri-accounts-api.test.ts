import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

import { createPebbleClaudeAccountsApi, createPebbleCodexAccountsApi } from './tauri-accounts-api'

const emptyState = {
  accounts: [],
  activeAccountId: null,
  activeAccountIdsByRuntime: { host: null, wsl: {} }
}

function codexBase(): Parameters<typeof createPebbleCodexAccountsApi>[0] {
  return {
    list: () => Promise.resolve(emptyState),
    add: () => Promise.resolve(emptyState),
    reauthenticate: () => Promise.resolve(emptyState),
    remove: () => Promise.resolve(emptyState),
    select: () => Promise.resolve(emptyState)
  }
}

function claudeBase(): Parameters<typeof createPebbleClaudeAccountsApi>[0] {
  // Not spread from codexBase(): the Claude state carries per-account
  // authMethod, so its base functions must be typed against the Claude shape.
  return {
    list: () => Promise.resolve(emptyState),
    add: () => Promise.resolve(emptyState),
    reauthenticate: () => Promise.resolve(emptyState),
    remove: () => Promise.resolve(emptyState),
    select: () => Promise.resolve(emptyState),
    cancelPendingLogin: () => Promise.resolve(true)
  }
}

describe('tauri accounts bridges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.window = { __TAURI_INTERNALS__: {} } as unknown as Window & typeof globalThis
  })

  it('list stays on the honest empty managed-account state', async () => {
    const api = createPebbleCodexAccountsApi(codexBase())
    await expect(api.list()).resolves.toEqual(emptyState)
  })

  it('add rejects with an explicit interactive-login gap enriched by host auth', async () => {
    invokeMock.mockResolvedValue({
      codex: { authenticated: true, email: 'dev@example.com' },
      claude: { authenticated: false, email: null }
    })
    const api = createPebbleCodexAccountsApi(codexBase())
    await expect(api.add()).rejects.toThrow(/interactive CLI OAuth login/)
    await expect(api.add()).rejects.toThrow(/dev@example\.com/)
    expect(invokeMock).toHaveBeenCalledWith('agent_account_auth_status')
  })

  it('add gap message survives a failing auth probe', async () => {
    invokeMock.mockRejectedValue(new Error('probe down'))
    const api = createPebbleClaudeAccountsApi(claudeBase())
    await expect(api.add()).rejects.toThrow(/interactive CLI OAuth login/)
  })

  it('select(null) is a real no-op while select(id)/remove match Electron unknown-id errors', async () => {
    const api = createPebbleClaudeAccountsApi(claudeBase())
    await expect(api.select({ accountId: null })).resolves.toEqual(emptyState)
    await expect(api.select({ accountId: 'abc' })).rejects.toThrow(/no longer exists/)
    await expect(api.remove({ accountId: 'abc' })).rejects.toThrow(/no longer exists/)
  })

  it('cancelPendingLogin reports false because add never starts a login', async () => {
    const api = createPebbleClaudeAccountsApi(claudeBase())
    await expect(api.cancelPendingLogin()).resolves.toBe(false)
  })

  it('falls back to the web base without Tauri internals', async () => {
    globalThis.window = {} as unknown as Window & typeof globalThis
    const base = claudeBase()
    const api = createPebbleClaudeAccountsApi(base)
    await expect(api.cancelPendingLogin()).resolves.toBe(true)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
