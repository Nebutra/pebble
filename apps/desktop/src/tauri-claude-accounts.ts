import { invoke } from '@tauri-apps/api/core'

import type {
  ClaudeManagedAccount,
  ClaudeRateLimitAccountsState
} from '../../../packages/product-core/shared/types'
import {
  readClaudeHostSelection,
  readClaudeSnapshot,
  readSettings,
  refreshRateLimitsQuietly,
  requireClaudeAccount,
  normalizeWslDistro,
  writeSettings
} from './tauri-account-settings-store'
import {
  type ManagedClaudeLocation,
  assertNoLiveClaudeSessions,
  loginAndCaptureClaude
} from './tauri-claude-login-session'

export async function addClaudeAccount(
  runtime: 'host' | 'wsl',
  wslDistro: string | null
): Promise<ClaudeRateLimitAccountsState> {
  const accountId = crypto.randomUUID()
  const location = await invoke<ManagedClaudeLocation>('managed_claude_account_prepare', {
    accountId,
    runtime,
    wslDistro
  })
  try {
    const identity = await loginAndCaptureClaude(accountId, location)
    const now = Date.now()
    const account: ClaudeManagedAccount = {
      id: accountId,
      email: identity.email,
      managedAuthPath: location.managedAuthPath,
      managedAuthRuntime: location.managedAuthRuntime,
      wslDistro: location.wslDistro,
      wslLinuxAuthPath: location.wslLinuxAuthPath,
      authMethod: identity.authMethod,
      organizationUuid: identity.organizationUuid,
      organizationName: identity.organizationName,
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: now
    }
    const settings = readSettings()
    writeSettings({
      ...settings,
      claudeManagedAccounts: [...settings.claudeManagedAccounts, account]
    })
    return readClaudeSnapshot()
  } catch (error) {
    await invoke('managed_claude_account_remove', {
      accountId,
      managedAuthPath: location.managedAuthPath,
      managedAuthRuntime: location.managedAuthRuntime,
      wslDistro: location.wslDistro,
      wslLinuxAuthPath: location.wslLinuxAuthPath
    }).catch(() => undefined)
    throw error
  }
}

export async function reauthenticateClaudeAccount(
  accountId: string
): Promise<ClaudeRateLimitAccountsState> {
  const account = requireClaudeAccount(accountId)
  const location = await invoke<ManagedClaudeLocation>('managed_claude_account_prepare', {
    accountId,
    runtime: account.managedAuthRuntime ?? 'host',
    wslDistro: account.wslDistro
  })
  const identity = await loginAndCaptureClaude(accountId, location)
  const settings = readSettings()
  const now = Date.now()
  writeSettings({
    ...settings,
    claudeManagedAccounts: settings.claudeManagedAccounts.map((entry) =>
      entry.id === accountId
        ? {
            ...entry,
            email: identity.email,
            authMethod: identity.authMethod,
            organizationUuid: identity.organizationUuid,
            organizationName: identity.organizationName,
            updatedAt: now,
            lastAuthenticatedAt: now
          }
        : entry
    )
  })
  if (account.managedAuthRuntime !== 'wsl' && readClaudeHostSelection(settings) === accountId) {
    await assertNoLiveClaudeSessions()
    await invoke('managed_claude_account_activate', {
      outgoingAccountId: accountId,
      accountId
    })
  }
  await refreshRateLimitsQuietly()
  return readClaudeSnapshot()
}

export async function selectClaudeAccount(
  accountId: string | null,
  runtime: 'host' | 'wsl',
  wslDistro: string | null
): Promise<ClaudeRateLimitAccountsState> {
  const account = accountId === null ? null : requireClaudeAccount(accountId)
  if (account && (account.managedAuthRuntime ?? 'host') !== runtime) {
    throw new Error(`That Claude account belongs to the ${account.managedAuthRuntime} runtime.`)
  }
  const settings = readSettings()
  if (runtime === 'wsl') {
    const key = normalizeWslDistro(wslDistro ?? account?.wslDistro ?? null)
    writeSettings({
      ...settings,
      activeClaudeManagedAccountIdsByRuntime: {
        host: readClaudeHostSelection(settings),
        wsl: {
          ...settings.activeClaudeManagedAccountIdsByRuntime?.wsl,
          [key]: accountId
        }
      }
    })
    await refreshRateLimitsQuietly()
    return readClaudeSnapshot()
  }
  const outgoingAccountId = readClaudeHostSelection(settings)
  // Why: existing Claude PTYs retain their in-memory auth, while Rust first
  // preserves refreshed outgoing credentials before materializing the account
  // selected for newly spawned terminals. Reauth/removal stay blocked because
  // they mutate or delete the live account's owned credential source.
  await invoke('managed_claude_account_activate', {
    outgoingAccountId,
    accountId
  })
  writeSettings({
    ...settings,
    activeClaudeManagedAccountId: accountId,
    activeClaudeManagedAccountIdsByRuntime: {
      host: accountId,
      wsl: settings.activeClaudeManagedAccountIdsByRuntime?.wsl ?? {}
    }
  })
  await refreshRateLimitsQuietly()
  return readClaudeSnapshot()
}

export async function removeClaudeAccount(
  accountId: string
): Promise<ClaudeRateLimitAccountsState> {
  const account = requireClaudeAccount(accountId)
  const settings = readSettings()
  const activeId = readClaudeHostSelection(settings)
  if (activeId === accountId) {
    await assertNoLiveClaudeSessions()
    await invoke('managed_claude_account_activate', {
      outgoingAccountId: accountId,
      accountId: null
    })
  }
  await invoke('managed_claude_account_remove', {
    accountId,
    managedAuthPath: account.managedAuthPath,
    managedAuthRuntime: account.managedAuthRuntime ?? 'host',
    wslDistro: account.wslDistro,
    wslLinuxAuthPath: account.wslLinuxAuthPath
  })
  const wslSelection = Object.fromEntries(
    Object.entries(settings.activeClaudeManagedAccountIdsByRuntime?.wsl ?? {}).map(
      ([distro, selectedId]) => [distro, selectedId === accountId ? null : selectedId]
    )
  )
  writeSettings({
    ...settings,
    claudeManagedAccounts: settings.claudeManagedAccounts.filter((entry) => entry.id !== accountId),
    activeClaudeManagedAccountId: activeId === accountId ? null : activeId,
    activeClaudeManagedAccountIdsByRuntime: {
      host: activeId === accountId ? null : activeId,
      wsl: wslSelection
    }
  })
  await refreshRateLimitsQuietly()
  return readClaudeSnapshot()
}
