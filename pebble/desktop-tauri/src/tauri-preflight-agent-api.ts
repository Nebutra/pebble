import { invoke } from '@tauri-apps/api/core'

import type {
  PreflightStatus,
  RefreshAgentsResult
} from '../../../src/preload/api-types'
import { getTuiAgentDetectCommands, TUI_AGENT_CONFIG } from '../../../src/shared/tui-agent-config'
import type { TuiAgent } from '../../../src/shared/types'
import { readPebbleStatusOrNull } from './pebble-tauri-runtime-transport'

const agentCommandEntries = Object.entries(TUI_AGENT_CONFIG).flatMap(([id, config]) =>
  getTuiAgentDetectCommands(config).map((command) => ({
    id: id as TuiAgent,
    command
  }))
)

const preflightCommands = ['git', 'gh', 'glab']

export async function readTauriPreflightStatus(
  fallback: PreflightStatus
): Promise<PreflightStatus> {
  const [status, commands] = await Promise.all([
    readPebbleStatusOrNull(),
    detectAvailableCommands(preflightCommands)
  ])
  return {
    ...fallback,
    git: { installed: commands.has('git') || !status?.unavailableTools?.includes('git') },
    gh: { installed: commands.has('gh'), authenticated: false },
    glab: { installed: commands.has('glab'), authenticated: false }
  }
}

export async function detectTauriAgents(): Promise<string[]> {
  const availableCommands = await detectAvailableCommands(
    agentCommandEntries.map(({ command }) => command)
  )
  return unique(
    agentCommandEntries
      .filter(({ command }) => availableCommands.has(command))
      .map(({ id }) => id)
  )
}

export async function refreshTauriAgents(): Promise<RefreshAgentsResult> {
  return {
    agents: await detectTauriAgents(),
    addedPathSegments: [],
    shellHydrationOk: false,
    pathSource: 'sync_seed_only',
    pathFailureReason: 'spawn_error'
  }
}

async function detectAvailableCommands(commands: string[]): Promise<Set<string>> {
  const found = await invoke<string[]>('preflight_detect_commands', {
    input: { commands: unique(commands) }
  })
  return new Set(found)
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)]
}
