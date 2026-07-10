import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../src/preload/api-types'
import type { AgentHookInstallStatus } from '../../../src/shared/agent-hook-types'
import { hasTauriInternals } from './pebble-runtime-http-bridge'

type AgentHooksApi = NonNullable<Partial<PreloadApi>['agentHooks']>

function gapStatus(agent: AgentHookInstallStatus['agent']): AgentHookInstallStatus {
  return {
    agent,
    state: 'error',
    configPath: '',
    managedHooksPresent: false,
    detail: 'Agent hook status for this agent is not yet implemented in the Tauri desktop shell.'
  }
}

// Why: only Claude and OpenClaude share the simple hooks.json shape that is
// safe to re-check from Rust (see commands/agent_hooks.rs). The other 12
// agents' bespoke config formats stay an explicit gap rather than a guessed
// status — falls back to the web preload's honest not_installed placeholder
// when Tauri internals are unavailable (e.g. during SSR-less dev preview).
function callStatus(
  command: string,
  agent: AgentHookInstallStatus['agent'],
  fallback: () => Promise<AgentHookInstallStatus>
): Promise<AgentHookInstallStatus> {
  if (!hasTauriInternals()) {
    return fallback()
  }
  return invoke<AgentHookInstallStatus>(command).catch(() => gapStatus(agent))
}

export function createPebbleAgentHooksApi(base: AgentHooksApi): AgentHooksApi {
  return {
    ...base,
    claudeStatus: () => callStatus('agent_hooks_claude_status', 'claude', base.claudeStatus),
    openClaudeStatus: () =>
      callStatus('agent_hooks_openclaude_status', 'openclaude', base.openClaudeStatus),
    codexStatus: () => Promise.resolve(gapStatus('codex')),
    geminiStatus: () => Promise.resolve(gapStatus('gemini')),
    antigravityStatus: () => Promise.resolve(gapStatus('antigravity')),
    ampStatus: () => Promise.resolve(gapStatus('amp')),
    cursorStatus: () => Promise.resolve(gapStatus('cursor')),
    droidStatus: () => Promise.resolve(gapStatus('droid')),
    commandCodeStatus: () => Promise.resolve(gapStatus('command-code')),
    grokStatus: () => Promise.resolve(gapStatus('grok')),
    copilotStatus: () => Promise.resolve(gapStatus('copilot')),
    hermesStatus: () => Promise.resolve(gapStatus('hermes')),
    devinStatus: () => Promise.resolve(gapStatus('devin')),
    kimiStatus: () => Promise.resolve(gapStatus('kimi'))
  }
}
