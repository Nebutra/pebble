import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { writeRuntimePtyInput } from './runtime-bridge'
import { createRuntimePtyInputBatcher } from './runtime-pty-input-batcher'
import { markRuntimeAgentSessionStopped } from './tauri-agent-status-api'
import { createRuntimePtyManagement } from './tauri-runtime-pty-management'
import {
  addRuntimePtyDataListener,
  addRuntimePtyExitListener,
  addRuntimePtyReplayListener,
  configureRuntimePtyEventExit
} from './tauri-runtime-pty-events'
import {
  acknowledgeRuntimePtyData,
  forgetRuntimePtyDelivery,
  getRuntimePtyDeliveryDebugSnapshot,
  resetRuntimePtyDeliveryDebug,
  setActiveRuntimeRendererPty,
  setRuntimeRendererPtyVisible
} from './tauri-runtime-pty-delivery'
import {
  addTauriClearBufferRequestListener,
  addTauriSerializeBufferRequestListener,
  clearTauriPendingPaneSerializer,
  declareTauriPendingPaneSerializer,
  requestTauriSerializedBuffer,
  sendTauriSerializedBuffer,
  settleTauriPaneSerializer
} from './tauri-runtime-pty-serializer'
import {
  findRuntimeSession,
  listRuntimeSessions,
  requestRuntimePtyJson,
  type RuntimeOutputChunk,
  type RuntimeSession
} from './tauri-runtime-pty-resource'
import {
  forgetActiveRuntimePty,
  hasActiveRuntimePty,
  spawnRuntimePty
} from './tauri-runtime-pty-spawn'

const runtimePtySizeById = new Map<string, { cols: number; rows: number }>()
const runtimePtyStatusRequestsById = new Map<string, Promise<RuntimeSession | null>>()
const runtimePtyInput = createRuntimePtyInputBatcher(sendRuntimePtyInput)
const runtimePtyManagement = createRuntimePtyManagement(forgetRuntimePtyState)

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
    spawn: (opts) => spawnRuntimePty(opts, rememberRuntimePtySize),
    write: (id, data) => {
      void runtimePtyInput.write(id, data)
    },
    writeAccepted: runtimePtyInput.write,
    clearBuffer: (id) => {
      void clearRuntimePtyBuffer(id)
    },
    ackData: acknowledgeRuntimePtyData,
    setActiveRendererPty: setActiveRuntimeRendererPty,
    setRendererPtyVisible: setRuntimeRendererPtyVisible,
    kill: async (id) => {
      await requestRuntimePtyJson<RuntimeSession>(
        'DELETE',
        `/v1/sessions/${encodeURIComponent(id)}`
      )
      markRuntimeAgentSessionStopped(id)
      forgetRuntimePtyState(id)
    },
    resize: resizeRuntimePty,
    reportGeometry: resizeRuntimePty,
    signal: (id, signal) => {
      void signalRuntimePty(id, signal)
    },
    hasChildProcesses: async (id) => (await getRuntimePtyStatus(id))?.hasChildProcesses ?? false,
    getForegroundProcess: async (id) => (await getRuntimePtyStatus(id))?.foregroundProcess ?? null,
    hasPty: async (id) => hasActiveRuntimePty(id) || (await findRuntimeSession(id)) !== null,
    getCwd: getRuntimePtyCwd,
    getSize: async (id) => runtimePtySizeById.get(id) ?? null,
    listSessions: async () =>
      (await listRuntimeSessions()).map((session) => ({
        id: session.id,
        cwd: session.cwd,
        title: session.command.join(' ') || 'Terminal'
      })),
    management: runtimePtyManagement,
    getMainBufferSnapshot: getRuntimePtyBufferSnapshot,
    getRendererDeliveryDebugSnapshot: getRuntimePtyDeliveryDebugSnapshot,
    resetRendererDeliveryDebug: resetRuntimePtyDeliveryDebug,
    onData: addRuntimePtyDataListener,
    onReplay: addRuntimePtyReplayListener,
    onExit: addRuntimePtyExitListener,
    onSerializeBufferRequest: addTauriSerializeBufferRequestListener,
    onClearBufferRequest: addTauriClearBufferRequestListener,
    sendSerializedBuffer: sendTauriSerializedBuffer,
    declarePendingPaneSerializer: declareTauriPendingPaneSerializer,
    settlePaneSerializer: settleTauriPaneSerializer,
    clearPendingPaneSerializer: clearTauriPendingPaneSerializer
  } satisfies PreloadApi['pty']
}

async function getRuntimePtyCwd(id: string): Promise<string> {
  try {
    // Why: a vanished PTY has no authoritative cwd; a fabricated home path
    // would bypass the renderer's worktree-root fallback when splitting.
    return (await findRuntimeSession(id))?.cwd ?? ''
  } catch {
    return ''
  }
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function sendRuntimePtyInput(id: string, data: string): Promise<boolean> {
  try {
    // Why: terminal typing is a data plane. The dedicated Rust command reuses a
    // keep-alive client instead of opening a blocking control-plane socket per key.
    return await writeRuntimePtyInput(id, data)
  } catch {
    return false
  }
}

async function clearRuntimePtyBuffer(id: string): Promise<void> {
  await requestRuntimePtyJson<RuntimeSession>(
    'POST',
    `/v1/sessions/${encodeURIComponent(id)}/clear-buffer`
  ).catch(() => undefined)
}

async function signalRuntimePty(id: string, signal: string): Promise<void> {
  await requestRuntimePtyJson<{ status: string }>(
    'POST',
    `/v1/sessions/${encodeURIComponent(id)}/signal`,
    { signal }
  ).catch(() => undefined)
}

async function getRuntimePtyStatus(id: string): Promise<RuntimeSession | null> {
  const pending = runtimePtyStatusRequestsById.get(id)
  if (pending) {
    return pending
  }
  const request = readRuntimePtyStatus(id)
  runtimePtyStatusRequestsById.set(id, request)
  try {
    return await request
  } finally {
    if (runtimePtyStatusRequestsById.get(id) === request) {
      runtimePtyStatusRequestsById.delete(id)
    }
  }
}

async function readRuntimePtyStatus(id: string): Promise<RuntimeSession | null> {
  try {
    // Why: Windows inspection can take three seconds, so concurrent foreground/child
    // reads share this explicit probe instead of launching duplicate PowerShell scans.
    return await requestRuntimePtyJson<RuntimeSession>(
      'GET',
      `/v1/sessions/${encodeURIComponent(id)}/status`,
      undefined,
      5000
    )
  } catch (error) {
    if (String(error).includes('session not found')) {
      return null
    }
    throw error
  }
}

async function getRuntimePtyBufferSnapshot(
  id: string,
  opts?: { scrollbackRows?: number }
): Promise<{
  data: string
  cols: number
  rows: number
  cwd?: string | null
  source?: 'headless' | 'renderer'
} | null> {
  const rendererSnapshot = await requestTauriSerializedBuffer(id, opts)
  if (rendererSnapshot) {
    return { ...rendererSnapshot, source: 'renderer' }
  }
  const limit = Math.max(1, Math.min(opts?.scrollbackRows ?? 200, 2000))
  const tail = await requestRuntimePtyJson<{ chunks: RuntimeOutputChunk[] }>(
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
  void requestRuntimePtyJson<RuntimeSession>(
    'POST',
    `/v1/sessions/${encodeURIComponent(id)}/resize`,
    {
      ...size,
      // Desktop resizes are gated runtime-side while a mobile client drives.
      source: 'desktop'
    }
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
  runtimePtyInput.forget(id)
  forgetActiveRuntimePty(id)
  runtimePtySizeById.delete(id)
  runtimePtyStatusRequestsById.delete(id)
  forgetRuntimePtyDelivery(id)
}
