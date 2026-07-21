import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  ClaudeManagedAccount,
  CodexManagedAccount
} from '../../../packages/product-core/shared/types'
import { hasTauriInternals } from './pebble-runtime-http-bridge'
import {
  readClaudeHostSelection,
  readClaudeSnapshot,
  readCodexSnapshot,
  readSettings,
  serializeClaudeMutation,
  serializeCodexMutation,
  normalizeWslDistro
} from './tauri-account-settings-store'
import { cancelPendingClaudeLogin } from './tauri-claude-login-session'
import {
  addClaudeAccount,
  reauthenticateClaudeAccount,
  removeClaudeAccount,
  selectClaudeAccount
} from './tauri-claude-accounts'
import {
  addCodexAccount,
  reauthenticateCodexAccount,
  removeCodexAccount,
  selectCodexAccount
} from './tauri-codex-accounts'

type CodexAccountsApi = NonNullable<Partial<PreloadApi>['codexAccounts']>
type ClaudeAccountsApi = NonNullable<Partial<PreloadApi>['claudeAccounts']>

export function createPebbleCodexAccountsApi(base: CodexAccountsApi): CodexAccountsApi {
  if (!hasTauriInternals()) {
    return { ...base }
  }
  return {
    ...base,
    list: () => Promise.resolve(readCodexSnapshot()),
    add: (target) => serializeCodexMutation(() => addCodexAccount(target)),
    reauthenticate: ({ accountId }) =>
      serializeCodexMutation(() => reauthenticateCodexAccount(accountId)),
    remove: ({ accountId }) => serializeCodexMutation(() => removeCodexAccount(accountId)),
    select: ({ accountId, runtime, wslDistro }) =>
      serializeCodexMutation(() => selectCodexAccount(accountId, runtime, wslDistro ?? null))
  }
}

export function createPebbleClaudeAccountsApi(base: ClaudeAccountsApi): ClaudeAccountsApi {
  if (!hasTauriInternals()) {
    return { ...base }
  }
  return {
    ...base,
    list: () => Promise.resolve(readClaudeSnapshot()),
    add: (target) =>
      serializeClaudeMutation(() =>
        addClaudeAccount(target?.runtime ?? 'host', target?.wslDistro ?? null)
      ),
    reauthenticate: ({ accountId }) =>
      serializeClaudeMutation(() => reauthenticateClaudeAccount(accountId)),
    remove: ({ accountId }) => serializeClaudeMutation(() => removeClaudeAccount(accountId)),
    select: ({ accountId, runtime, wslDistro }) =>
      serializeClaudeMutation(() =>
        selectClaudeAccount(accountId, runtime ?? 'host', wslDistro ?? null)
      ),
    cancelPendingLogin: cancelPendingClaudeLogin
  }
}

export function readSelectedTauriCodexHome(): string | null {
  const settings = readSettings()
  const activeId =
    settings.activeCodexManagedAccountIdsByRuntime?.host ??
    settings.activeCodexManagedAccountId ??
    null
  if (!activeId) {
    return null
  }
  return (
    settings.codexManagedAccounts?.find((account) => account.id === activeId)?.managedHomePath ??
    null
  )
}

export function readSelectedTauriCodexWslHome(wslDistro: string | null): string | null {
  const distro = wslDistro?.trim()
  if (!distro) {
    return null
  }
  const settings = readSettings()
  const accountId = settings.activeCodexManagedAccountIdsByRuntime?.wsl?.[distro] ?? null
  if (!accountId) {
    return null
  }
  const account = settings.codexManagedAccounts?.find((entry) => entry.id === accountId)
  return account?.managedHomeRuntime === 'wsl' && account.wslDistro === distro
    ? (account.wslLinuxHomePath ?? null)
    : null
}

export function hasSelectedTauriClaudeHostAccount(): boolean {
  return readClaudeHostSelection(readSettings()) !== null
}

export function readSelectedTauriClaudeWslAuth(distro: string | null): string | null {
  return readSelectedTauriClaudeWslAccount(distro)?.managedAuthPath ?? null
}

export function readSelectedTauriClaudeWslAccount(
  distro: string | null
): { accountId: string; managedAuthPath: string } | null {
  const settings = readSettings()
  const accountId =
    settings.activeClaudeManagedAccountIdsByRuntime?.wsl?.[normalizeWslDistro(distro)] ?? null
  if (!accountId) {
    return null
  }
  const account = settings.claudeManagedAccounts.find(
    (entry) =>
      entry.id === accountId &&
      entry.managedAuthRuntime === 'wsl' &&
      normalizeWslDistro(entry.wslDistro ?? null) === normalizeWslDistro(distro)
  )
  return account?.wslLinuxAuthPath
    ? { accountId: account.id, managedAuthPath: account.wslLinuxAuthPath }
    : null
}

export function readTauriClaudeManagedAccounts(): ClaudeManagedAccount[] {
  return readSettings().claudeManagedAccounts.map((account) => ({
    ...account
  }))
}

export function readTauriCodexManagedAccounts(): CodexManagedAccount[] {
  return (readSettings().codexManagedAccounts ?? []).map((account) => ({
    ...account
  }))
}

export function readTauriActiveManagedAccountIds(): {
  claude: Set<string>
  codex: Set<string>
} {
  const settings = readSettings()
  return {
    claude: new Set(
      [
        readClaudeHostSelection(settings),
        ...Object.values(settings.activeClaudeManagedAccountIdsByRuntime?.wsl ?? {})
      ].filter((value): value is string => Boolean(value))
    ),
    codex: new Set(
      [
        settings.activeCodexManagedAccountIdsByRuntime?.host ??
          settings.activeCodexManagedAccountId ??
          null,
        ...Object.values(settings.activeCodexManagedAccountIdsByRuntime?.wsl ?? {})
      ].filter((value): value is string => Boolean(value))
    )
  }
}
