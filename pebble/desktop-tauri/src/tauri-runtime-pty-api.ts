import type { PreloadApi } from '../../../src/preload/api-types'
import type { Worktree } from '../../../src/shared/types'
import { isEphemeralSetupTerminalWorktreeId } from '../../../src/shared/ephemeral-setup-terminal-worktree-id'
import {
  createRuntimeResourceGetCommand,
  createRuntimeResourceRequestCommand,
  getRuntimeResourceJson,
  requestRuntimeResourceJson
} from './runtime-bridge'
import type { RuntimeResourceGetResult } from './runtime-command-shapes'
import {
  markRuntimeAgentSessionStopped,
  recordRuntimeAgentSessionSpawn,
  type TauriRuntimeAgentSession
} from './tauri-agent-status-api'
import {
  addRuntimePtyDataListener,
  addRuntimePtyExitListener,
  configureRuntimePtyEventExit,
  ensureRuntimePtyEventDelivery
} from './tauri-runtime-pty-events'

type PtyApi = PreloadApi['pty']
type PtySpawnOptions = Parameters<PtyApi['spawn']>[0]
type PtySpawnResult = Awaited<ReturnType<PtyApi['spawn']>>

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

const activeRuntimePtyIds = new Set<string>()
const runtimePtySizeById = new Map<string, { cols: number; rows: number }>()

export function installTauriRuntimePtyApi(): void {
  if (!hasTauriInternals()) {
    return
  }

  // Push delivery lives in tauri-runtime-pty-events.ts; it calls back on exit so
  // this module can drop the session's cached size/active state.
  configureRuntimePtyEventExit((sessionId) => {
    forgetRuntimePtyState(sessionId)
  })

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
    onData: addRuntimePtyDataListener,
    onExit: addRuntimePtyExitListener
  } satisfies PreloadApi['pty']
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function spawnRuntimePty(opts: PtySpawnOptions): Promise<PtySpawnResult> {
  const ephemeral = isEphemeralSetupTerminalWorktreeId(opts.worktreeId ?? '')
  const projectId = ephemeral ? '' : await resolveRuntimeProjectId(opts)
  const body = {
    projectId,
    worktreeId: ephemeral ? undefined : opts.worktreeId,
    ephemeral,
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
  ensureRuntimePtyEventDelivery()
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
    // source:'desktop' lets the runtime refuse the write (423) while a mobile
    // client holds the presence lock, mirroring Electron's pty:writeAccepted.
    await requestRuntimeJson('POST', `/v1/sessions/${encodeURIComponent(id)}/input`, {
      text: data,
      source: 'desktop'
    })
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
  void requestRuntimeJson<RuntimeSession>('POST', `/v1/sessions/${encodeURIComponent(id)}/resize`, {
    ...size,
    // Desktop resizes are gated runtime-side while a mobile client drives.
    source: 'desktop'
  }).catch(() => undefined)
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
  runtimePtySizeById.delete(id)
}

async function listRuntimeSessions(): Promise<RuntimeSession[]> {
  return requestRuntimeJson<RuntimeSession[]>('GET', '/v1/sessions')
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
