import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../src/preload/api-types'
import type {
  CodexRateLimitResetOutcome,
  CodexRateLimitResetResult,
  ProviderRateLimits,
  RateLimitRuntimeTarget,
  RateLimitState,
  RateLimitWindow
} from '../../../src/shared/rate-limit-types'
import { hasTauriInternals } from './pebble-runtime-http-bridge'

// Shipped-vs-gap matrix (vs src/main/rate-limits/service.ts):
// - claude host usage:    SHIPPED — Rust reads the Claude CLI's own OAuth
//   credential (macOS Keychain / ~/.claude/.credentials.json) and calls the
//   Claude Code usage endpoint (commands/rate_limits.rs).
// - codex host usage:     SHIPPED — Rust runs a read-only `codex app-server`
//   JSON-RPC exchange plus the ChatGPT backend reset-credit read.
// - consumeCodexResetCredit: SHIPPED — direct backend consume call.
// - wsl targets:          GAP — needs a real Windows+WSL host to bridge; the
//   target switch is recorded but the provider reports unavailable.
// - gemini/kimi/minimax/opencodeGo: GAP — their fetchers depend on credential
//   stores (Google OAuth extraction, MiniMax cookie jar) with no native home.
// - fetchInactive*Accounts: honest no-op — Pebble-managed multi-accounts
//   cannot be created in the Tauri shell yet, so there are no inactive ones.
// - oauth token refresh:  deliberate non-goal — the CLI owns credential
//   rotation; Pebble sends the stored token and lets the server decide.
type RateLimitsApi = NonNullable<Partial<PreloadApi>['rateLimits']>

const HOST_TARGET: RateLimitRuntimeTarget = { runtime: 'host', wslDistro: null }
// Why: floor protects the provider endpoints from a misconfigured renderer
// interval hammering them; Electron polls on multi-minute cadences.
const MIN_POLL_INTERVAL_MS = 60_000

function emptyState(): RateLimitState {
  return {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    minimax: null,
    minimaxCookieConfigured: false,
    claudeTarget: { ...HOST_TARGET },
    codexTarget: { ...HOST_TARGET },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

/** Locale-aware reset label ("2:30 PM" today, "Thu 2:30 PM" otherwise).
 *  Rendered here, not in Rust, so formatting follows the renderer's locale
 *  exactly like Electron's main-process formatting did. */
function describeReset(resetsAt: number | null): string | null {
  if (resetsAt === null) {
    return null
  }
  try {
    const date = new Date(resetsAt)
    if (Number.isNaN(date.getTime())) {
      return null
    }
    const now = new Date()
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    }
    return date.toLocaleDateString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit'
    })
  } catch {
    return null
  }
}

function decorateWindow(window: RateLimitWindow | null | undefined): RateLimitWindow | null {
  if (!window) {
    return null
  }
  return { ...window, resetDescription: window.resetDescription ?? describeReset(window.resetsAt) }
}

function decorateProvider(limits: ProviderRateLimits): ProviderRateLimits {
  return {
    ...limits,
    session: decorateWindow(limits.session),
    weekly: decorateWindow(limits.weekly),
    ...(limits.fableWeekly !== undefined ? { fableWeekly: decorateWindow(limits.fableWeekly) } : {})
  }
}

function failedProvider(provider: 'claude' | 'codex', error: unknown): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: error instanceof Error ? error.message : String(error),
    status: 'error'
  }
}

function wslGapProvider(provider: 'claude' | 'codex'): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'WSL rate-limit targets are not yet supported in the Tauri desktop shell.',
    status: 'unavailable'
  }
}

export function createPebbleRateLimitsApi(base: RateLimitsApi): RateLimitsApi {
  if (!hasTauriInternals()) {
    return { ...base }
  }

  let state = emptyState()
  let initialRefresh: Promise<void> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
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

  async function fetchProvider(provider: 'claude' | 'codex'): Promise<ProviderRateLimits> {
    const command = provider === 'claude' ? 'rate_limits_fetch_claude' : 'rate_limits_fetch_codex'
    try {
      return decorateProvider(await invoke<ProviderRateLimits>(command))
    } catch (error) {
      return failedProvider(provider, error)
    }
  }

  async function refreshProvider(provider: 'claude' | 'codex'): Promise<RateLimitState> {
    const limits = await fetchProvider(provider)
    state = { ...state, [provider]: limits }
    emit()
    return state
  }

  async function refreshAll(): Promise<RateLimitState> {
    const refreshes: Promise<ProviderRateLimits>[] = []
    if (state.claudeTarget.runtime === 'host') {
      refreshes.push(fetchProvider('claude'))
    }
    if (state.codexTarget.runtime === 'host') {
      refreshes.push(fetchProvider('codex'))
    }
    for (const limits of await Promise.all(refreshes)) {
      state = { ...state, [limits.provider]: limits }
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
    state = { ...state, [targetKey]: { runtime: target.runtime, wslDistro: target.wslDistro } }
    if (target.runtime !== 'host') {
      state = { ...state, [provider]: wslGapProvider(provider) }
      emit()
      return state
    }
    return refreshProvider(provider)
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
      const { outcome } = await invoke<{ outcome: CodexRateLimitResetOutcome }>(
        'rate_limits_consume_codex_reset_credit',
        // Why: the redeem id makes the backend call idempotent when retried.
        { idempotencyKey: crypto.randomUUID() }
      )
      const nextState = await refreshProvider('codex')
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
      pollTimer = setInterval(() => {
        void refreshAll()
      }, Math.max(MIN_POLL_INTERVAL_MS, ms))
    },
    // Honest no-ops: managed inactive accounts cannot exist without the
    // interactive add flow (see tauri-accounts-api.ts).
    fetchInactiveClaudeAccounts: () => Promise.resolve(),
    fetchInactiveCodexAccounts: () => Promise.resolve(),
    // GAP: MiniMax usage needs the persisted session-cookie store, which has
    // no native home yet.
    refreshMiniMax: () => Promise.resolve(state),
    onUpdate: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    }
  }
}
