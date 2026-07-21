import type {
  ClaudeManagedAccount,
  ClaudeRateLimitAccountsState,
  CodexManagedAccount,
  CodexRateLimitAccountsState,
  GlobalSettings
} from '../../../packages/product-core/shared/types'
import {
  readPersistentSettingsRaw,
  writePersistentSettingsRaw
} from '../../../packages/product-core/renderer/src/web/persistent-settings-backend'
import { requestRuntimeJson } from './pebble-runtime-http-bridge'

export type RuntimeSession = {
  id: string
  status: 'starting' | 'running' | 'exited' | 'failed' | 'stopped'
  exitCode?: number | null
  agentKind?: string
  command?: string[]
}
type RuntimeOutputChunk = { content: string }

export const SETTINGS_STORAGE_KEY = 'pebble.web.settings.v1'
export const LOGIN_TIMEOUT_MS = 120_000
export const LOGIN_POLL_MS = 200

let codexMutationQueue: Promise<unknown> = Promise.resolve()
let claudeMutationQueue: Promise<unknown> = Promise.resolve()

export function readSettings(): GlobalSettings {
  if (typeof window === 'undefined' || !window.localStorage) {
    return createAccountSettingsDefaults()
  }
  const raw = readPersistentSettingsRaw(SETTINGS_STORAGE_KEY)
  const parsed = raw ? (JSON.parse(raw) as Partial<GlobalSettings>) : {}
  return {
    ...parsed,
    codexManagedAccounts: parsed.codexManagedAccounts ?? [],
    activeCodexManagedAccountId: parsed.activeCodexManagedAccountId ?? null,
    claudeManagedAccounts: parsed.claudeManagedAccounts ?? [],
    activeClaudeManagedAccountId: parsed.activeClaudeManagedAccountId ?? null
  } as unknown as GlobalSettings
}

function createAccountSettingsDefaults(): GlobalSettings {
  return {
    codexManagedAccounts: [],
    activeCodexManagedAccountId: null,
    claudeManagedAccounts: [],
    activeClaudeManagedAccountId: null
  } as unknown as GlobalSettings
}

export function writeSettings(settings: GlobalSettings): void {
  writePersistentSettingsRaw(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
}

export function readClaudeHostSelection(settings: GlobalSettings): string | null {
  return (
    settings.activeClaudeManagedAccountIdsByRuntime?.host ??
    settings.activeClaudeManagedAccountId ??
    null
  )
}

export function normalizeWslDistro(distro: string | null): string {
  return distro?.trim() || '__default__'
}

export function requireClaudeAccount(accountId: string): ClaudeManagedAccount {
  const account = readSettings().claudeManagedAccounts.find((entry) => entry.id === accountId)
  if (!account) {
    throw new Error('That Claude account no longer exists.')
  }
  return account
}

export function requireCodexAccount(accountId: string): CodexManagedAccount {
  const account = readSettings().codexManagedAccounts?.find((entry) => entry.id === accountId)
  if (!account) {
    throw new Error('That Codex rate limit account no longer exists.')
  }
  return account
}

export function serializeCodexMutation<T>(mutation: () => Promise<T> | T): Promise<T> {
  const next = codexMutationQueue.then(mutation, mutation)
  codexMutationQueue = next.catch(() => undefined)
  return next
}

export function serializeClaudeMutation<T>(mutation: () => Promise<T> | T): Promise<T> {
  const next = claudeMutationQueue.then(mutation, mutation)
  claudeMutationQueue = next.catch(() => undefined)
  return next
}

export function refreshRateLimitsQuietly(): Promise<unknown> {
  return window.api.rateLimits.refresh().catch(() => undefined)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function stopRuntimeSession(sessionId: string): Promise<unknown> {
  return requestRuntimeJson(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    timeoutMs: 2500
  })
}

export async function readLoginOutput(sessionId: string): Promise<string> {
  const chunks = await requestRuntimeJson<RuntimeOutputChunk[]>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/tail?limit=80`,
    { method: 'GET', timeoutMs: 2500 }
  ).catch(() => [])
  return chunks
    .map((chunk) => chunk.content)
    .join('')
    .trim()
    .slice(-4000)
}

export function readCodexSnapshot(): CodexRateLimitAccountsState {
  const settings = readSettings()
  const accounts = (settings.codexManagedAccounts ?? [])
    .map(({ managedHomePath: _path, wslLinuxHomePath: _wslPath, ...account }) => account)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const host =
    settings.activeCodexManagedAccountIdsByRuntime?.host ??
    settings.activeCodexManagedAccountId ??
    null
  return {
    accounts,
    activeAccountId: host,
    activeAccountIdsByRuntime: {
      host,
      wsl: settings.activeCodexManagedAccountIdsByRuntime?.wsl ?? {}
    }
  }
}

export function readClaudeSnapshot(): ClaudeRateLimitAccountsState {
  const settings = readSettings()
  const accounts = settings.claudeManagedAccounts
    .map(({ managedAuthPath: _path, wslLinuxAuthPath: _wslPath, ...account }) => account)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const host = readClaudeHostSelection(settings)
  return {
    accounts,
    activeAccountId: host,
    activeAccountIdsByRuntime: {
      host,
      wsl: settings.activeClaudeManagedAccountIdsByRuntime?.wsl ?? {}
    }
  }
}
