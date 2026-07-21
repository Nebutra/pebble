// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, requestRuntimeJsonMock, ensureRuntimeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  requestRuntimeJsonMock: vi.fn(),
  ensureRuntimeMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('./pebble-runtime-http-bridge', () => ({
  hasTauriInternals: () => '__TAURI_INTERNALS__' in window,
  ensurePebbleRuntimeProcess: ensureRuntimeMock,
  requestRuntimeJson: requestRuntimeJsonMock
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
    invokeMock.mockReset()
    requestRuntimeJsonMock.mockReset()
    ensureRuntimeMock.mockReset().mockResolvedValue(undefined)
    if (!window.localStorage) {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: createMemoryStorage()
      })
    }
    window.localStorage.clear()
    Object.assign(window, {
      __TAURI_INTERNALS__: {},
      api: { rateLimits: { refresh: vi.fn().mockResolvedValue({}) } }
    })
  })

  it('creates an isolated Codex account and persists the selected identity', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'managed_codex_account_prepare') {
        return Promise.resolve({
          managedHomePath: '/managed/codex/account-1/home',
          managedHomeRuntime: 'host',
          wslDistro: null,
          wslLinuxHomePath: null
        })
      }
      if (command === 'managed_codex_account_identity') {
        return Promise.resolve({
          email: 'dev@example.com',
          accountId: 'provider-1',
          planType: 'team'
        })
      }
      return Promise.resolve(undefined)
    })
    requestRuntimeJsonMock
      .mockResolvedValueOnce({ id: 'login-1', status: 'running' })
      .mockResolvedValueOnce([{ id: 'login-1', status: 'exited', exitCode: 0 }])

    const state = await createPebbleCodexAccountsApi(codexBase()).add()

    expect(state.activeAccountId).toBe(state.accounts[0]?.id)
    expect(state.accounts[0]).toMatchObject({
      email: 'dev@example.com',
      providerAccountId: 'provider-1',
      managedHomeRuntime: 'host'
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/sessions',
      expect.objectContaining({
        body: expect.objectContaining({
          command: ['codex', 'login'],
          environment: ['CODEX_HOME=/managed/codex/account-1/home']
        })
      })
    )
  })

  it('rolls back the owned home when Codex login fails', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'managed_codex_account_prepare') {
        return Promise.resolve({
          managedHomePath: '/managed/codex/account-1/home',
          managedHomeRuntime: 'host',
          wslDistro: null,
          wslLinuxHomePath: null
        })
      }
      return Promise.resolve(undefined)
    })
    requestRuntimeJsonMock
      .mockResolvedValueOnce({ id: 'login-1', status: 'running' })
      .mockResolvedValueOnce([{ id: 'login-1', status: 'failed', exitCode: 1 }])
      .mockResolvedValueOnce([{ content: 'oauth denied' }])

    await expect(createPebbleCodexAccountsApi(codexBase()).add()).rejects.toThrow('oauth denied')
    expect(invokeMock).toHaveBeenCalledWith(
      'managed_codex_account_remove',
      expect.objectContaining({
        managedHomePath: '/managed/codex/account-1/home'
      })
    )
  })

  it('runs WSL login inside the selected distro with its isolated Linux home', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'managed_codex_account_prepare') {
        return Promise.resolve({
          managedHomePath:
            '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\share\\pebble\\codex-accounts\\account-1\\home',
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath: '/home/dev/.local/share/pebble/codex-accounts/account-1/home'
        })
      }
      if (command === 'managed_codex_account_identity') {
        return Promise.resolve({
          email: 'wsl@example.com',
          accountId: 'wsl-1',
          planType: 'plus'
        })
      }
      return Promise.resolve(undefined)
    })
    requestRuntimeJsonMock
      .mockResolvedValueOnce({ id: 'login-wsl', status: 'running' })
      .mockResolvedValueOnce([{ id: 'login-wsl', status: 'exited', exitCode: 0 }])
    const api = createPebbleCodexAccountsApi(codexBase())
    const state = await api.add({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    expect(state.accounts[0]).toMatchObject({
      email: 'wsl@example.com',
      managedHomeRuntime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/sessions',
      expect.objectContaining({
        body: expect.objectContaining({
          command: expect.arrayContaining([
            'wsl.exe',
            '-d',
            'Ubuntu',
            expect.stringContaining('exec codex login')
          ])
        })
      })
    )
  })

  it('captures a managed Claude login and materializes it only when selected', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'managed_claude_account_prepare') {
        return Promise.resolve({
          managedAuthPath: '/managed/claude/account-1/auth',
          managedAuthRuntime: 'host',
          wslDistro: null,
          wslLinuxAuthPath: null,
          temporaryConfigPath: '/tmp/pebble-claude-login/account-1'
        })
      }
      if (command === 'managed_claude_account_capture') {
        return Promise.resolve({
          email: 'claude@example.com',
          authMethod: 'subscription-oauth',
          organizationUuid: 'org-1',
          organizationName: 'Pebble Team'
        })
      }
      return Promise.resolve(undefined)
    })
    requestRuntimeJsonMock
      .mockResolvedValueOnce({ id: 'claude-login', status: 'running' })
      .mockResolvedValueOnce([{ id: 'claude-login', status: 'exited', exitCode: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ id: 'claude-status', status: 'running' })
      .mockResolvedValueOnce([{ id: 'claude-status', status: 'exited', exitCode: 0 }])
      .mockResolvedValueOnce([{ content: '{"email":"claude@example.com"}' }])

    const api = createPebbleClaudeAccountsApi(claudeBase())
    const added = await api.add()
    const accountId = added.accounts[0]?.id

    expect(added.accounts[0]).toMatchObject({
      email: 'claude@example.com',
      authMethod: 'subscription-oauth',
      organizationUuid: 'org-1'
    })
    expect(added.activeAccountId).toBeNull()
    await api.select({ accountId: accountId! })
    expect(invokeMock).toHaveBeenCalledWith('managed_claude_account_activate', {
      outgoingAccountId: null,
      accountId
    })

    invokeMock.mockClear()
    const runtimeRequestsBeforeSwitch = requestRuntimeJsonMock.mock.calls.length
    await expect(api.select({ accountId: null })).resolves.toMatchObject({
      activeAccountId: null
    })
    expect(invokeMock).toHaveBeenCalledWith('managed_claude_account_activate', {
      outgoingAccountId: accountId,
      accountId: null
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(runtimeRequestsBeforeSwitch)

    await api.select({ accountId: accountId! })
    requestRuntimeJsonMock.mockResolvedValueOnce([
      {
        id: 'live-claude',
        status: 'running',
        agentKind: 'claude',
        command: ['claude']
      }
    ])
    invokeMock.mockClear()
    await expect(api.remove({ accountId: accountId! })).rejects.toThrow(
      'Close running Claude terminals'
    )
    expect(invokeMock).not.toHaveBeenCalledWith('managed_claude_account_remove', expect.anything())
  })

  it('captures and selects a managed Claude account inside its WSL distro', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'managed_claude_account_prepare') {
        return Promise.resolve({
          managedAuthPath:
            '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\share\\pebble\\claude-accounts\\account-1\\auth',
          managedAuthRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxAuthPath: '/home/dev/.local/share/pebble/claude-accounts/account-1/auth',
          temporaryConfigPath: '/home/dev/.local/share/pebble/claude-accounts/account-1/login'
        })
      }
      if (command === 'managed_claude_account_capture') {
        return Promise.resolve({
          email: 'wsl-claude@example.com',
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null
        })
      }
      return Promise.resolve(undefined)
    })
    requestRuntimeJsonMock
      .mockResolvedValueOnce({ id: 'wsl-login', status: 'running' })
      .mockResolvedValueOnce([{ id: 'wsl-login', status: 'exited', exitCode: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ id: 'wsl-status', status: 'running' })
      .mockResolvedValueOnce([{ id: 'wsl-status', status: 'exited', exitCode: 0 }])
      .mockResolvedValueOnce([{ content: '{"email":"wsl-claude@example.com"}' }])
    const api = createPebbleClaudeAccountsApi(claudeBase())
    const added = await api.add({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    const accountId = added.accounts[0]?.id

    const loginRequest = requestRuntimeJsonMock.mock.calls[0]?.[1]?.body as {
      command: string[]
      environment?: string[]
    }
    expect(loginRequest.command.slice(0, 6)).toEqual([
      'wsl.exe',
      '-d',
      'Ubuntu',
      '--exec',
      'bash',
      '-lc'
    ])
    expect(loginRequest.command[6]).toContain('CLAUDE_CONFIG_DIR=')
    expect(loginRequest.environment).toBeUndefined()
    await api.select({
      accountId: accountId!,
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    const selected = await api.list()
    expect(selected.activeAccountIdsByRuntime?.wsl).toEqual({
      Ubuntu: accountId
    })
    expect(invokeMock).not.toHaveBeenCalledWith(
      'managed_claude_account_activate',
      expect.anything()
    )
  })

  it('falls back to the web base without Tauri internals', async () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    const base = claudeBase()
    const api = createPebbleClaudeAccountsApi(base)
    await expect(api.cancelPendingLogin()).resolves.toBe(true)
  })
})

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  }
}
