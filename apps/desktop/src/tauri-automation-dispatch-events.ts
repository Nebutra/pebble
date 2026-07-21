import type { AutomationDispatchRequest } from '../../../packages/product-core/shared/automations-types'
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
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

// Emitted by the Go runtime when a triggered automation (precheck already
// passed) wants a renderer to perform its workspace/agent-session work —
// the native replacement for Electron's `automations:dispatchRequested` IPC.
const DISPATCH_TOPIC = 'automation.dispatch.requested'
const MAX_REMEMBERED_RUN_IDS = 256

type DispatchListener = (request: AutomationDispatchRequest) => void

type RuntimeRendererDispatch = {
  automation: RuntimeAutomation
  run: RuntimeAutomationRun
  dispatchToken: string
}

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

export async function catchUpTauriAutomationDispatchRequests(): Promise<void> {
  ensureDispatchEventPump()
  const dispatches = await requestRuntimeJson<RuntimeRendererDispatch[]>(
    '/v1/automations/renderer-ready',
    { method: 'POST', timeoutMs: 5000 }
  ).catch(() => [])
  // Why: renderer-ready races cold runtime startup. Push/poll delivery remains
  // armed, so a failed one-shot catch-up must not reject into the React root.
  for (const dispatch of dispatches) {
    deliverDispatchRequest(dispatch)
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
  deliverDispatchRequest({
    automation: payload.automation as RuntimeAutomation,
    run: payload.run as RuntimeAutomationRun,
    dispatchToken: typeof payload.dispatchToken === 'string' ? payload.dispatchToken : ''
  })
}

function deliverDispatchRequest(dispatch: RuntimeRendererDispatch): void {
  const runtimeAutomation = dispatch.automation
  const runtimeRun = dispatch.run
  const dispatchToken = dispatch.dispatchToken
  if (!runtimeAutomation?.id || !runtimeRun?.id || !dispatchToken) {
    return
  }
  // Native-only automations complete inside the Go runtime; only automations
  // carrying the renderer envelope have workspace work for the renderer.
  if (!hasRendererAutomationSnapshot(runtimeRun.payload ?? runtimeAutomation.action?.payload)) {
    return
  }
  if (deliveredRunIds.has(runtimeRun.id)) {
    return
  }
  rememberDeliveredRun(runtimeRun.id)
  const request: AutomationDispatchRequest = {
    automation: mapRuntimeAutomation(runtimeAutomation),
    run: mapRuntimeAutomationRun(runtimeRun, runtimeAutomation),
    // Why: provenance authorization belongs to the runtime that owns the run;
    // the shell only forwards its random, single-use dispatch capability.
    dispatchToken
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
