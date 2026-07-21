import { invoke } from '@tauri-apps/api/core'

import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-runtime-http-bridge'
import {
  type RuntimeSession,
  LOGIN_POLL_MS,
  delay,
  readLoginOutput,
  shellQuote,
  stopRuntimeSession
} from './tauri-account-settings-store'

export type ManagedClaudeLocation = {
  managedAuthPath: string
  managedAuthRuntime: 'host' | 'wsl'
  wslDistro: string | null
  wslLinuxAuthPath: string | null
  temporaryConfigPath: string
}
export type ClaudeIdentity = {
  email: string
  authMethod: 'subscription-oauth'
  organizationUuid: string | null
  organizationName: string | null
}

let pendingClaudeLoginSessionId: string | null = null

export async function loginAndCaptureClaude(
  accountId: string,
  location: ManagedClaudeLocation
): Promise<ClaudeIdentity> {
  await runClaudeCommand(location, ['claude', 'auth', 'login', '--claudeai'])
  const statusOutput = await runClaudeCommand(
    location,
    ['claude', 'auth', 'status', '--json'],
    true
  )
  return invoke('managed_claude_account_capture', {
    accountId,
    managedAuthPath: location.managedAuthPath,
    temporaryConfigPath: location.temporaryConfigPath,
    statusOutput,
    managedAuthRuntime: location.managedAuthRuntime,
    wslDistro: location.wslDistro,
    wslLinuxAuthPath: location.wslLinuxAuthPath
  })
}

async function runClaudeCommand(
  location: ManagedClaudeLocation,
  command: string[],
  allowFailure = false
): Promise<string> {
  await ensurePebbleRuntimeProcess()
  const commandToRun =
    location.managedAuthRuntime === 'wsl' ? buildWslClaudeCommand(location, command) : command
  const session = await requestRuntimeJson<RuntimeSession>('/v1/sessions', {
    method: 'POST',
    timeoutMs: 5000,
    body: {
      ephemeral: true,
      cwd: location.managedAuthRuntime === 'wsl' ? '' : location.temporaryConfigPath,
      command: commandToRun,
      environment:
        location.managedAuthRuntime === 'wsl'
          ? undefined
          : [`CLAUDE_CONFIG_DIR=${location.temporaryConfigPath}`],
      cols: 100,
      rows: 30
    }
  })
  pendingClaudeLoginSessionId = session.id
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const current = (
      await requestRuntimeJson<RuntimeSession[]>('/v1/sessions', {
        method: 'GET',
        timeoutMs: 2500
      })
    ).find((entry) => entry.id === session.id)
    if (!current) {
      throw new Error('Claude login session disappeared before it finished.')
    }
    if (current.status === 'exited' && (current.exitCode === 0 || allowFailure)) {
      pendingClaudeLoginSessionId = null
      return readLoginOutput(session.id)
    }
    if (
      current.status === 'failed' ||
      current.status === 'stopped' ||
      current.status === 'exited'
    ) {
      pendingClaudeLoginSessionId = null
      const output = await readLoginOutput(session.id)
      throw new Error(output ? `Claude command failed: ${output}` : 'Claude command failed.')
    }
    const output = await readLoginOutput(session.id)
    if (
      /\baccess_denied\b|authorization (?:request )?(?:was )?denied|sign-?in (?:was )?denied/i.test(
        output
      )
    ) {
      await stopRuntimeSession(session.id)
      pendingClaudeLoginSessionId = null
      throw new Error('Claude sign-in was denied. Please try again.')
    }
    await delay(LOGIN_POLL_MS)
  }
  await stopRuntimeSession(session.id)
  pendingClaudeLoginSessionId = null
  throw new Error('Claude sign-in took too long to finish.')
}

function buildWslClaudeCommand(location: ManagedClaudeLocation, command: string[]): string[] {
  if (!location.wslDistro) {
    throw new Error('Managed Claude WSL distro is missing.')
  }
  const executable = command[0] === 'claude' ? command.slice(1) : command
  const script = `export CLAUDE_CONFIG_DIR=${shellQuote(location.temporaryConfigPath)}; exec claude ${executable.map(shellQuote).join(' ')}`
  return ['wsl.exe', '-d', location.wslDistro, '--exec', 'bash', '-lc', script]
}

export async function cancelPendingClaudeLogin(): Promise<boolean> {
  const sessionId = pendingClaudeLoginSessionId
  if (!sessionId) {
    return false
  }
  pendingClaudeLoginSessionId = null
  await stopRuntimeSession(sessionId)
  return true
}

export async function assertNoLiveClaudeSessions(): Promise<void> {
  await ensurePebbleRuntimeProcess()
  const sessions = await requestRuntimeJson<RuntimeSession[]>('/v1/sessions', {
    method: 'GET',
    timeoutMs: 2500
  })
  const hasLiveClaude = sessions.some((session) => {
    if (session.status !== 'starting' && session.status !== 'running') {
      return false
    }
    if (session.agentKind === 'claude') {
      return true
    }
    return session.command?.some((part) => /(^|[\\/])claude(?:\.exe)?$/i.test(part)) === true
  })
  if (hasLiveClaude) {
    throw new Error('Close running Claude terminals before switching managed accounts.')
  }
}
