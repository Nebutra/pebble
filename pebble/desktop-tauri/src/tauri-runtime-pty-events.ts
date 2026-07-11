import type { PreloadApi } from '../../../src/preload/api-types'
import { createRuntimeEventStreamCommand, readRuntimeEventStream } from './runtime-bridge'
import type { RuntimeEventStreamEntry } from './runtime-command-shapes'
import {
  emitRuntimeAgentSessionStatus,
  type TauriRuntimeAgentSession
} from './tauri-agent-status-api'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'
import {
  mapRuntimePtyOutputEntry,
  mapRuntimePtyStatusEntry,
  mapRuntimeSessionDriverEntry
} from './tauri-runtime-pty-event-mapping'
import { deliverRuntimeSessionDriver } from './tauri-runtime-session-driver-relay'

type PtyApi = PreloadApi['pty']
type PtyData = Parameters<Parameters<PtyApi['onData']>[0]>[0]
type PtyExit = Parameters<Parameters<PtyApi['onExit']>[0]>[0]

type RuntimeSession = TauriRuntimeAgentSession

const ptyDataListeners = new Set<(data: PtyData) => void>()
const ptyExitListeners = new Set<(data: PtyExit) => void>()
const exitedRuntimePtyIds = new Set<string>()
const runtimePtySeqById = new Map<string, number>()
let runtimePtyEventDeliveryStarted = false
let pollingActive = false
let pollingGeneration = 0

// Called when a session exits so the API surface can drop it from its active set.
let onSessionExit: ((sessionId: string) => void) | null = null

export function configureRuntimePtyEventExit(handler: (sessionId: string) => void): void {
  onSessionExit = handler
}

export function addRuntimePtyDataListener(callback: (data: PtyData) => void): () => void {
  ptyDataListeners.add(callback)
  ensureRuntimePtyEventDelivery()
  return () => {
    ptyDataListeners.delete(callback)
  }
}

export function addRuntimePtyExitListener(callback: (data: PtyExit) => void): () => void {
  ptyExitListeners.add(callback)
  ensureRuntimePtyEventDelivery()
  return () => {
    ptyExitListeners.delete(callback)
  }
}

export function ensureRuntimePtyEventDelivery(): void {
  if (runtimePtyEventDeliveryStarted) {
    return
  }
  runtimePtyEventDeliveryStarted = true
  void startRuntimePtyEventDelivery()
}

// Prefer the native push pipeline; only poll when push is unavailable (older runtime,
// remote/SSH transport that can't stream) so idle terminals do no round trips.
async function startRuntimePtyEventDelivery(): Promise<void> {
  const { supported } = await subscribeRuntimeEventPush(
    (entry) => {
      if (entry.topic === 'session.output' || !entry.topic) {
        handleRuntimePtyOutputEntry(entry)
      }
      if (entry.topic === 'session.status' || !entry.topic) {
        handleRuntimePtyStatusEntry(entry)
      }
      if (entry.topic === 'session.driver' || !entry.topic) {
        handleRuntimeSessionDriverEntry(entry)
      }
    },
    // Push disconnected (or never connected) -> poll; reconnected -> stop polling. Unsupported
    // transports never emit a connect, so their status stays false and polling runs for good.
    (pushActive) => setRuntimePtyPolling(!pushActive)
  )
  if (!supported) {
    setRuntimePtyPolling(true)
  }
}

// A generation counter fences the poll loops: enabling bumps it and starts fresh loops; the
// old loops see a stale generation and exit, so a reconnect never leaves a duplicate poller.
function setRuntimePtyPolling(active: boolean): void {
  if (active === pollingActive) {
    return
  }
  pollingActive = active
  if (!active) {
    pollingGeneration += 1
    return
  }
  const generation = pollingGeneration
  void pumpRuntimePtyOutput(generation)
  void pumpRuntimePtyStatus(generation)
}

function isPollGenerationCurrent(generation: number): boolean {
  return pollingActive && generation === pollingGeneration
}

function handleRuntimePtyOutputEntry(event: RuntimeEventStreamEntry): void {
  const output = mapRuntimePtyOutputEntry(event)
  if (!output) {
    return
  }
  emitRuntimePtyData(output.sessionId, output.content)
}

function handleRuntimePtyStatusEntry(event: RuntimeEventStreamEntry): void {
  const session = mapRuntimePtyStatusEntry(event)
  if (!session) {
    return
  }
  emitRuntimeAgentSessionStatus(session)
  if (session.status === 'exited' || session.status === 'failed' || session.status === 'stopped') {
    emitRuntimePtyExit(session)
  }
}

// Push-only: driver flips come from mobile relay input (presence lock), so a
// polling fallback would add per-session round trips for a rare transition;
// the reclaim button re-reads the runtime state on demand instead.
function handleRuntimeSessionDriverEntry(event: RuntimeEventStreamEntry): void {
  const driverEvent = mapRuntimeSessionDriverEntry(event)
  if (!driverEvent) {
    return
  }
  deliverRuntimeSessionDriver(driverEvent.sessionId, driverEvent.driver)
}

async function pumpRuntimePtyOutput(generation: number): Promise<void> {
  while (isPollGenerationCurrent(generation)) {
    const events = await readRuntimeEvents('session.output')
    if (events.length === 0) {
      await delay(1000)
    }
    for (const event of events) {
      handleRuntimePtyOutputEntry(event)
    }
  }
}

async function pumpRuntimePtyStatus(generation: number): Promise<void> {
  while (isPollGenerationCurrent(generation)) {
    const events = await readRuntimeEvents('session.status')
    if (events.length === 0) {
      await delay(1000)
    }
    for (const event of events) {
      handleRuntimePtyStatusEntry(event)
    }
  }
}

async function readRuntimeEvents(topic: string): Promise<RuntimeEventStreamEntry[]> {
  const result = await readRuntimeEventStream(
    createRuntimeEventStreamCommand({ topic, limit: 20, timeoutMs: 30000 })
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
  onSessionExit?.(session.id)
  for (const listener of ptyExitListeners) {
    listener({ id: session.id, code: session.exitCode ?? 0 })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
