import { invoke } from '@tauri-apps/api/core'

import type {
  PreflightStatus,
  RefreshAgentsResult
} from '../../../packages/product-core/shared/preflight-api-types'
import {
  getTuiAgentDetectCommands,
  TUI_AGENT_CONFIG
} from '../../../packages/product-core/shared/tui-agent-config'
import type {
  PathSource,
  ShellHydrationFailureReason,
  TuiAgent
} from '../../../packages/product-core/shared/types'
import { readPebbleStatusOrNull } from './pebble-tauri-runtime-transport'

const agentCommandEntries = Object.entries(TUI_AGENT_CONFIG).flatMap(([id, config]) =>
  getTuiAgentDetectCommands(config).map((command) => ({
    id: id as TuiAgent,
    command
  }))
)

const preflightCommands = ['git', 'gh', 'glab']
const authProbeCommands = ['gh', 'glab']

type PreflightAuthStatus = {
  command: string
  installed: boolean
  authenticated: boolean
}

type PreflightShellPath = {
  segments: string[]
  ok: boolean
  pathSource: PathSource
  pathFailureReason: ShellHydrationFailureReason
}

export async function readTauriPreflightStatus(
  fallback: PreflightStatus
): Promise<PreflightStatus> {
  const [status, commands, auth] = await Promise.all([
    readPebbleStatusOrNull(),
    detectAvailableCommands(preflightCommands),
    probeAuthStatuses(authProbeCommands)
  ])
  const gh = auth.get('gh')
  const glab = auth.get('glab')
  return {
    ...fallback,
    git: {
      installed:
        commands.has('git') || (status !== null && !status.unavailableTools?.includes('git'))
    },
    // Why: `installed` from the auth probe reflects a real `gh`/`glab auth
    // status` run (which resolves the binary on PATH before probing), so it
    // supersedes the lighter file-existence check from detectAvailableCommands.
    gh: {
      installed: gh?.installed ?? commands.has('gh'),
      authenticated: gh?.authenticated ?? false
    },
    glab: {
      installed: glab?.installed ?? commands.has('glab'),
      authenticated: glab?.authenticated ?? false
    }
  }
}

export async function detectTauriAgents(): Promise<string[]> {
  const availableCommands = await detectAvailableCommands(
    agentCommandEntries.map(({ command }) => command)
  )
  return unique(
    agentCommandEntries.filter(({ command }) => availableCommands.has(command)).map(({ id }) => id)
  )
}

export async function refreshTauriAgents(): Promise<RefreshAgentsResult> {
  // Why: hydrate PATH from the user's login shell first (matching Electron's
  // refreshShellPathAndDetectAgents) so a freshly installed CLI is visible.
  // The Rust command only reports the shell PATH; unlike Electron it does not
  // mutate this process's PATH, so addedPathSegments stays [] and detection
  // still runs against the native PATH resolution in preflight_detect_commands.
  const [shellPath, agents] = await Promise.all([hydrateShellPath(), detectTauriAgents()])
  return {
    agents,
    addedPathSegments: [],
    shellHydrationOk: shellPath.ok,
    pathSource: shellPath.pathSource,
    pathFailureReason: shellPath.pathFailureReason
  }
}

async function detectAvailableCommands(commands: string[]): Promise<Set<string>> {
  const found = await invoke<string[]>('preflight_detect_commands', {
    input: { commands: unique(commands) }
  })
  return new Set(found)
}

async function probeAuthStatuses(commands: string[]): Promise<Map<string, PreflightAuthStatus>> {
  const results = await invoke<PreflightAuthStatus[]>('preflight_probe_auth', {
    input: { commands: unique(commands) }
  })
  return new Map(results.map((status) => [status.command, status]))
}

async function hydrateShellPath(): Promise<PreflightShellPath> {
  return invoke<PreflightShellPath>('preflight_hydrate_shell_path')
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)]
}
