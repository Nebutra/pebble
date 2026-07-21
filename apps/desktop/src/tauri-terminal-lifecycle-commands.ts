import type {
  RuntimeTerminalCreate,
  RuntimeTerminalFocus,
  RuntimeTerminalSplit,
  RuntimeTerminalState
} from '../../../packages/product-core/shared/runtime-types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  readNumber,
  readObject,
  readString,
  readStringList,
  readTerminalHandle,
  readWaitCondition,
  normalizeRuntimeWorktreeId
} from './tauri-terminal-rpc-value-readers'
import {
  type RuntimeSession,
  type RuntimeSessionStatus,
  isLiveSession,
  isRunningAgent,
  listSessions,
  managedCodexEnvironment,
  readAgentKind,
  readPaneRuntimeId,
  readSessionFromParams,
  resolveSessionWorktree,
  shellCommandForRuntime,
  terminalTitle
} from './tauri-terminal-session-store'

const DEFAULT_WAIT_TIMEOUT_MS = 15_000

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

export async function createTerminal(params: unknown): Promise<RuntimeTerminalCreate> {
  const input = readObject(params)
  const worktree = await resolveSessionWorktree(params)
  const tabId = readString(input.tabId) ?? `tab-${crypto.randomUUID()}`
  const leafId = readString(input.leafId) ?? crypto.randomUUID()
  const command = shellCommandForRuntime(readString(input.command))
  const agentKind = readAgentKind(input)
  const session = await requestRuntimeJson<RuntimeSession>('/v1/sessions', {
    method: 'POST',
    timeoutMs: 15_000,
    body: {
      projectId: worktree.projectId,
      worktreeId: worktree.ephemeral ? undefined : worktree.id,
      ephemeral: worktree.ephemeral || undefined,
      cwd: readString(input.cwd) ?? worktree.path,
      command,
      agentKind,
      environment: managedCodexEnvironment(agentKind, readString(input.command)),
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

export async function sendTerminalInput(params: unknown) {
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
  await requestRuntimeJson<{ status: string }>(
    `/v1/sessions/${encodeURIComponent(session.id)}/input`,
    {
      method: 'POST',
      body: { text: payload, appendNewline }
    }
  )
  const bytesWritten = new TextEncoder().encode(`${payload}${appendNewline ? '\n' : ''}`).byteLength
  return { handle: session.id, accepted: true, bytesWritten }
}

export async function waitForTerminal(params: unknown) {
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

export async function stopTerminals(params: unknown) {
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

export async function stopExactTerminals(params: unknown) {
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
    livePtyIds.length === expectedPtyIds.size &&
    livePtyIds.every((ptyId) => expectedPtyIds.has(ptyId))
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

export async function focusTerminal(params: unknown): Promise<RuntimeTerminalFocus> {
  const session = await readSessionFromParams(params)
  return {
    handle: session.id,
    tabId: session.tabId || `tab-${session.id}`,
    worktreeId: session.worktreeId ?? ''
  }
}

export async function closeTerminal(params: unknown) {
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

export async function splitTerminal(params: unknown): Promise<RuntimeTerminalSplit> {
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
