import type { RuntimeTerminalState } from '../../../packages/product-core/shared/runtime-types'
import { isEphemeralSetupTerminalWorktreeId } from '../../../packages/product-core/shared/ephemeral-setup-terminal-worktree-id'
import { getHostPlatform, requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { readWorktrees } from './pebble-tauri-workspace-runtime-api'
import { readSelectedTauriCodexHome } from './tauri-accounts-api'
import {
  readObject,
  readString,
  readTerminalHandle,
  readTimestamp,
  normalizeRuntimeWorktreeId
} from './tauri-terminal-rpc-value-readers'

export type RuntimeSessionStatus = 'starting' | 'running' | 'exited' | 'failed' | 'stopped'

export type RuntimeSession = {
  id: string
  projectId?: string
  worktreeId?: string
  cwd: string
  command: string[]
  agentKind?: string
  tabId?: string
  leafId?: string
  status: RuntimeSessionStatus
  exitCode?: number | null
  hookAgentState?: 'working' | 'idle' | 'permission'
  updatedAt?: string
  cols?: number
  rows?: number
  altScreenActive?: boolean
  foregroundProcess?: string
  hasChildProcesses?: boolean
  foregroundProcessUnsupportedReason?: string
}

type ResolvedSessionWorktree = {
  id: string
  projectId?: string
  path: string
  ephemeral?: boolean
}

export async function readSessionFromParams(params: unknown): Promise<RuntimeSession> {
  const terminal = readTerminalHandle(params)
  const session = await findSession(terminal)
  if (!session) {
    throw new Error('terminal_gone')
  }
  return session
}

export async function findSession(id: string): Promise<RuntimeSession | null> {
  return (await listSessions()).find((session) => session.id === id) ?? null
}

export async function listSessions(): Promise<RuntimeSession[]> {
  return requestRuntimeJson<RuntimeSession[]>('/v1/sessions', { method: 'GET' })
}

export function mapRuntimeSessionToTerminal(session: RuntimeSession) {
  return {
    handle: session.id,
    ptyId: session.id,
    worktreeId: session.worktreeId ?? '',
    worktreePath: session.cwd,
    branch: '',
    tabId: session.tabId || `pty:${session.id}`,
    leafId: session.leafId || session.tabId || `pty:${session.id}`,
    title: terminalTitle(session),
    connected: isLiveSession(session),
    writable: isLiveSession(session),
    lastOutputAt: readTimestamp(session.updatedAt),
    preview: ''
  }
}

export async function resolveSessionWorktree(params: unknown): Promise<ResolvedSessionWorktree> {
  const input = readObject(params)
  const selector = normalizeRuntimeWorktreeId(
    readString(input.worktree) ?? readString(input.worktreeId)
  )
  if (!selector) {
    throw new Error('terminal_create_requires_worktree')
  }
  if (isEphemeralSetupTerminalWorktreeId(selector)) {
    const cwd = readString(input.cwd)
    if (!cwd) {
      throw new Error('ephemeral_terminal_create_requires_cwd')
    }
    // Why: inline setup terminals intentionally have no persisted worktree;
    // keep their branded scope while the native cwd resolver supplies the path.
    return { id: selector, path: cwd, ephemeral: true }
  }
  const worktree = (await readWorktrees()).find((entry) => entry.id === selector)
  const projectId = worktree?.projectId ?? worktree?.repoId
  if (!worktree || !projectId || (worktree.hostId && worktree.hostId !== 'local')) {
    throw new Error(`terminal_worktree_not_available:${selector}`)
  }
  return { id: worktree.id, projectId, path: worktree.path }
}

export function shellCommandForRuntime(command: string | null): string[] | undefined {
  if (!command) {
    return undefined
  }
  return getHostPlatform() === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', command]
    : ['/bin/sh', '-lc', command]
}

export function readAgentKind(input: Record<string, unknown>): string | undefined {
  return (
    readString(input.agentKind) ??
    readString(input.agent) ??
    readString(readObject(input.agent).id) ??
    readString(input.launchAgent) ??
    readString(readObject(input.launchAgent).id) ??
    undefined
  )
}

export function managedCodexEnvironment(
  agentKind: string | undefined,
  rawCommand: string | null
): string[] | undefined {
  if (agentKind !== 'codex' && !/^\s*codex(?:\s|$)/i.test(rawCommand ?? '')) {
    return undefined
  }
  const managedHome = readSelectedTauriCodexHome()
  return managedHome ? [`CODEX_HOME=${managedHome}`] : undefined
}

export function terminalTitle(session: RuntimeSession): string {
  return session.command.join(' ') || session.agentKind || 'Terminal'
}

export function readPaneRuntimeId(session: RuntimeSession): number {
  const leafId = session.leafId ?? ''
  const match = /(\d+)$/.exec(leafId)
  return match ? Number.parseInt(match[1], 10) : 0
}

export function isRunningAgent(session: RuntimeSession): boolean {
  return Boolean(session.agentKind?.trim()) && isLiveSession(session)
}

export function commandName(command: string[]): string | null {
  const executable = command.find((part) => part.trim().length > 0)
  if (!executable) {
    return null
  }
  const normalized = executable.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || executable
}

export function isLiveSession(session: RuntimeSession): boolean {
  return session.status === 'starting' || session.status === 'running'
}

export function toTerminalState(session: RuntimeSession): RuntimeTerminalState {
  return isLiveSession(session) ? 'running' : 'exited'
}
