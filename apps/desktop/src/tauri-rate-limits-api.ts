import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  CodexRateLimitResetOutcome,
  CodexRateLimitResetResult,
  ProviderRateLimits,
  RateLimitRuntimeTarget,
  RateLimitState,
  InactiveAccountUsage
} from '../../../packages/product-core/shared/rate-limit-types'
import { hasTauriInternals } from './pebble-runtime-http-bridge'
import {
  readSelectedTauriCodexHome,
  readSelectedTauriCodexWslHome,
  readTauriActiveManagedAccountIds,
  readTauriClaudeManagedAccounts,
  readTauriCodexManagedAccounts
} from './tauri-accounts-api'
import {
  decorateProvider,
  emptyState,
  failedProvider,
  fetchGemini,
  fetchInactiveClaudeAccount,
  fetchKimi,
  fetchMiniMax,
  fetchOpenCodeGo,
  fetchProvider,
  INACTIVE_FETCH_DEBOUNCE_MS,
  MIN_POLL_INTERVAL_MS
} from './tauri-rate-limit-provider-fetchers'

// Native rate-limit ownership matrix:
// - claude host usage:    SHIPPED — Rust reads the Claude CLI's own OAuth
//   credential (macOS Keychain / ~/.claude/.credentials.json) and calls the
//   Claude Code usage endpoint (commands/rate_limits.rs).
// - codex host usage:     SHIPPED — Rust runs a read-only `codex app-server`
//   JSON-RPC exchange plus the ChatGPT backend reset-credit read.
// - consumeCodexResetCredit: SHIPPED — direct backend consume call.
// - codex WSL usage:      SHIPPED — Rust starts the read-only app-server in
//   the selected distro so credentials remain owned by WSL.
// - claude WSL usage:     SHIPPED — Rust reads the selected distro's Claude
//   credential file and keeps the OAuth token out of the renderer.
// - kimi host usage:      SHIPPED — Rust reads the Kimi CLI's own short-lived
//   OAuth credential and calls its read-only coding-plan usage endpoint.
// - OpenCode Go usage:    SHIPPED — Rust receives the configured web session,
//   filters it to auth cookies, resolves workspaces, and parses the RSC page.
// - MiniMax usage:       SHIPPED — the OS credential store owns the session
//   cookie and Rust sends the browser-compatible usage request.
// - Gemini usage:       SHIPPED — Rust honors explicit opt-in, resolves CLI
//   OAuth sources/client constants, rotates expired tokens, and reads quota.
// - active managed Codex:  SHIPPED — selected host accounts pass their
//   isolated CODEX_HOME into usage and reset-credit reads.
// - fetchInactive*Accounts: SHIPPED — each managed host/WSL credential source
//   is queried directly without materializing it as the active account.
// - oauth token refresh:  deliberate non-goal — the CLI owns credential
//   rotation; Pebble sends the stored token and lets the server decide.
type RateLimitsApi = NonNullable<Partial<PreloadApi>['rateLimits']>

export function createPebbleRateLimitsApi(base: RateLimitsApi): RateLimitsApi {
  if (!hasTauriInternals()) {
    return { ...base }
  }

  let state = emptyState()
  let initialRefresh: Promise<void> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let inactiveClaudeGeneration = 0
  let inactiveCodexGeneration = 0
  let lastInactiveClaudeFetchAt = 0
  let lastInactiveCodexFetchAt = 0
  const listeners = new Set<(state: RateLimitState) => void>()

  function emit(): void {
    for (const listener of listeners) {
      try {
        listener(state)
      } catch {
        // A broken subscriber must not stall the other listeners.
      }
    }
  }

  async function refreshAll(): Promise<RateLimitState> {
    const refreshes: Promise<ProviderRateLimits>[] = []
    if (state.claudeTarget.runtime === 'host') {
      refreshes.push(fetchProvider('claude'))
    }
    if (state.codexTarget.runtime === 'host') {
      refreshes.push(fetchProvider('codex'))
    }
    refreshes.push(fetchKimi())
    refreshes.push(fetchOpenCodeGo())
    refreshes.push(fetchMiniMax())
    refreshes.push(fetchGemini())
    for (const limits of await Promise.all(refreshes)) {
      const stateKey = limits.provider === 'opencode-go' ? 'opencodeGo' : limits.provider
      state = {
        ...state,
        [stateKey]: limits,
        ...(limits.provider === 'minimax'
          ? { minimaxCookieConfigured: limits.status !== 'unavailable' }
          : {})
      }
    }
    emit()
    return state
  }

  function ensureInitialRefresh(): Promise<void> {
    if (!initialRefresh) {
      initialRefresh = refreshAll().then(() => undefined)
    }
    return initialRefresh
  }

  async function refreshForTarget(
    provider: 'claude' | 'codex',
    target: RateLimitRuntimeTarget
  ): Promise<RateLimitState> {
    const targetKey = provider === 'claude' ? 'claudeTarget' : 'codexTarget'
    state = {
      ...state,
      [targetKey]: { runtime: target.runtime, wslDistro: target.wslDistro }
    }
    const limits = await fetchProvider(provider, target)
    state = { ...state, [provider]: limits }
    emit()
    return state
  }

  async function fetchInactiveClaudeAccounts(): Promise<void> {
    if (Date.now() - lastInactiveClaudeFetchAt < INACTIVE_FETCH_DEBOUNCE_MS) {
      return
    }
    const generation = ++inactiveClaudeGeneration
    const activeIds = readTauriActiveManagedAccountIds().claude
    const accounts = readTauriClaudeManagedAccounts().filter(
      (account) => !activeIds.has(account.id)
    )
    state = {
      ...state,
      inactiveClaudeAccounts: accounts.map((account) => ({
        accountId: account.id,
        rateLimits:
          state.inactiveClaudeAccounts.find((entry) => entry.accountId === account.id)
            ?.rateLimits ?? null,
        updatedAt: Date.now(),
        isFetching: true
      }))
    }
    emit()
    const results = await Promise.all(
      accounts.map(async (account): Promise<InactiveAccountUsage> => {
        const rateLimits = await fetchInactiveClaudeAccount(account)
        return {
          accountId: account.id,
          rateLimits,
          updatedAt: Date.now(),
          isFetching: false
        }
      })
    )
    if (generation !== inactiveClaudeGeneration) {
      return
    }
    state = { ...state, inactiveClaudeAccounts: results }
    lastInactiveClaudeFetchAt = Date.now()
    emit()
  }

  async function fetchInactiveCodexAccounts(): Promise<void> {
    if (Date.now() - lastInactiveCodexFetchAt < INACTIVE_FETCH_DEBOUNCE_MS) {
      return
    }
    const generation = ++inactiveCodexGeneration
    const activeIds = readTauriActiveManagedAccountIds().codex
    const accounts = readTauriCodexManagedAccounts().filter((account) => !activeIds.has(account.id))
    state = {
      ...state,
      inactiveCodexAccounts: accounts.map((account) => ({
        accountId: account.id,
        rateLimits:
          state.inactiveCodexAccounts.find((entry) => entry.accountId === account.id)?.rateLimits ??
          null,
        updatedAt: Date.now(),
        isFetching: true
      }))
    }
    emit()
    const results = await Promise.all(
      accounts.map(async (account): Promise<InactiveAccountUsage> => {
        let rateLimits: ProviderRateLimits
        try {
          rateLimits = decorateProvider(
            account.managedHomeRuntime === 'wsl'
              ? await invoke<ProviderRateLimits>('rate_limits_fetch_codex_wsl', {
                  wslDistro: account.wslDistro,
                  managedHomePath: account.wslLinuxHomePath
                })
              : await invoke<ProviderRateLimits>('rate_limits_fetch_codex', {
                  managedHomePath: account.managedHomePath
                })
          )
        } catch (error) {
          rateLimits = failedProvider('codex', error)
        }
        return {
          accountId: account.id,
          rateLimits,
          updatedAt: Date.now(),
          isFetching: false
        }
      })
    )
    if (generation !== inactiveCodexGeneration) {
      return
    }
    state = { ...state, inactiveCodexAccounts: results }
    lastInactiveCodexFetchAt = Date.now()
    emit()
  }

  return {
    ...base,
    get: async () => {
      await ensureInitialRefresh()
      return state
    },
    refresh: async () => {
      await ensureInitialRefresh()
      return refreshAll()
    },
    refreshClaudeForTarget: (target) => refreshForTarget('claude', target),
    refreshCodexForTarget: (target) => refreshForTarget('codex', target),
    consumeCodexResetCredit: async (): Promise<CodexRateLimitResetResult> => {
      const target = state.codexTarget
      const command =
        target.runtime === 'wsl'
          ? 'rate_limits_consume_codex_reset_credit_wsl'
          : 'rate_limits_consume_codex_reset_credit'
      const { outcome } = await invoke<{ outcome: CodexRateLimitResetOutcome }>(
        command,
        // Why: the redeem id makes the backend call idempotent when retried.
        {
          idempotencyKey: crypto.randomUUID(),
          ...(target.runtime === 'wsl'
            ? { wslDistro: target.wslDistro }
            : { managedHomePath: readSelectedTauriCodexHome() }),
          ...(target.runtime === 'wsl'
            ? (() => {
                const managedHomePath = readSelectedTauriCodexWslHome(target.wslDistro)
                return managedHomePath ? { managedHomePath } : {}
              })()
            : {})
        }
      )
      const nextState = await refreshForTarget('codex', target)
      return { outcome, state: nextState }
    },
    setPollingInterval: async (ms) => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      if (!Number.isFinite(ms) || ms <= 0) {
        return
      }
      pollTimer = setInterval(
        () => {
          void refreshAll()
        },
        Math.max(MIN_POLL_INTERVAL_MS, ms)
      )
    },
    fetchInactiveClaudeAccounts,
    fetchInactiveCodexAccounts,
    refreshMiniMax: async () => {
      const limits = await fetchMiniMax()
      state = {
        ...state,
        minimax: limits,
        minimaxCookieConfigured: limits.status !== 'unavailable'
      }
      emit()
      return state
    },
    onUpdate: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    }
  }
}
