import type { AutomationDispatchRequest } from '../../../src/shared/automations-types'
import { createRuntimeEventStreamCommand, readRuntimeEventStream } from './runtime-bridge'
import type { RuntimeEventStreamEntry } from './runtime-command-shapes'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'
import {
  hasRendererAutomationSnapshot,
  mapRuntimeAutomation,
  mapRuntimeAutomationRun,
  type RuntimeAutomation,
  type RuntimeAutomationRun
} from './tauri-automation-runtime-mapping'

// Emitted by the Go runtime when a triggered automation (precheck already
// passed) wants a renderer to perform its workspace/agent-session work —
// the native replacement for Electron's `automations:dispatchRequested` IPC.
const DISPATCH_TOPIC = 'automation.dispatch.requested'
const MAX_REMEMBERED_RUN_IDS = 256

type DispatchListener = (request: AutomationDispatchRequest) => void

const dispatchListeners = new Set<DispatchListener>()
// Push and the polling fallback can overlap around reconnects; runs must
// dispatch into the renderer exactly once.
const deliveredRunIds = new Set<string>()
let pumpStarted = false
let pollingActive = false
let pollingGeneration = 0

export function onTauriAutomationDispatchRequested(callback: DispatchListener): () => void {
  dispatchListeners.add(callback)
  ensureDispatchEventPump()
  return () => {
    dispatchListeners.delete(callback)
  }
}

function ensureDispatchEventPump(): void {
  if (pumpStarted) {
    return
  }
  pumpStarted = true
  void startDispatchEventDelivery()
}

// Same push-first/poll-fallback shape as tauri-browser-runtime-events: idle
// sessions do no round trips while push is connected.
async function startDispatchEventDelivery(): Promise<void> {
  const { supported } = await subscribeRuntimeEventPush(
    (entry) => {
      if (entry.topic && entry.topic !== DISPATCH_TOPIC) {
        return
      }
      handleDispatchRequestedEvent(entry)
    },
    (pushActive) => setDispatchPolling(!pushActive)
  )
  if (!supported) {
    setDispatchPolling(true)
  }
}

function setDispatchPolling(active: boolean): void {
  if (active === pollingActive) {
    return
  }
  pollingActive = active
  if (!active) {
    pollingGeneration += 1
    return
  }
  void pumpDispatchEvents(pollingGeneration)
}

async function pumpDispatchEvents(generation: number): Promise<void> {
  while (pollingActive && generation === pollingGeneration) {
    const events = await readDispatchEvents()
    if (events.length === 0) {
      await delay(1000)
    }
    for (const event of events) {
      handleDispatchRequestedEvent(event)
    }
  }
}

async function readDispatchEvents(): Promise<RuntimeEventStreamEntry[]> {
  const result = await readRuntimeEventStream(
    createRuntimeEventStreamCommand({ topic: DISPATCH_TOPIC, limit: 20 })
  ).catch(() => null)
  return result?.transport === 'connected' ? result.events : []
}

function handleDispatchRequestedEvent(entry: RuntimeEventStreamEntry): void {
  const event = parseRuntimeEvent(entry)
  if (!event || event.topic !== DISPATCH_TOPIC) {
    return
  }
  const payload = readObject(event.payload)
  const runtimeAutomation = payload.automation as RuntimeAutomation | undefined
  const runtimeRun = payload.run as RuntimeAutomationRun | undefined
  if (!runtimeAutomation?.id || !runtimeRun?.id) {
    return
  }
  // Native-only automations complete inside the Go runtime; only automations
  // carrying the renderer envelope have workspace work for the renderer.
  if (
    !hasRendererAutomationSnapshot(runtimeRun.payload ?? runtimeAutomation.action?.payload)
  ) {
    return
  }
  if (deliveredRunIds.has(runtimeRun.id)) {
    return
  }
  rememberDeliveredRun(runtimeRun.id)
  const request: AutomationDispatchRequest = {
    automation: mapRuntimeAutomation(runtimeAutomation),
    run: mapRuntimeAutomationRun(runtimeRun, runtimeAutomation),
    // Why: Electron's token guards main-process bookkeeping the Go runtime
    // does not have; a deterministic token keeps the renderer contract intact.
    dispatchToken: `${runtimeAutomation.id}:${runtimeRun.id}`
  }
  for (const listener of dispatchListeners) {
    listener(request)
  }
}

function rememberDeliveredRun(runId: string): void {
  deliveredRunIds.add(runId)
  if (deliveredRunIds.size > MAX_REMEMBERED_RUN_IDS) {
    const oldest = deliveredRunIds.values().next().value
    if (oldest) {
      deliveredRunIds.delete(oldest)
    }
  }
}

function parseRuntimeEvent(
  entry: RuntimeEventStreamEntry
): { topic: string; payload?: unknown } | null {
  try {
    return JSON.parse(entry.data) as { topic: string; payload?: unknown }
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
