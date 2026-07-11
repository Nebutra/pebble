import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

import { createPebbleRateLimitsApi } from './tauri-rate-limits-api'
import type { ProviderRateLimits, RateLimitState } from '../../../src/shared/rate-limit-types'

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
    weekly: { usedPercent: 90, windowMinutes: 10080, resetsAt: null, resetDescription: null },
    updatedAt: 1750000000000,
    error: null,
    status: 'ok'
  }
}

describe('createPebbleRateLimitsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.window = { __TAURI_INTERNALS__: {} } as unknown as Window & typeof globalThis
  })

  it('merges claude and codex fetches into one state and fills reset descriptions', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'rate_limits_fetch_claude') return rustClaudeResult()
      if (command === 'rate_limits_fetch_codex') return rustCodexResult()
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
  })

  it('get() only triggers the initial fetch once', async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === 'rate_limits_fetch_claude' ? rustClaudeResult() : rustCodexResult()
    )
    const api = createPebbleRateLimitsApi(baseApi())
    await api.get()
    await api.get()
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it('maps a rejected invoke into an error provider entry instead of throwing', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'rate_limits_fetch_claude') throw new Error('bridge exploded')
      return rustCodexResult()
    })
    const api = createPebbleRateLimitsApi(baseApi())
    const state = await api.refresh()
    expect(state.claude?.status).toBe('error')
    expect(state.claude?.error).toContain('bridge exploded')
    expect(state.codex?.status).toBe('ok')
  })

  it('notifies onUpdate subscribers on refresh and honors unsubscription', async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === 'rate_limits_fetch_claude' ? rustClaudeResult() : rustCodexResult()
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

  it('reports WSL targets as an explicit unavailable gap without fetching', async () => {
    const api = createPebbleRateLimitsApi(baseApi())
    const state = await api.refreshClaudeForTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(state.claudeTarget).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(state.claude?.status).toBe('unavailable')
    expect(state.claude?.error).toContain('WSL')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('host target refresh fetches only that provider', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'rate_limits_fetch_codex') return rustCodexResult()
      throw new Error(`unexpected command ${command}`)
    })
    const api = createPebbleRateLimitsApi(baseApi())
    const state = await api.refreshCodexForTarget({ runtime: 'host', wslDistro: null })
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
      if (command === 'rate_limits_fetch_codex') return rustCodexResult()
      throw new Error(`unexpected command ${command}`)
    })
    const api = createPebbleRateLimitsApi(baseApi())
    const result = await api.consumeCodexResetCredit()
    expect(result.outcome).toBe('reset')
    expect(result.state.codex?.status).toBe('ok')
    expect(consumedKey).toBeTruthy()
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
