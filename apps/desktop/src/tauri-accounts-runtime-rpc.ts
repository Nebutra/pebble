import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../packages/product-core/shared/types'

type RuntimeAccountsRpcResult = {
  handled: boolean
  result?: unknown
}

export async function callTauriAccountsRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeAccountsRpcResult> {
  switch (method) {
    case 'accounts.list':
      return handled({
        claude: await window.api.claudeAccounts.list(),
        codex: await window.api.codexAccounts.list(),
        rateLimits: await window.api.rateLimits.refresh()
      })
    case 'accounts.selectClaude':
      return handled(await selectAccount('claude', params))
    case 'accounts.selectCodex':
      return handled(await selectAccount('codex', params))
    case 'accounts.removeClaude':
      return handled(
        await window.api.claudeAccounts.remove({
          accountId: readRequiredAccountId(params)
        })
      )
    case 'accounts.removeCodex':
      return handled(
        await window.api.codexAccounts.remove({
          accountId: readRequiredAccountId(params)
        })
      )
    default:
      return { handled: false }
  }
}

async function selectAccount(
  provider: 'claude' | 'codex',
  params: unknown
): Promise<ClaudeRateLimitAccountsState | CodexRateLimitAccountsState> {
  const target = readAccountSelection(params)
  if (provider === 'claude') {
    return window.api.claudeAccounts.select(target)
  }
  return window.api.codexAccounts.select(target)
}

function readAccountSelection(params: unknown): {
  accountId: string | null
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
} {
  const accountId = readAccountId(params)
  const record = params as Record<string, unknown>
  const runtime = record.runtime
  if (runtime !== undefined && runtime !== 'host' && runtime !== 'wsl') {
    throw new Error('Invalid account runtime')
  }
  const wslDistro = record.wslDistro
  if (wslDistro !== undefined && wslDistro !== null && typeof wslDistro !== 'string') {
    throw new Error('Invalid WSL distro')
  }
  return {
    accountId,
    ...(runtime ? { runtime } : {}),
    ...(wslDistro !== undefined
      ? {
          wslDistro: typeof wslDistro === 'string' ? wslDistro.trim() || null : null
        }
      : {})
  }
}

function readAccountId(params: unknown): string | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('Missing accountId')
  }
  const value = (params as Record<string, unknown>).accountId
  if (value === null) {
    return null
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Missing accountId')
  }
  return value.trim()
}

function readRequiredAccountId(params: unknown): string {
  const accountId = readAccountId(params)
  if (accountId === null) {
    throw new Error('Missing accountId')
  }
  return accountId
}

function handled(result: unknown): RuntimeAccountsRpcResult {
  return { handled: true, result }
}
