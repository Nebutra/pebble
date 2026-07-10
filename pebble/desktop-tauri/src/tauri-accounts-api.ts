import type { PreloadApi } from '../../../src/preload/api-types'

// Why: codexAccounts/claudeAccounts own OAuth login (spawning the `codex`/
// `claude` CLI, capturing interactive auth), OS Keychain storage, and
// WSL-vs-host runtime selection (src/main/codex-accounts/service.ts,
// src/main/claude-accounts/service.ts — ~1000 lines each). None of that has a
// Go-runtime home (it is local-desktop-only, keyed off the host's installed
// CLI + keychain) and reimplementing OAuth/keychain flows in Rust is a much
// bigger lift than this bridging pass, with real risk of mishandling
// credentials if ported hastily. Both namespaces stay on the web preload's
// honest empty-state fallback (no accounts, nothing selected) rather than a
// half-ported native flow — matching the explicit-gap pattern used elsewhere
// in this bridge (see tauri-agent-hooks-api.ts for agents outside
// Claude/OpenClaude, and computer_permissions.rs for Linux/Windows).
type CodexAccountsApi = NonNullable<Partial<PreloadApi>['codexAccounts']>
type ClaudeAccountsApi = NonNullable<Partial<PreloadApi>['claudeAccounts']>

export function createPebbleCodexAccountsApi(base: CodexAccountsApi): CodexAccountsApi {
  return { ...base }
}

export function createPebbleClaudeAccountsApi(base: ClaudeAccountsApi): ClaudeAccountsApi {
  return { ...base }
}
