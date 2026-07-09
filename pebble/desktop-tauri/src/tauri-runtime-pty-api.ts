import type { PreloadApi } from '../../../src/preload/api-types'
import type { Worktree } from '../../../src/shared/types'
import {
  createRuntimeEventStreamCommand,
  createRuntimeResourceGetCommand,
  createRuntimeResourceRequestCommand,
  getRuntimeResourceJson,
  readRuntimeEventStream,
  requestRuntimeResourceJson
} from './runtime-bridge'
import type { RuntimeEventStreamEntry, RuntimeResourceGetResult } from './runtime-command-shapes'
import {
  emitRuntimeAgentSessionStatus,
  markRuntimeAgentSessionStopped,
  recordRuntimeAgentSessionSpawn,
  type TauriRuntimeAgentSession
} from './tauri-agent-status-api'

type PtyApi = PreloadApi['pty']
type PtySpawnOptions = Parameters<PtyApi['spawn']>[0]
type PtySpawnResult = Awaited<ReturnType<PtyApi['spawn']>>
type PtyData = Parameters<Parameters<PtyApi['onData']>[0]>[0]
type PtyExit = Parameters<Parameters<PtyApi['onExit']>[0]>[0]

type RuntimeSession = TauriRuntimeAgentSession & {
  id: string
  projectId: string
  worktreeId?: string
  cwd: string
  command: string[]
  cols?: number
  rows?: number
}

type RuntimeOutputChunk = {
  stream: string
  content: string
}

type RuntimeEvent = {
  topic: string
  payload?: unknown
}

const ptyDataListeners = new Set<(data: PtyData) => void>()
const ptyExitListeners = new Set<(data: PtyExit) => void>()
const activeRuntimePtyIds = new Set<string>()
const exitedRuntimePtyIds = new Set<string>()
const runtimePtySeqById = new Map<string, number>()
const runtimePtySizeById = new Map<string, { cols: number; rows: number }>()
let runtimePtyOutputPumpStarted = false
let runtimePtyStatusPumpStarted = false

export function installTauriRuntimePtyApi(): void {
  if (!hasTauriInternals()) {
    return
  }

  const base = window.api.pty
  window.api.pty = {
    ...base,
    spawn: spawnRuntimePty,
    write: (id, data) => {
      void writeRuntimePty(id, data)
    },
    writeAccepted: writeRuntimePty,
    clearBuffer: (id) => {
      void clearRuntimePtyBuffer(id)
    },
    kill: async (id) => {
      await requestRuntimeJson<RuntimeSession>('DELETE', `/v1/sessions/${encodeURIComponent(id)}`)
      markRuntimeAgentSessionStopped(id)
      forgetRuntimePtyState(id)
    },
    resize: resizeRuntimePty,
    reportGeometry: resizeRuntimePty,
    hasPty: async (id) => activeRuntimePtyIds.has(id) || (await findRuntimeSession(id)) !== null,
    getCwd: async (id) => (await findRuntimeSession(id))?.cwd ?? '~',
    getSize: async (id) => runtimePtySizeById.get(id) ?? null,
    listSessions: async () =>
      (await listRuntimeSessions()).map((session) => ({
        id: session.id,
        cwd: session.cwd,
        title: session.command.join(' ') || 'Terminal'
      })),
    getMainBufferSnapshot: getRuntimePtyBufferSnapshot,
    onData: (callback) => {
      ptyDataListeners.add(callback)
      ensureRuntimePtyEventPumps()
      return () => {
        ptyDataListeners.delete(callback)
      }
    },
    onExit: (callback) => {
      ptyExitListeners.add(callback)
      ensureRuntimePtyEventPumps()
      return () => {
        ptyExitListeners.delete(callback)
      }
    }
  } satisfies PreloadApi['pty']
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function spawnRuntimePty(opts: PtySpawnOptions): Promise<PtySpawnResult> {
  const projectId = await resolveRuntimeProjectId(opts)
  const body = {
    projectId,
    worktreeId: opts.worktreeId,
    cwd: opts.cwd,
    command: resolveRuntimeCommand(opts),
    agentKind: opts.launchAgent,
    launchToken: opts.launchToken,
    tabId: opts.tabId,
    leafId: opts.leafId,
    cols: opts.cols,
    rows: opts.rows
  }
  const session = await requestRuntimeJson<RuntimeSession>('POST', '/v1/sessions', body, 5000)
  activeRuntimePtyIds.add(session.id)
  rememberRuntimePtySize(session.id, opts.cols, opts.rows)
  recordRuntimeAgentSessionSpawn({ session, spawnOptions: opts })
  ensureRuntimePtyEventPumps()
  return {
    id: session.id,
    ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {})
  }
}

async function resolveRuntimeProjectId(opts: PtySpawnOptions): Promise<string> {
  if (!opts.worktreeId) {
    throw new Error('Tauri runtime terminals require a workspace-backed terminal.')
  }
  const worktrees = await window.api.worktrees.listAll()
  const worktree = worktrees.find((entry: Worktree) => entry.id === opts.worktreeId)
  const projectId = worktree?.projectId ?? worktree?.repoId
  if (!projectId) {
    throw new Error(`Unable to resolve project for workspace terminal ${opts.worktreeId}.`)
  }
  return projectId
}

function resolveRuntimeCommand(opts: PtySpawnOptions): string[] | undefined {
  const command = opts.command?.trim()
  if (!command) {
    return undefined
  }
  const shell = opts.shellOverride?.trim() || defaultRuntimeShell()
  return isWindowsHost() ? [shell, '/d', '/s', '/c', command] : [shell, '-lc', command]
}

function defaultRuntimeShell(): string {
  if (isWindowsHost()) {
    return 'cmd.exe'
  }
  return '/bin/sh'
}

function isWindowsHost(): boolean {
  return navigator.userAgent.toLowerCase().includes('windows')
}

async function writeRuntimePty(id: string, data: string): Promise<boolean> {
  try {
    await requestRuntimeJson('POST', `/v1/sessions/${encodeURIComponent(id)}/input`, { text: data })
    return true
  } catch {
    return false
  }
}

async function clearRuntimePtyBuffer(id: string): Promise<void> {
  await requestRuntimeJson<RuntimeSession>(
    'POST',
    `/v1/sessions/${encodeURIComponent(id)}/clear-buffer`
  ).catch(() => undefined)
}

async function getRuntimePtyBufferSnapshot(
  id: string,
  opts?: { scrollbackRows?: number }
): Promise<{
  data: string
  cols: number
  rows: number
  cwd?: string | null
} | null> {
  const limit = Math.max(1, Math.min(opts?.scrollbackRows ?? 200, 2000))
  const tail = await requestRuntimeJson<{ chunks: RuntimeOutputChunk[] }>(
    'GET',
    `/v1/sessions/${encodeURIComponent(id)}/tail?limit=${limit}`,
    undefined,
    5000
  ).catch(() => null)
  const session = await findRuntimeSession(id)
  if (!tail && !session) {
    return null
  }
  return {
    data: tail?.chunks.map((chunk) => chunk.content).join('') ?? '',
    cols: runtimePtySizeById.get(id)?.cols ?? session?.cols ?? 80,
    rows: runtimePtySizeById.get(id)?.rows ?? session?.rows ?? 24,
    cwd: session?.cwd ?? null
  }
}

function resizeRuntimePty(id: string, cols: number, rows: number): void {
  const size = rememberRuntimePtySize(id, cols, rows)
  if (!size) {
    return
  }
  void requestRuntimeJson<RuntimeSession>(
    'POST',
    `/v1/sessions/${encodeURIComponent(id)}/resize`,
    size
  ).catch(() => undefined)
}

function rememberRuntimePtySize(
  id: string,
  cols: number,
  rows: number
): { cols: number; rows: number } | null {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    return null
  }
  const nextCols = Math.max(1, Math.floor(cols))
  const nextRows = Math.max(1, Math.floor(rows))
  runtimePtySizeById.set(id, { cols: nextCols, rows: nextRows })
  return { cols: nextCols, rows: nextRows }
}

function forgetRuntimePtyState(id: string): void {
  activeRuntimePtyIds.delete(id)
  runtimePtySeqById.delete(id)
  runtimePtySizeById.delete(id)
}

function ensureRuntimePtyEventPumps(): void {
  if (!runtimePtyOutputPumpStarted) {
    runtimePtyOutputPumpStarted = true
    void pumpRuntimePtyOutput()
  }
  if (!runtimePtyStatusPumpStarted) {
    runtimePtyStatusPumpStarted = true
    void pumpRuntimePtyStatus()
  }
}

async function pumpRuntimePtyOutput(): Promise<void> {
  for (;;) {
    const events = await readRuntimeEvents('session.output')
    if (events.length === 0) {
      await delay(1000)
    }
    for (const event of events) {
      const payload = parseRuntimeEventPayload(event)
      if (!payload) {
        continue
      }
      const payloadBody = readObject(payload.payload)
      const session = payloadBody.session as RuntimeSession | undefined
      const chunk = payloadBody.chunk as RuntimeOutputChunk | undefined
      if (!session?.id || !chunk?.content) {
        continue
      }
      emitRuntimePtyData(session.id, chunk.content)
    }
  }
}

async function pumpRuntimePtyStatus(): Promise<void> {
  for (;;) {
    const events = await readRuntimeEvents('session.status')
    if (events.length === 0) {
      await delay(1000)
    }
    for (const event of events) {
      const payload = parseRuntimeEventPayload(event)
      if (!payload) {
        continue
      }
      const payloadBody = readObject(payload.payload)
      const session = (payloadBody.session ?? payload.payload) as RuntimeSession | undefined
      if (!session?.id) {
        continue
      }
      emitRuntimeAgentSessionStatus(session)
      if (
        session.status === 'exited' ||
        session.status === 'failed' ||
        session.status === 'stopped'
      ) {
        emitRuntimePtyExit(session)
      }
    }
  }
}

async function readRuntimeEvents(topic: string): Promise<RuntimeEventStreamEntry[]> {
  const result = await readRuntimeEventStream(
    // Why: long blocking SSE reads can starve Tauri's WebKit IPC on macOS; the
    // Rust side runs off-thread, but short polls still bound event-pump pressure.
    createRuntimeEventStreamCommand({ topic, limit: 20 })
  ).catch(() => null)
  return result?.transport === 'connected' ? result.events : []
}

function emitRuntimePtyData(id: string, data: string): void {
  const seq = (runtimePtySeqById.get(id) ?? 0) + data.length
  runtimePtySeqById.set(id, seq)
  for (const listener of ptyDataListeners) {
    listener({ id, data, seq, rawLength: data.length })
  }
}

function emitRuntimePtyExit(session: RuntimeSession): void {
  if (exitedRuntimePtyIds.has(session.id)) {
    return
  }
  exitedRuntimePtyIds.add(session.id)
  emitRuntimeAgentSessionStatus(session)
  forgetRuntimePtyState(session.id)
  for (const listener of ptyExitListeners) {
    listener({ id: session.id, code: session.exitCode ?? 0 })
  }
}

async function listRuntimeSessions(): Promise<RuntimeSession[]> {
  return requestRuntimeJson<RuntimeSession[]>('GET', '/v1/sessions').catch(() => [])
}

async function findRuntimeSession(id: string): Promise<RuntimeSession | null> {
  return (await listRuntimeSessions()).find((session) => session.id === id) ?? null
}

async function requestRuntimeJson<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = 1500
): Promise<T> {
  const result =
    method === 'GET'
      ? await getRuntimeResourceJson(createRuntimeResourceGetCommand({ path, timeoutMs }))
      : await requestRuntimeResourceJson(
          createRuntimeResourceRequestCommand({
            method,
            path,
            bodyJson: body === undefined ? null : JSON.stringify(body),
            timeoutMs
          })
        )
  return parseRuntimeResourceResult<T>(result)
}

function parseRuntimeResourceResult<T>(result: RuntimeResourceGetResult): T {
  if (result.transport !== 'connected') {
    throw new Error(result.error ?? `Runtime transport failed: ${result.transport}`)
  }
  if (result.httpStatus !== null && (result.httpStatus < 200 || result.httpStatus > 299)) {
    throw new Error(result.body ?? `Runtime request failed with HTTP ${result.httpStatus}`)
  }
  return result.body ? (JSON.parse(result.body) as T) : ({} as T)
}

function parseRuntimeEventPayload(event: RuntimeEventStreamEntry): RuntimeEvent | null {
  try {
    return JSON.parse(event.data) as RuntimeEvent
  } catch {
    return null
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
