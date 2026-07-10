import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalCreate,
  RuntimeTerminalFocus,
  RuntimeTerminalResolvePane,
  RuntimeTerminalSplit,
  RuntimeTerminalState,
  RuntimeTerminalWaitCondition
} from '../../../src/shared/runtime-types'
import { parsePaneKey } from '../../../src/shared/stable-pane-id'
import { getHostPlatform, requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { readWorktrees } from './pebble-tauri-workspace-runtime-api'

type RuntimeSessionStatus = 'starting' | 'running' | 'exited' | 'failed' | 'stopped'

type RuntimeSession = {
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

async function createTerminal(params: unknown): Promise<RuntimeTerminalCreate> {
  const input = readObject(params)
  const worktree = await resolveSessionWorktree(params)
  const tabId = readString(input.tabId) ?? `tab-${crypto.randomUUID()}`
  const leafId = readString(input.leafId) ?? crypto.randomUUID()
  const session = await requestRuntimeJson<RuntimeSession>('/v1/sessions', {
    method: 'POST',
    timeoutMs: 15_000,
    body: {
      projectId: worktree.projectId,
      worktreeId: worktree.id,
      cwd: readString(input.cwd) ?? worktree.path,
      command: shellCommandForRuntime(readString(input.command)),
      agentKind: readAgentKind(input),
      tabId,
      leafId,
      launchToken: readString(input.launchToken) ?? undefined,
      prompt: readString(input.prompt) ?? undefined,
      cols: readNumber(input.cols) ?? undefined,
      rows: readNumber(input.rows) ?? undefined
    }
  })
  return {
    handle: session.id,
    tabId: session.tabId || tabId,
    paneKey: session.leafId || leafId,
    ptyId: session.id,
    worktreeId: session.worktreeId || worktree.id,
    title: terminalTitle(session),
    surface: input.surface === 'background' ? 'background' : 'visible'
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

type RuntimeSessionWaitResult = {
  sessionId: string
  condition: string
  satisfied: boolean
  timedOut: boolean
  status: RuntimeSessionStatus
  hookAgentState?: 'working' | 'idle' | 'permission'
  exitCode?: number | null
}

function toSessionStatusTerminalState(status: RuntimeSessionStatus): RuntimeTerminalState {
  return status === 'starting' || status === 'running' ? 'running' : 'exited'
}

async function waitForTerminal(params: unknown) {
  const input = readObject(params)
  const condition = readWaitCondition(input.for)
  const terminal = readTerminalHandle(params)
  const timeoutMs = Math.max(1, readNumber(input.timeoutMs) ?? DEFAULT_WAIT_TIMEOUT_MS)
  try {
    // Runtime-side blocking wait: exit tracks process death, tui-idle tracks
    // hook-reported agent readiness — no renderer polling loop.
    const wait = await requestRuntimeJson<RuntimeSessionWaitResult>(
      `/v1/sessions/${encodeURIComponent(terminal)}/wait`,
      {
        method: 'POST',
        body: { for: condition, timeoutMs },
        // Transport budget must outlive the runtime's own wait deadline.
        timeoutMs: timeoutMs + 5000
      }
    )
    return {
      handle: terminal,
      condition,
      satisfied: wait.satisfied === true,
      status: toSessionStatusTerminalState(wait.status),
      exitCode: wait.exitCode ?? null
    }
  } catch {
    // A missing/stopped session can never become idle, but it has exited.
    return {
      handle: terminal,
      condition,
      satisfied: condition === 'exit',
      status: 'exited' as RuntimeTerminalState,
      exitCode: null
    }
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

async function focusTerminal(params: unknown): Promise<RuntimeTerminalFocus> {
  const session = await readSessionFromParams(params)
  return {
    handle: session.id,
    tabId: session.tabId || `tab-${session.id}`,
    worktreeId: session.worktreeId ?? ''
  }
}

async function closeTerminal(params: unknown) {
  const session = await readSessionFromParams(params)
  const stopped = await requestRuntimeJson<RuntimeSession>(
    `/v1/sessions/${encodeURIComponent(session.id)}`,
    { method: 'DELETE' }
  )
  return {
    handle: stopped.id,
    tabId: stopped.tabId || session.tabId || `tab-${stopped.id}`,
    ptyKilled: true
  }
}

async function splitTerminal(params: unknown): Promise<RuntimeTerminalSplit> {
  const input = readObject(params)
  const source = await readSessionFromParams(params)
  const session = await requestRuntimeJson<RuntimeSession>('/v1/sessions', {
    method: 'POST',
    timeoutMs: 15_000,
    body: {
      projectId: source.projectId,
      worktreeId: source.worktreeId,
      cwd: source.cwd,
      command: shellCommandForRuntime(readString(input.command)) ?? source.command,
      agentKind: source.agentKind,
      tabId: source.tabId || `tab-${source.id}`,
      leafId: crypto.randomUUID(),
      cols: source.cols,
      rows: source.rows
    }
  })
  return {
    handle: session.id,
    tabId: session.tabId || source.tabId || `tab-${source.id}`,
    paneRuntimeId: readPaneRuntimeId(session)
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

async function resolveSessionWorktree(params: unknown): Promise<{
  id: string
  projectId: string
  path: string
}> {
  const input = readObject(params)
  const selector = normalizeRuntimeWorktreeId(
    readString(input.worktree) ?? readString(input.worktreeId)
  )
  if (!selector) {
    throw new Error('terminal_create_requires_worktree')
  }
  const worktree = (await readWorktrees()).find((entry) => entry.id === selector)
  const projectId = worktree?.projectId ?? worktree?.repoId
  if (!worktree || !projectId || (worktree.hostId && worktree.hostId !== 'local')) {
    throw new Error(`terminal_worktree_not_available:${selector}`)
  }
  return { id: worktree.id, projectId, path: worktree.path }
}

function shellCommandForRuntime(command: string | null): string[] | undefined {
  if (!command) {
    return undefined
  }
  return getHostPlatform() === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', command]
    : ['/bin/sh', '-lc', command]
}

function readAgentKind(input: Record<string, unknown>): string | undefined {
  return (
    readString(input.agentKind) ??
    readString(input.agent) ??
    readString(readObject(input.agent).id) ??
    readString(input.launchAgent) ??
    readString(readObject(input.launchAgent).id) ??
    undefined
  )
}

function terminalTitle(session: RuntimeSession): string {
  return session.command.join(' ') || session.agentKind || 'Terminal'
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
