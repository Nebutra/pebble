import { invoke } from '@tauri-apps/api/core'

import type {
  CodexManagedAccount,
  CodexRateLimitAccountsState
} from '../../../packages/product-core/shared/types'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-runtime-http-bridge'
import {
  type RuntimeSession,
  LOGIN_POLL_MS,
  LOGIN_TIMEOUT_MS,
  delay,
  readCodexSnapshot,
  readLoginOutput,
  readSettings,
  refreshRateLimitsQuietly,
  requireCodexAccount,
  shellQuote,
  writeSettings
} from './tauri-account-settings-store'

type ManagedCodexHome = {
  managedHomePath: string
  managedHomeRuntime: 'host' | 'wsl'
  wslDistro: string | null
  wslLinuxHomePath: string | null
}
type CodexIdentity = {
  email: string | null
  accountId: string | null
  planType: string | null
}

export async function addCodexAccount(target?: {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}): Promise<CodexRateLimitAccountsState> {
  const accountId = crypto.randomUUID()
  const home = await invoke<ManagedCodexHome>('managed_codex_account_prepare', {
    accountId,
    recreate: false,
    runtime: target?.runtime ?? 'host',
    wslDistro: target?.wslDistro ?? null
  })
  try {
    await runCodexLogin(home)
    const identity = await readCodexIdentity(accountId, home)
    const now = Date.now()
    const account: CodexManagedAccount = {
      id: accountId,
      email: identity.email!,
      managedHomePath: home.managedHomePath,
      managedHomeRuntime: home.managedHomeRuntime,
      wslDistro: home.wslDistro,
      wslLinuxHomePath: home.wslLinuxHomePath,
      providerAccountId: identity.accountId,
      workspaceLabel: identity.planType,
      workspaceAccountId: identity.accountId,
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: now
    }
    const settings = readSettings()
    const existingSelection = settings.activeCodexManagedAccountIdsByRuntime ?? {
      host: settings.activeCodexManagedAccountId ?? null,
      wsl: {}
    }
    const nextWslSelection = { ...existingSelection.wsl }
    if (home.managedHomeRuntime === 'wsl' && home.wslDistro) {
      nextWslSelection[home.wslDistro] = accountId
    }
    writeSettings({
      ...settings,
      codexManagedAccounts: [...(settings.codexManagedAccounts ?? []), account],
      activeCodexManagedAccountId:
        home.managedHomeRuntime === 'host' ? accountId : settings.activeCodexManagedAccountId,
      activeCodexManagedAccountIdsByRuntime: {
        host: home.managedHomeRuntime === 'host' ? accountId : existingSelection.host,
        wsl: nextWslSelection
      }
    })
    await refreshRateLimitsQuietly()
    return readCodexSnapshot()
  } catch (error) {
    await removeManagedCodexHome(accountId, home).catch(() => undefined)
    throw error
  }
}

export async function reauthenticateCodexAccount(
  accountId: string
): Promise<CodexRateLimitAccountsState> {
  const account = requireCodexAccount(accountId)
  const home = await invoke<ManagedCodexHome>('managed_codex_account_prepare', {
    accountId,
    recreate: true,
    runtime: account.managedHomeRuntime ?? 'host',
    wslDistro: account.wslDistro ?? null
  })
  await runCodexLogin(home)
  const identity = await readCodexIdentity(accountId, home)
  const settings = readSettings()
  const now = Date.now()
  writeSettings({
    ...settings,
    codexManagedAccounts: settings.codexManagedAccounts.map((entry) =>
      entry.id === accountId
        ? {
            ...entry,
            managedHomePath: home.managedHomePath,
            managedHomeRuntime: home.managedHomeRuntime,
            wslDistro: home.wslDistro,
            wslLinuxHomePath: home.wslLinuxHomePath,
            email: identity.email!,
            providerAccountId: identity.accountId,
            workspaceLabel: identity.planType,
            workspaceAccountId: identity.accountId,
            updatedAt: now,
            lastAuthenticatedAt: now
          }
        : entry
    )
  })
  await refreshRateLimitsQuietly()
  return readCodexSnapshot()
}

export async function removeCodexAccount(accountId: string): Promise<CodexRateLimitAccountsState> {
  const account = requireCodexAccount(accountId)
  await removeManagedCodexHome(account.id, {
    managedHomePath: account.managedHomePath,
    managedHomeRuntime: account.managedHomeRuntime ?? 'host',
    wslDistro: account.wslDistro ?? null,
    wslLinuxHomePath: account.wslLinuxHomePath ?? null
  })
  const settings = readSettings()
  const activeId =
    settings.activeCodexManagedAccountIdsByRuntime?.host ??
    settings.activeCodexManagedAccountId ??
    null
  const nextActiveId = activeId === accountId ? null : activeId
  writeSettings({
    ...settings,
    codexManagedAccounts: settings.codexManagedAccounts.filter((entry) => entry.id !== accountId),
    activeCodexManagedAccountId: nextActiveId,
    activeCodexManagedAccountIdsByRuntime: {
      host: nextActiveId,
      wsl: settings.activeCodexManagedAccountIdsByRuntime?.wsl ?? {}
    }
  })
  await refreshRateLimitsQuietly()
  return readCodexSnapshot()
}

export async function selectCodexAccount(
  accountId: string | null,
  runtime: 'host' | 'wsl' = 'host',
  wslDistro: string | null = null
): Promise<CodexRateLimitAccountsState> {
  const account = accountId !== null ? requireCodexAccount(accountId) : null
  if (account && (account.managedHomeRuntime ?? 'host') !== runtime) {
    throw new Error('That Codex account belongs to a different runtime.')
  }
  const settings = readSettings()
  const wsl = {
    ...settings.activeCodexManagedAccountIdsByRuntime?.wsl
  }
  if (runtime === 'wsl') {
    const distro = wslDistro?.trim() || account?.wslDistro?.trim()
    if (!distro) {
      throw new Error('A WSL distro is required for Codex account selection.')
    }
    wsl[distro] = accountId
  }
  writeSettings({
    ...settings,
    activeCodexManagedAccountId:
      runtime === 'host' ? accountId : settings.activeCodexManagedAccountId,
    activeCodexManagedAccountIdsByRuntime: {
      host:
        runtime === 'host'
          ? accountId
          : (settings.activeCodexManagedAccountIdsByRuntime?.host ??
            settings.activeCodexManagedAccountId ??
            null),
      wsl
    }
  })
  await refreshRateLimitsQuietly()
  return readCodexSnapshot()
}

async function runCodexLogin(home: ManagedCodexHome): Promise<void> {
  await ensurePebbleRuntimeProcess()
  const isWsl = home.managedHomeRuntime === 'wsl'
  const managedHomePath = isWsl ? home.wslLinuxHomePath! : home.managedHomePath
  const command = isWsl
    ? [
        'wsl.exe',
        ...(home.wslDistro ? ['-d', home.wslDistro] : []),
        '--exec',
        'bash',
        '-ic',
        `export CODEX_HOME=${shellQuote(managedHomePath)}; exec codex login`
      ]
    : ['codex', 'login']
  const session = await requestRuntimeJson<RuntimeSession>('/v1/sessions', {
    method: 'POST',
    timeoutMs: 5000,
    body: {
      ephemeral: true,
      cwd: home.managedHomePath,
      command,
      environment: isWsl ? undefined : [`CODEX_HOME=${managedHomePath}`],
      cols: 100,
      rows: 30
    }
  })
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const current = (
      await requestRuntimeJson<RuntimeSession[]>('/v1/sessions', {
        method: 'GET',
        timeoutMs: 2500
      })
    ).find((entry) => entry.id === session.id)
    if (!current) {
      throw new Error('Codex login session disappeared before it finished.')
    }
    if (current.status === 'exited' && current.exitCode === 0) {
      return
    }
    if (
      current.status === 'failed' ||
      current.status === 'stopped' ||
      current.status === 'exited'
    ) {
      const output = await readLoginOutput(session.id)
      throw new Error(output ? `Codex login failed: ${output}` : 'Codex login failed.')
    }
    await delay(LOGIN_POLL_MS)
  }
  await requestRuntimeJson(`/v1/sessions/${encodeURIComponent(session.id)}`, {
    method: 'DELETE',
    timeoutMs: 2500
  }).catch(() => undefined)
  throw new Error('Codex sign-in took too long to finish. Please try again.')
}

function readCodexIdentity(accountId: string, home: ManagedCodexHome): Promise<CodexIdentity> {
  return invoke('managed_codex_account_identity', { accountId, ...home })
}

function removeManagedCodexHome(accountId: string, home: ManagedCodexHome): Promise<void> {
  return invoke('managed_codex_account_remove', { accountId, ...home })
}
