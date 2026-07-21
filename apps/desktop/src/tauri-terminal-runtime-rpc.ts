import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalResolvePane
} from '../../../packages/product-core/shared/runtime-types'
import { parsePaneKey } from '../../../packages/product-core/shared/stable-pane-id'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  type RuntimeTerminalRpcResult,
  handled,
  readCursor,
  readNumber,
  readObject,
  readRequiredString,
  readString,
  readTimestamp,
  normalizeRuntimeWorktreeId
} from './tauri-terminal-rpc-value-readers'
import {
  type RuntimeSession,
  commandName,
  isLiveSession,
  isRunningAgent,
  listSessions,
  mapRuntimeSessionToTerminal,
  readPaneRuntimeId,
  readSessionFromParams,
  toTerminalState
} from './tauri-terminal-session-store'
import {
  closeTerminal,
  createTerminal,
  focusTerminal,
  sendTerminalInput,
  splitTerminal,
  stopExactTerminals,
  stopTerminals,
  waitForTerminal
} from './tauri-terminal-lifecycle-commands'

type RuntimeTerminalTranscriptRead = {
  tail: string[]
  truncated: boolean
  limited: boolean
  oldestCursor: string
  nextCursor: string
  latestCursor: string
  returnedLineCount: number
}

export async function callTauriTerminalRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeTerminalRpcResult> {
  switch (method) {
    case 'terminal.create':
      return handled({ terminal: await createTerminal(params) })
    case 'terminal.list':
      return handled(await listTerminals(params))
    case 'terminal.resolveActive':
      return handled({ handle: await resolveActiveTerminal(params) })
    case 'terminal.show':
      return handled({ terminal: await showTerminal(params) })
    case 'terminal.read':
      return handled({ terminal: await readTerminal(params) })
    case 'terminal.inspectProcess':
      return handled({ process: await inspectTerminalProcess(params) })
    case 'terminal.clearBuffer':
      return handled({ clear: await clearTerminalBuffer(params) })
    case 'terminal.send':
      return handled({ send: await sendTerminalInput(params) })
    case 'terminal.wait':
      return handled({ wait: await waitForTerminal(params) })
    case 'terminal.agentStatus':
      return handled({ agentStatus: await readTerminalAgentStatus(params) })
    case 'terminal.isRunningAgent':
      return handled({ isRunningAgent: isRunningAgent(await readSessionFromParams(params)) })
    case 'terminal.resolvePane':
      return handled({ terminal: await resolveTerminalPane(params) })
    case 'terminal.stop':
      return handled(await stopTerminals(params))
    case 'terminal.stopExact':
      return handled(await stopExactTerminals(params))
    case 'terminal.focus':
      return handled({ focus: await focusTerminal(params) })
    case 'terminal.close':
      return handled({ close: await closeTerminal(params) })
    case 'terminal.split':
      return handled({ split: await splitTerminal(params) })
    default:
      return { handled: false }
  }
}

async function listTerminals(params: unknown) {
  const input = readObject(params)
  const worktreeId = normalizeRuntimeWorktreeId(readString(input.worktree))
  const limit = Math.max(1, Math.min(readNumber(input.limit) ?? 200, 10_000))
  const sessions = await listSessions()
  const filtered = worktreeId
    ? sessions.filter((session) => session.worktreeId === worktreeId)
    : sessions
  const terminals = filtered.slice(0, limit).map(mapRuntimeSessionToTerminal)
  return {
    terminals,
    totalCount: filtered.length,
    truncated: filtered.length > terminals.length
  }
}

async function resolveActiveTerminal(params: unknown): Promise<string | null> {
  const worktreeId = normalizeRuntimeWorktreeId(readString(readObject(params).worktree))
  const sessions = (await listSessions()).filter(
    (session) => isLiveSession(session) && (!worktreeId || session.worktreeId === worktreeId)
  )
  sessions.sort((left, right) => {
    const leftUpdated = readTimestamp(left.updatedAt) ?? 0
    const rightUpdated = readTimestamp(right.updatedAt) ?? 0
    return rightUpdated - leftUpdated
  })
  return sessions[0]?.id ?? null
}

async function showTerminal(params: unknown) {
  const session = await readSessionFromParams(params)
  return {
    ...mapRuntimeSessionToTerminal(session),
    paneRuntimeId: readPaneRuntimeId(session),
    ptyId: session.id,
    rendererGraphEpoch: readTimestamp(session.updatedAt) ?? Date.now()
  }
}

async function readTerminal(params: unknown) {
  const input = readObject(params)
  const session = await readSessionFromParams(params)
  const limit = Math.max(1, Math.min(readNumber(input.limit) ?? 200, 2000))
  const cursor = readCursor(input.cursor)
  const query = new URLSearchParams({ limit: String(limit) })
  if (cursor !== null) {
    query.set('cursor', String(cursor))
  }
  const transcript = await requestRuntimeJson<RuntimeTerminalTranscriptRead>(
    `/v1/sessions/${encodeURIComponent(session.id)}/transcript?${query.toString()}`,
    { method: 'GET' }
  )
  return {
    handle: session.id,
    status: toTerminalState(session),
    ...transcript
  }
}

async function inspectTerminalProcess(params: unknown): Promise<{
  foregroundProcess: string | null
  hasChildProcesses: boolean
}> {
  const session = await readSessionFromParams(params)
  const status = await requestRuntimeJson<RuntimeSession>(
    `/v1/sessions/${encodeURIComponent(session.id)}/status`,
    { method: 'GET' }
  )
  return {
    foregroundProcess:
      isLiveSession(status) && status.foregroundProcess
        ? status.foregroundProcess
        : isLiveSession(status)
          ? commandName(status.command)
          : null,
    hasChildProcesses: status.hasChildProcesses === true
  }
}

async function clearTerminalBuffer(params: unknown) {
  const session = await readSessionFromParams(params)
  const cleared = await requestRuntimeJson<RuntimeSession>(
    `/v1/sessions/${encodeURIComponent(session.id)}/clear-buffer`,
    { method: 'POST' }
  )
  return {
    handle: cleared.id,
    status: toTerminalState(cleared)
  }
}

async function readTerminalAgentStatus(params: unknown): Promise<RuntimeTerminalAgentStatus> {
  const session = await readSessionFromParams(params)
  const runningAgent = isRunningAgent(session)
  return {
    handle: session.id,
    isRunningAgent: runningAgent,
    // Hook-reported readiness (working/idle/permission) wins when present;
    // an agent PTY with no hook events yet is assumed working.
    status: runningAgent ? (session.hookAgentState ?? 'working') : null
  }
}

async function resolveTerminalPane(params: unknown): Promise<RuntimeTerminalResolvePane | null> {
  const paneKey = readRequiredString(readObject(params).paneKey, 'pane key')
  const parsed = parsePaneKey(paneKey)
  const sessions = await listSessions()
  const session = sessions.find((candidate) => {
    if (parsed) {
      return candidate.tabId === parsed.tabId && candidate.leafId === parsed.leafId
    }
    return `${candidate.tabId ?? ''}:${candidate.leafId ?? ''}` === paneKey
  })
  if (!session) {
    return null
  }
  return {
    handle: session.id,
    tabId: session.tabId || `tab-${session.id}`,
    leafId: session.leafId || `leaf-${session.id}`,
    ptyId: session.id
  }
}
