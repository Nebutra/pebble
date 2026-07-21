import { invoke } from '@tauri-apps/api/core'

import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget,
  RateLimitState,
  RateLimitWindow
} from '../../../packages/product-core/shared/rate-limit-types'
import {
  readSelectedTauriCodexHome,
  readSelectedTauriCodexWslHome,
  readSelectedTauriClaudeWslAccount
} from './tauri-accounts-api'
import type { readTauriClaudeManagedAccounts } from './tauri-accounts-api'

export const HOST_TARGET: RateLimitRuntimeTarget = {
  runtime: 'host',
  wslDistro: null
}
// Why: floor protects the provider endpoints from a misconfigured renderer
// interval hammering them; Electron polls on multi-minute cadences.
export const MIN_POLL_INTERVAL_MS = 60_000
export const INACTIVE_FETCH_DEBOUNCE_MS = 60_000

export function emptyState(): RateLimitState {
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
      return date.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit'
      })
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
  return {
    ...window,
    resetDescription: window.resetDescription ?? describeReset(window.resetsAt)
  }
}

export function decorateProvider(limits: ProviderRateLimits): ProviderRateLimits {
  return {
    ...limits,
    session: decorateWindow(limits.session),
    weekly: decorateWindow(limits.weekly),
    ...(limits.fableWeekly !== undefined ? { fableWeekly: decorateWindow(limits.fableWeekly) } : {})
  }
}

export function failedProvider(
  provider: 'claude' | 'codex' | 'gemini' | 'kimi' | 'opencode-go' | 'minimax',
  error: unknown
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: error instanceof Error ? error.message : String(error),
    status: 'error'
  }
}

export async function fetchProvider(
  provider: 'claude' | 'codex',
  target: RateLimitRuntimeTarget = HOST_TARGET
): Promise<ProviderRateLimits> {
  const managedWslCodexHome =
    target.runtime === 'wsl' && provider === 'codex'
      ? readSelectedTauriCodexWslHome(target.wslDistro)
      : null
  const managedWslClaudeAccount =
    target.runtime === 'wsl' && provider === 'claude'
      ? readSelectedTauriClaudeWslAccount(target.wslDistro)
      : null
  const command =
    target.runtime === 'wsl'
      ? provider === 'claude'
        ? 'rate_limits_fetch_claude_wsl'
        : 'rate_limits_fetch_codex_wsl'
      : provider === 'claude'
        ? 'rate_limits_fetch_claude'
        : 'rate_limits_fetch_codex'
  try {
    return decorateProvider(
      await invoke<ProviderRateLimits>(
        command,
        target.runtime === 'wsl'
          ? {
              wslDistro: target.wslDistro,
              ...(managedWslCodexHome ? { managedHomePath: managedWslCodexHome } : {}),
              ...(managedWslClaudeAccount
                ? {
                    accountId: managedWslClaudeAccount.accountId,
                    managedAuthPath: managedWslClaudeAccount.managedAuthPath
                  }
                : {})
            }
          : provider === 'codex'
            ? { managedHomePath: readSelectedTauriCodexHome() }
            : undefined
      )
    )
  } catch (error) {
    return failedProvider(provider, error)
  }
}

export async function fetchKimi(): Promise<ProviderRateLimits> {
  try {
    return decorateProvider(await invoke<ProviderRateLimits>('rate_limits_fetch_kimi'))
  } catch (error) {
    return failedProvider('kimi', error)
  }
}

export async function fetchOpenCodeGo(): Promise<ProviderRateLimits> {
  try {
    const settings = await window.api.settings.get()
    return decorateProvider(
      await invoke<ProviderRateLimits>('rate_limits_fetch_opencode_go', {
        cookie: settings.opencodeSessionCookie,
        workspaceId: settings.opencodeWorkspaceId || null
      })
    )
  } catch (error) {
    return failedProvider('opencode-go', error)
  }
}

export async function fetchMiniMax(): Promise<ProviderRateLimits> {
  try {
    const settings = await window.api.settings.get()
    return decorateProvider(
      await invoke<ProviderRateLimits>('rate_limits_fetch_minimax', {
        groupId: settings.minimaxGroupId || null,
        models: settings.minimaxUsageModels || null
      })
    )
  } catch (error) {
    return failedProvider('minimax', error)
  }
}

export async function fetchGemini(): Promise<ProviderRateLimits> {
  try {
    const settings = await window.api.settings.get()
    return decorateProvider(
      await invoke<ProviderRateLimits>('rate_limits_fetch_gemini', {
        enabled: settings.geminiCliOAuthEnabled === true
      })
    )
  } catch (error) {
    return failedProvider('gemini', error)
  }
}

export async function fetchInactiveClaudeAccount(
  account: ReturnType<typeof readTauriClaudeManagedAccounts>[number]
): Promise<ProviderRateLimits> {
  try {
    return decorateProvider(
      account.managedAuthRuntime === 'wsl'
        ? await invoke<ProviderRateLimits>('rate_limits_fetch_claude_wsl', {
            wslDistro: account.wslDistro,
            accountId: account.id,
            managedAuthPath: account.wslLinuxAuthPath
          })
        : await invoke<ProviderRateLimits>('rate_limits_fetch_claude_managed', {
            accountId: account.id
          })
    )
  } catch (error) {
    return failedProvider('claude', error)
  }
}
