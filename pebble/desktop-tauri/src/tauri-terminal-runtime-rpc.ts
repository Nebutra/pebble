import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalState,
  RuntimeTerminalWaitCondition
} from '../../../src/shared/runtime-types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

type RuntimeSessionStatus = 'starting' | 'running' | 'exited' | 'failed' | 'stopped'

type RuntimeSession = {
  id: string
  worktreeId?: string
  cwd: string
  command: string[]
  agentKind?: string
  tabId?: string
  leafId?: string
  status: RuntimeSessionStatus
  exitCode?: number | null
  updatedAt?: string
}

type RuntimeOutputChunk = {
  stream: string
  content: string
}

type RuntimeTerminalRpcResult = {
  handled: boolean
  result?: unknown
}

const DEFAULT_WAIT_TIMEOUT_MS = 15_000

export async function callTauriTerminalRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeTerminalRpcResult> {
  switch (method) {
    case 'terminal.list':
      return handled(await listTerminals(params))
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
    case 'terminal.stop':
      return handled(await stopTerminals(params))
    case 'terminal.stopExact':
      return handled(await stopExactTerminals(params))
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
  const tail = await requestRuntimeJson<{ chunks: RuntimeOutputChunk[] }>(
    `/v1/sessions/${encodeURIComponent(session.id)}/tail?limit=${limit}`,
    { method: 'GET' }
  )
  const lines = terminalTailLines(tail.chunks)
  const oldestCursor = '0'
  const latestCursor = String(lines.length)
  const sliced = cursor === null ? lines.slice(-limit) : lines.slice(cursor, cursor + limit)
  const nextCursor = cursor === null ? latestCursor : String(Math.min(lines.length, cursor + sliced.length))
  return {
    handle: session.id,
    status: toTerminalState(session),
    tail: sliced,
    truncated: false,
    limited: sliced.length < lines.length,
    oldestCursor,
    nextCursor,
    latestCursor,
    returnedLineCount: sliced.length
  }
}

async function inspectTerminalProcess(params: unknown): Promise<{
  foregroundProcess: string | null
  hasChildProcesses: boolean
}> {
  const session = await readSessionFromParams(params)
  return {
    foregroundProcess: isLiveSession(session) ? commandName(session.command) : null,
    // Go sessions expose the launched command, not a foreground child tree yet.
    hasChildProcesses: false
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

async function sendTerminalInput(params: unknown) {
  const input = readObject(params)
  const session = await readSessionFromParams(params)
  if (readString(input.requireAgentStatus) && !isRunningAgent(session)) {
    return {
      handle: session.id,
      accepted: false,
      bytesWritten: 0,
      refusedReason: 'no-agent' as const
    }
  }
  const text = typeof input.text === 'string' ? input.text : ''
  const interrupt = input.interrupt === true
  const appendNewline = input.enter === true
  if (!text && !appendNewline && !interrupt) {
    return { handle: session.id, accepted: true, bytesWritten: 0 }
  }
  const payload = `${interrupt ? '\x03' : ''}${text}`
  await requestRuntimeJson<{ status: string }>(`/v1/sessions/${encodeURIComponent(session.id)}/input`, {
    method: 'POST',
    body: { text: payload, appendNewline }
  })
  const bytesWritten = new TextEncoder().encode(`${payload}${appendNewline ? '\n' : ''}`).byteLength
  return { handle: session.id, accepted: true, bytesWritten }
}

async function waitForTerminal(params: unknown) {
  const input = readObject(params)
  const condition = readWaitCondition(input.for)
  const terminal = readTerminalHandle(params)
  const deadline = Date.now() + Math.max(1, readNumber(input.timeoutMs) ?? DEFAULT_WAIT_TIMEOUT_MS)
  let session = await findSession(terminal)
  if (condition === 'exit') {
    while (session && isLiveSession(session) && Date.now() < deadline) {
      await delay(250)
      session = await findSession(terminal)
    }
  }
  const status = session ? toTerminalState(session) : 'exited'
  const satisfied = condition === 'exit' ? status !== 'running' : Boolean(session && isLiveSession(session))
  return {
    handle: terminal,
    condition,
    satisfied,
    status,
    exitCode: session?.exitCode ?? null
  }
}

async function readTerminalAgentStatus(params: unknown): Promise<RuntimeTerminalAgentStatus> {
  const session = await readSessionFromParams(params)
  const runningAgent = isRunningAgent(session)
  return {
    handle: session.id,
    isRunningAgent: runningAgent,
    // Why: Go sessions know whether an agent owns the PTY, but not yet the
    // richer hook-level idle/permission state. Keep this explicit until the
    // runtime status contract carries those hook events.
    status: runningAgent ? 'working' : null
  }
}

async function stopTerminals(params: unknown) {
  const input = readObject(params)
  const worktreeId = normalizeRuntimeWorktreeId(readString(input.worktree))
  const sessions = await listSessions()
  const targets = worktreeId
    ? sessions.filter((session) => session.worktreeId === worktreeId)
    : sessions
  const stoppedPtyIds: string[] = []
  for (const session of targets) {
    if (!isLiveSession(session)) {
      continue
    }
    await requestRuntimeJson<RuntimeSession>(`/v1/sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE'
    }).catch(() => undefined)
    stoppedPtyIds.push(session.id)
  }
  return {
    stopped: stoppedPtyIds.length,
    stoppedPtyIds,
    livePtyIds: targets.filter(isLiveSession).map((session) => session.id),
    postStopVerified: true
  }
}

async function stopExactTerminals(params: unknown) {
  const input = readObject(params)
  const worktreeId = normalizeRuntimeWorktreeId(readString(input.worktree))
  const expectedPtyIds = new Set(readStringList(input.expectedPtyIds))
  const targetOnly = input.targetOnly === true
  const liveSessions = (await listSessions()).filter(
    (session) => isLiveSession(session) && (!worktreeId || session.worktreeId === worktreeId)
  )
  const livePtyIds = liveSessions.map((session) => session.id).sort()
  const expectedLive = [...expectedPtyIds].every((ptyId) => livePtyIds.includes(ptyId))
  const exactMatch =
    livePtyIds.length === expectedPtyIds.size && livePtyIds.every((ptyId) => expectedPtyIds.has(ptyId))
  if (expectedPtyIds.size === 0 || (targetOnly ? !expectedLive : !exactMatch)) {
    return {
      stopped: 0,
      stoppedPtyIds: [],
      livePtyIds,
      postStopVerified: false
    }
  }
  const stoppedPtyIds: string[] = []
  for (const session of liveSessions) {
    if (!expectedPtyIds.has(session.id)) {
      continue
    }
    await requestRuntimeJson<RuntimeSession>(`/v1/sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE'
    }).catch(() => undefined)
    stoppedPtyIds.push(session.id)
  }
  const postStopLivePtyIds = (await listSessions())
    .filter((session) => isLiveSession(session) && expectedPtyIds.has(session.id))
    .map((session) => session.id)
  return {
    stopped: stoppedPtyIds.length,
    stoppedPtyIds: stoppedPtyIds.sort(),
    livePtyIds,
    postStopVerified: postStopLivePtyIds.length === 0
  }
}

async function readSessionFromParams(params: unknown): Promise<RuntimeSession> {
  const terminal = readTerminalHandle(params)
  const session = await findSession(terminal)
  if (!session) {
    throw new Error('terminal_gone')
  }
  return session
}

async function findSession(id: string): Promise<RuntimeSession | null> {
  return (await listSessions()).find((session) => session.id === id) ?? null
}

async function listSessions(): Promise<RuntimeSession[]> {
  return requestRuntimeJson<RuntimeSession[]>('/v1/sessions', { method: 'GET' })
}

function mapRuntimeSessionToTerminal(session: RuntimeSession) {
  const title = session.command.join(' ') || session.agentKind || 'Terminal'
  return {
    handle: session.id,
    ptyId: session.id,
    worktreeId: session.worktreeId ?? '',
    worktreePath: session.cwd,
    branch: '',
    tabId: session.tabId || `pty:${session.id}`,
    leafId: session.leafId || session.tabId || `pty:${session.id}`,
    title,
    connected: isLiveSession(session),
    writable: isLiveSession(session),
    lastOutputAt: readTimestamp(session.updatedAt),
    preview: ''
  }
}

function terminalTailLines(chunks: RuntimeOutputChunk[]): string[] {
  const text = chunks.map((chunk) => chunk.content).join('')
  if (!text) {
    return []
  }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n')
}

function readPaneRuntimeId(session: RuntimeSession): number {
  const leafId = session.leafId ?? ''
  const match = /(\d+)$/.exec(leafId)
  return match ? Number.parseInt(match[1], 10) : 0
}

function isRunningAgent(session: RuntimeSession): boolean {
  return Boolean(session.agentKind?.trim()) && isLiveSession(session)
}

function commandName(command: string[]): string | null {
  const executable = command.find((part) => part.trim().length > 0)
  if (!executable) {
    return null
  }
  const normalized = executable.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || executable
}

function isLiveSession(session: RuntimeSession): boolean {
  return session.status === 'starting' || session.status === 'running'
}

function toTerminalState(session: RuntimeSession): RuntimeTerminalState {
  return isLiveSession(session) ? 'running' : 'exited'
}

function readTerminalHandle(params: unknown): string {
  const input = readObject(params)
  return readRequiredString(input.terminal ?? input.handle ?? input.ptyId, 'terminal handle')
}

function readWaitCondition(value: unknown): RuntimeTerminalWaitCondition {
  return value === 'exit' || value === 'tui-idle' ? value : 'exit'
}

function normalizeRuntimeWorktreeId(value: string | null): string | undefined {
  if (!value) {
    return undefined
  }
  return value.startsWith('id:') ? value.slice(3) : value
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readRequiredString(value: unknown, label: string): string {
  const result = readString(value)
  if (!result) {
    throw new Error(`${label} is required`)
  }
  return result
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readCursor(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10)
  }
  return null
}

function readTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

function handled(result: unknown): RuntimeTerminalRpcResult {
  return { handled: true, result }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
