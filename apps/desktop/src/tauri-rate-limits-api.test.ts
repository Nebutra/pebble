import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  invokeMock,
  activeAccountIdsMock,
  claudeAccountsMock,
  codexAccountsMock,
  selectedClaudeWslAccountMock
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  activeAccountIdsMock: vi.fn(() => ({
    claude: new Set<string>(),
    codex: new Set<string>()
  })),
  claudeAccountsMock: vi.fn(() => []),
  codexAccountsMock: vi.fn(() => []),
  selectedClaudeWslAccountMock: vi.fn(
    (): { accountId: string; managedAuthPath: string } | null => null
  )
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

vi.mock('./tauri-accounts-api', () => ({
  readSelectedTauriCodexHome: () => null,
  readSelectedTauriCodexWslHome: () => null,
  readSelectedTauriClaudeWslAccount: selectedClaudeWslAccountMock,
  readTauriActiveManagedAccountIds: activeAccountIdsMock,
  readTauriClaudeManagedAccounts: claudeAccountsMock,
  readTauriCodexManagedAccounts: codexAccountsMock
}))

import { createPebbleRateLimitsApi } from './tauri-rate-limits-api'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../packages/product-core/shared/rate-limit-types'

function emptyState(): RateLimitState {
  return {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    minimax: null,
    minimaxCookieConfigured: false,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

function baseApi(): Parameters<typeof createPebbleRateLimitsApi>[0] {
  const state = emptyState()
  return {
    get: () => Promise.resolve(state),
    refresh: () => Promise.resolve(state),
    refreshCodexForTarget: () => Promise.resolve(state),
    consumeCodexResetCredit: () => Promise.resolve({ outcome: 'noCredit', state }),
    refreshClaudeForTarget: () => Promise.resolve(state),
    setPollingInterval: () => Promise.resolve(),
    fetchInactiveClaudeAccounts: () => Promise.resolve(),
    fetchInactiveCodexAccounts: () => Promise.resolve(),
    refreshMiniMax: () => Promise.resolve(state),
    onUpdate: () => () => {}
  }
}

function rustClaudeResult(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: {
      usedPercent: 40,
      windowMinutes: 300,
      resetsAt: 1760000000000,
      resetDescription: null
    },
    weekly: null,
    fableWeekly: null,
    updatedAt: 1750000000000,
    error: null,
    status: 'ok'
  }
}

function rustCodexResult(): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: {
      usedPercent: 90,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null
    },
    updatedAt: 1750000000000,
    error: null,
    status: 'ok'
  }
}

function rustKimiResult(): ProviderRateLimits {
  return {
    provider: 'kimi',
    session: {
      usedPercent: 60,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: {
      usedPercent: 25,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null
    },
    updatedAt: 1750000000000,
    error: null,
    status: 'ok'
  }
}

function rustOpenCodeResult(): ProviderRateLimits {
  return {
    provider: 'opencode-go',
    session: {
      usedPercent: 30,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: {
      usedPercent: 51,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null
    },
    monthly: {
      usedPercent: 89,
      windowMinutes: 43200,
      resetsAt: null,
      resetDescription: null
    },
    updatedAt: 1750000000000,
    error: null,
    status: 'ok'
  }
}

function rustMiniMaxResult(): ProviderRateLimits {
  return {
    provider: 'minimax',
    session: {
      usedPercent: 65,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: null,
    updatedAt: 1750000000000,
    error: null,
    status: 'ok'
  }
}

function rustGeminiResult(): ProviderRateLimits {
  return {
    provider: 'gemini',
    session: {
      usedPercent: 25,
      windowMinutes: 60,
      resetsAt: null,
      resetDescription: null
    },
    weekly: null,
    buckets: [
      {
        name: 'Pro',
        usedPercent: 25,
        windowMinutes: 60,
        resetsAt: null,
        resetDescription: null
      }
    ],
    updatedAt: 1750000000000,
    error: null,
    status: 'ok'
  }
}

describe('createPebbleRateLimitsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeAccountIdsMock.mockReturnValue({
      claude: new Set(),
      codex: new Set()
    })
    claudeAccountsMock.mockReturnValue([])
    codexAccountsMock.mockReturnValue([])
    selectedClaudeWslAccountMock.mockReturnValue(null)
    globalThis.window = {
      __TAURI_INTERNALS__: {},
      api: {
        settings: {
          get: vi.fn(() =>
            Promise.resolve({
              opencodeSessionCookie: 'auth=secret',
              opencodeWorkspaceId: 'wrk_TEST',
              minimaxGroupId: 'group-1',
              minimaxUsageModels: 'general',
              geminiCliOAuthEnabled: true
            })
          )
        }
      }
    } as unknown as Window & typeof globalThis
  })

  it('merges Claude, Codex, and Kimi fetches into one state and fills reset descriptions', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'rate_limits_fetch_claude') {
        return rustClaudeResult()
      }
      if (command === 'rate_limits_fetch_codex') {
        return rustCodexResult()
      }
      if (command === 'rate_limits_fetch_kimi') {
        return rustKimiResult()
      }
      if (command === 'rate_limits_fetch_opencode_go') {
        return rustOpenCodeResult()
      }
      if (command === 'rate_limits_fetch_minimax') {
        return rustMiniMaxResult()
      }
      if (command === 'rate_limits_fetch_gemini') {
        return rustGeminiResult()
      }
      throw new Error(`unexpected command ${command}`)
    })

    const api = createPebbleRateLimitsApi(baseApi())
    const state = await api.get()

    expect(state.claude?.status).toBe('ok')
    expect(state.claude?.session?.usedPercent).toBe(40)
    // Rust leaves resetDescription null; the bridge renders it locale-aware.
    expect(state.claude?.session?.resetDescription).toBeTruthy()
    expect(state.codex?.weekly?.usedPercent).toBe(90)
    expect(state.codex?.weekly?.resetDescription).toBeNull()
    expect(state.kimi?.session?.usedPercent).toBe(60)
    expect(state.opencodeGo?.monthly?.usedPercent).toBe(89)
    expect(state.minimax?.session?.usedPercent).toBe(65)
    expect(state.minimaxCookieConfigured).toBe(true)
    expect(state.gemini?.buckets?.[0]?.name).toBe('Pro')
    expect(invokeMock).toHaveBeenCalledWith('rate_limits_fetch_opencode_go', {
      cookie: 'auth=secret',
      workspaceId: 'wrk_TEST'
    })
  })

  it('get() only triggers the initial fetch once', async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === 'rate_limits_fetch_claude'
        ? rustClaudeResult()
        : command === 'rate_limits_fetch_codex'
          ? rustCodexResult()
          : command === 'rate_limits_fetch_kimi'
            ? rustKimiResult()
            : command === 'rate_limits_fetch_opencode_go'
              ? rustOpenCodeResult()
              : command === 'rate_limits_fetch_minimax'
                ? rustMiniMaxResult()
                : rustGeminiResult()
    )
    const api = createPebbleRateLimitsApi(baseApi())
    await api.get()
    await api.get()
    expect(invokeMock).toHaveBeenCalledTimes(6)
  })

  it('maps a rejected invoke into an error provider entry instead of throwing', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'rate_limits_fetch_claude') {
        throw new Error('bridge exploded')
      }
      if (command === 'rate_limits_fetch_codex') {
        return rustCodexResult()
      }
      if (command === 'rate_limits_fetch_kimi') {
        return rustKimiResult()
      }
      return command === 'rate_limits_fetch_opencode_go'
        ? rustOpenCodeResult()
        : command === 'rate_limits_fetch_minimax'
          ? rustMiniMaxResult()
          : rustGeminiResult()
    })
    const api = createPebbleRateLimitsApi(baseApi())
    const state = await api.refresh()
    expect(state.claude?.status).toBe('error')
    expect(state.claude?.error).toContain('bridge exploded')
    expect(state.codex?.status).toBe('ok')
  })

  it('notifies onUpdate subscribers on refresh and honors unsubscription', async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === 'rate_limits_fetch_claude'
        ? rustClaudeResult()
        : command === 'rate_limits_fetch_codex'
          ? rustCodexResult()
          : command === 'rate_limits_fetch_kimi'
            ? rustKimiResult()
            : command === 'rate_limits_fetch_opencode_go'
              ? rustOpenCodeResult()
              : command === 'rate_limits_fetch_minimax'
                ? rustMiniMaxResult()
                : rustGeminiResult()
    )
    const api = createPebbleRateLimitsApi(baseApi())
    const seen: RateLimitState[] = []
    const unsubscribe = api.onUpdate((state) => seen.push(state))
    await api.refresh()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)?.claude?.status).toBe('ok')
    const countBefore = seen.length
    unsubscribe()
    await api.refresh()
    expect(seen.length).toBe(countBefore)
  })

  it('fetches Claude usage inside the selected WSL distro', async () => {
    selectedClaudeWslAccountMock.mockReturnValue({
      accountId: 'claude-wsl-active',
      managedAuthPath: '/home/dev/.local/share/pebble/claude-accounts/claude-wsl-active/auth'
    })
    invokeMock.mockResolvedValue(rustClaudeResult())
    const api = createPebbleRateLimitsApi(baseApi())
    const state = await api.refreshClaudeForTarget({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    expect(state.claudeTarget).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(state.claude?.status).toBe('ok')
    expect(invokeMock).toHaveBeenCalledWith('rate_limits_fetch_claude_wsl', {
      wslDistro: 'Ubuntu',
      accountId: 'claude-wsl-active',
      managedAuthPath: '/home/dev/.local/share/pebble/claude-accounts/claude-wsl-active/auth'
    })
  })

  it('prefetches only inactive managed accounts from their isolated credential sources', async () => {
    activeAccountIdsMock.mockReturnValue({
      claude: new Set(['claude-active']),
      codex: new Set(['codex-active'])
    })
    claudeAccountsMock.mockReturnValue([
      { id: 'claude-active', managedAuthRuntime: 'host' },
      { id: 'claude-host', managedAuthRuntime: 'host' },
      {
        id: 'claude-wsl',
        managedAuthRuntime: 'wsl',
        wslDistro: 'Ubuntu',
        wslLinuxAuthPath: '/home/dev/.local/share/pebble/claude-accounts/claude-wsl/auth'
      }
    ] as never)
    codexAccountsMock.mockReturnValue([
      {
        id: 'codex-active',
        managedHomeRuntime: 'host',
        managedHomePath: '/codex/active'
      },
      {
        id: 'codex-host',
        managedHomeRuntime: 'host',
        managedHomePath: '/codex/host'
      },
      {
        id: 'codex-wsl',
        managedHomeRuntime: 'wsl',
        wslDistro: 'Ubuntu',
        managedHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\codex-wsl',
        wslLinuxHomePath: '/home/dev/codex-wsl'
      }
    ] as never)
    invokeMock.mockImplementation(async (command: string) =>
      command.includes('claude') ? rustClaudeResult() : rustCodexResult()
    )
    const api = createPebbleRateLimitsApi(baseApi())
    const states: RateLimitState[] = []
    api.onUpdate((next) => states.push(next))

    await api.fetchInactiveClaudeAccounts()
    await api.fetchInactiveCodexAccounts()

    expect(states.at(-1)?.inactiveClaudeAccounts.map((entry) => entry.accountId)).toEqual([
      'claude-host',
      'claude-wsl'
    ])
    expect(states.at(-1)?.inactiveCodexAccounts.map((entry) => entry.accountId)).toEqual([
      'codex-host',
      'codex-wsl'
    ])
    expect(invokeMock).toHaveBeenCalledWith('rate_limits_fetch_claude_managed', {
      accountId: 'claude-host'
    })
    expect(invokeMock).toHaveBeenCalledWith('rate_limits_fetch_claude_wsl', {
      wslDistro: 'Ubuntu',
      accountId: 'claude-wsl',
      managedAuthPath: '/home/dev/.local/share/pebble/claude-accounts/claude-wsl/auth'
    })
    expect(invokeMock).toHaveBeenCalledWith('rate_limits_fetch_codex', {
      managedHomePath: '/codex/host'
    })
    expect(invokeMock).toHaveBeenCalledWith('rate_limits_fetch_codex_wsl', {
      wslDistro: 'Ubuntu',
      managedHomePath: '/home/dev/codex-wsl'
    })
  })

  it('fetches Codex usage inside the selected WSL distro', async () => {
    invokeMock.mockResolvedValue(rustCodexResult())
    const api = createPebbleRateLimitsApi(baseApi())
    const state = await api.refreshCodexForTarget({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    expect(state.codex?.status).toBe('ok')
    expect(invokeMock).toHaveBeenCalledWith('rate_limits_fetch_codex_wsl', {
      wslDistro: 'Ubuntu'
    })
  })

  it('host target refresh fetches only that provider', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'rate_limits_fetch_codex') {
        return rustCodexResult()
      }
      throw new Error(`unexpected command ${command}`)
    })
    const api = createPebbleRateLimitsApi(baseApi())
    const state = await api.refreshCodexForTarget({
      runtime: 'host',
      wslDistro: null
    })
    expect(state.codex?.status).toBe('ok')
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('consumeCodexResetCredit passes an idempotency key and refreshes codex', async () => {
    let consumedKey: string | null = null
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'rate_limits_consume_codex_reset_credit') {
        consumedKey = String(args?.idempotencyKey)
        return { outcome: 'reset' }
      }
      if (command === 'rate_limits_fetch_codex') {
        return rustCodexResult()
      }
      throw new Error(`unexpected command ${command}`)
    })
    const api = createPebbleRateLimitsApi(baseApi())
    const result = await api.consumeCodexResetCredit()
    expect(result.outcome).toBe('reset')
    expect(result.state.codex?.status).toBe('ok')
    expect(consumedKey).toBeTruthy()
  })

  it('redeems and refreshes against the selected WSL Codex account', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'rate_limits_fetch_codex_wsl') {
        return rustCodexResult()
      }
      if (command === 'rate_limits_consume_codex_reset_credit_wsl') {
        return { outcome: 'reset' }
      }
      throw new Error(`unexpected command ${command}`)
    })
    const api = createPebbleRateLimitsApi(baseApi())
    await api.refreshCodexForTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    const result = await api.consumeCodexResetCredit()
    expect(result.outcome).toBe('reset')
    expect(invokeMock).toHaveBeenCalledWith(
      'rate_limits_consume_codex_reset_credit_wsl',
      expect.objectContaining({ wslDistro: 'Ubuntu' })
    )
    expect(invokeMock).not.toHaveBeenCalledWith(
      'rate_limits_consume_codex_reset_credit',
      expect.anything()
    )
  })

  it('falls back to the web base when Tauri internals are missing', async () => {
    globalThis.window = {} as unknown as Window & typeof globalThis
    const base = baseApi()
    const getSpy = vi.spyOn(base, 'get')
    const api = createPebbleRateLimitsApi(base)
    await api.get()
    expect(getSpy).toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
