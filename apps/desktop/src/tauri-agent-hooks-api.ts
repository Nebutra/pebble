import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { AgentHookInstallStatus } from '../../../packages/product-core/shared/agent-hook-types'
import { hasTauriInternals } from './pebble-runtime-http-bridge'

type AgentHooksApi = NonNullable<Partial<PreloadApi>['agentHooks']>

function inspectionFailureStatus(
  agent: AgentHookInstallStatus['agent'],
  error: unknown
): AgentHookInstallStatus {
  const reason = error instanceof Error ? error.message : String(error)
  return {
    agent,
    state: 'error',
    configPath: '',
    managedHooksPresent: false,
    detail: `Could not inspect ${agent} hooks through the native desktop shell: ${reason}`
  }
}

// Why: all managed agents have source-faithful Rust adapters. The web fallback
// remains only for non-Tauri previews where native commands cannot exist.
function callStatus(
  command: string,
  agent: AgentHookInstallStatus['agent'],
  fallback: () => Promise<AgentHookInstallStatus>
): Promise<AgentHookInstallStatus> {
  if (!hasTauriInternals()) {
    return fallback()
  }
  return invoke<AgentHookInstallStatus>(command).catch((error: unknown) =>
    inspectionFailureStatus(agent, error)
  )
}

export function createPebbleAgentHooksApi(base: AgentHooksApi): AgentHooksApi {
  return {
    ...base,
    claudeStatus: () => callStatus('agent_hooks_claude_status', 'claude', base.claudeStatus),
    openClaudeStatus: () =>
      callStatus('agent_hooks_openclaude_status', 'openclaude', base.openClaudeStatus),
    codexStatus: () => callStatus('agent_hooks_codex_status', 'codex', base.codexStatus),
    geminiStatus: () => callStatus('agent_hooks_gemini_status', 'gemini', base.geminiStatus),
    antigravityStatus: () =>
      callStatus('agent_hooks_antigravity_status', 'antigravity', base.antigravityStatus),
    ampStatus: () => callStatus('agent_hooks_amp_status', 'amp', base.ampStatus),
    cursorStatus: () => callStatus('agent_hooks_cursor_status', 'cursor', base.cursorStatus),
    droidStatus: () => callStatus('agent_hooks_droid_status', 'droid', base.droidStatus),
    commandCodeStatus: () =>
      callStatus('agent_hooks_command_code_status', 'command-code', base.commandCodeStatus),
    grokStatus: () => callStatus('agent_hooks_grok_status', 'grok', base.grokStatus),
    copilotStatus: () => callStatus('agent_hooks_copilot_status', 'copilot', base.copilotStatus),
    hermesStatus: () => callStatus('agent_hooks_hermes_status', 'hermes', base.hermesStatus),
    devinStatus: () => callStatus('agent_hooks_devin_status', 'devin', base.devinStatus),
    kimiStatus: () => callStatus('agent_hooks_kimi_status', 'kimi', base.kimiStatus)
  }
}

export async function reconcileTauriManagedAgentHooks(enabled: boolean): Promise<void> {
  if (!hasTauriInternals()) {
    return
  }
  await Promise.all([
    invoke('agent_hooks_apply_claude_compatible', { enabled }),
    invoke('agent_hooks_apply_gemini', { enabled }),
    invoke('agent_hooks_apply_cursor', { enabled }),
    invoke('agent_hooks_apply_droid', { enabled }),
    invoke('agent_hooks_apply_command_code', { enabled }),
    invoke('agent_hooks_apply_grok', { enabled }),
    invoke('agent_hooks_apply_devin', { enabled }),
    invoke('agent_hooks_apply_kimi', { enabled }),
    invoke('agent_hooks_apply_amp', { enabled }),
    invoke('agent_hooks_apply_copilot', { enabled }),
    invoke('agent_hooks_apply_antigravity', { enabled }),
    invoke('agent_hooks_apply_hermes', { enabled }),
    invoke('agent_hooks_apply_codex', { enabled })
  ])
}
