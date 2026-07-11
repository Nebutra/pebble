import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../src/preload/api-types'
import { hasTauriInternals } from './pebble-runtime-http-bridge'

// Shipped-vs-gap matrix (vs src/main/codex-accounts/service.ts and
// src/main/claude-accounts/service.ts):
// - host auth detection: SHIPPED — commands/agent_accounts.rs reads the same
//   credential stores the CLIs write ($CODEX_HOME/auth.json id_token claims;
//   Claude's macOS Keychain item / ~/.claude/.credentials.json plus the
//   oauthAccount identity in ~/.claude.json). The rate-limit fetchers consume
//   it directly, and add() surfaces it in its gap message below.
// - list/select(null)/cancelPendingLogin: SHIPPED with the only truthful
//   values — the managed-account store is empty because accounts can only be
//   created by add()'s interactive flow.
// - add/reauthenticate:  GAP — Electron spawns the `codex`/`claude` CLI in a
//   captive PTY and drives a browser OAuth dance, then quarantines the
//   captured credentials into a Pebble-managed home. That interactive flow
//   (and its WSL variant) genuinely needs infrastructure the Tauri shell does
//   not have yet, so these reject with an explicit error instead of faking a
//   login.
// - remove/select(id):   same "no longer exists" error Electron raises for an
//   unknown id, which is every id while the store cannot gain entries.
type CodexAccountsApi = NonNullable<Partial<PreloadApi>['codexAccounts']>
type ClaudeAccountsApi = NonNullable<Partial<PreloadApi>['claudeAccounts']>

type HostAuthProbe = {
  codex: { authenticated: boolean; email: string | null }
  claude: { authenticated: boolean; email: string | null }
}

async function describeHostLogin(agent: 'codex' | 'claude'): Promise<string> {
  try {
    const status = await invoke<HostAuthProbe>('agent_account_auth_status')
    const probe = agent === 'codex' ? status.codex : status.claude
    if (probe.authenticated) {
      const identity = probe.email ? ` as ${probe.email}` : ''
      return ` Your existing ${agent} CLI login${identity} keeps working and powers the usage indicator.`
    }
  } catch {
    // Probe failure only degrades the error message, never the outcome.
  }
  return ''
}

async function rejectInteractiveLoginGap<T>(agent: 'codex' | 'claude'): Promise<T> {
  const hostLoginNote = await describeHostLogin(agent)
  throw new Error(
    `Adding Pebble-managed ${agent} accounts requires an interactive CLI OAuth login, ` +
      `which is not yet supported in the Tauri desktop shell.${hostLoginNote}`
  )
}

function rejectUnknownAccount<T>(agent: 'Codex' | 'Claude'): Promise<T> {
  return Promise.reject(new Error(`That ${agent} rate limit account no longer exists.`))
}

export function createPebbleCodexAccountsApi(base: CodexAccountsApi): CodexAccountsApi {
  if (!hasTauriInternals()) {
    return { ...base }
  }
  return {
    ...base,
    add: () => rejectInteractiveLoginGap('codex'),
    reauthenticate: () => rejectInteractiveLoginGap('codex'),
    remove: () => rejectUnknownAccount('Codex'),
    select: (args) =>
      // Deselecting (null) is a real no-op on an empty store; selecting an id
      // cannot succeed because no managed account can exist yet.
      args.accountId === null ? base.select(args) : rejectUnknownAccount('Codex')
  }
}

export function createPebbleClaudeAccountsApi(base: ClaudeAccountsApi): ClaudeAccountsApi {
  if (!hasTauriInternals()) {
    return { ...base }
  }
  return {
    ...base,
    add: () => rejectInteractiveLoginGap('claude'),
    reauthenticate: () => rejectInteractiveLoginGap('claude'),
    remove: () => rejectUnknownAccount('Claude'),
    select: (args) =>
      args.accountId === null ? base.select(args) : rejectUnknownAccount('Claude'),
    // No pending login can exist because add() never starts one.
    cancelPendingLogin: () => Promise.resolve(false)
  }
}
