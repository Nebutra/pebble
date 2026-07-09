import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { DEFAULT_RUNTIME_URL } from './runtime-command-shapes'
import type { RuntimeEventStreamEntry } from './runtime-command-shapes'

const RUNTIME_EVENT = 'pebble://runtime-event'
const RUNTIME_EVENT_STATUS = 'pebble://runtime-event-status'

type PushHandler = (entry: RuntimeEventStreamEntry) => void
// Called with the live push state: true once the native stream is connected, false while it
// is down. Subscribers gate their polling fallback on this so no ordering leaves events dark.
type PushStateHandler = (pushActive: boolean) => void

type StartResult = {
  supported: boolean
  eventName: string
  statusEventName: string
}

type RuntimeEventStatus = {
  connected: boolean
}

type Subscriber = {
  onEvent: PushHandler
  onPushStateChange?: PushStateHandler
}

const subscribers = new Set<Subscriber>()
let unlistenEvent: UnlistenFn | null = null
let unlistenStatus: UnlistenFn | null = null
let startPromise: Promise<boolean> | null = null
// True only while the native SSE stream is connected. `supported` says the pipeline can run;
// this says it is actually delivering, which is what decides whether polling must be active.
let pushConnected = false

/**
 * Registers handlers for pushed runtime events. Returns whether the native push pipeline is
 * supported and its current connection state. When push is unsupported the caller must run its
 * polling fallback permanently; when supported, the caller should start/stop polling from
 * `onPushStateChange` (called immediately with the current state and on every transition) so
 * that a disconnect re-arms polling and a reconnect stops it — closing the dead-state gap.
 */
export async function subscribeRuntimeEventPush(
  handler: PushHandler,
  onPushStateChange?: PushStateHandler
): Promise<{ pushActive: boolean; supported: boolean; unsubscribe: () => void }> {
  const subscriber: Subscriber = { onEvent: handler, onPushStateChange }
  subscribers.add(subscriber)
  const supported = await ensurePushPipeline()
  // Deliver the current state so a subscriber that joined after connect still gates correctly.
  onPushStateChange?.(supported && pushConnected)
  return {
    pushActive: supported && pushConnected,
    supported,
    unsubscribe: () => {
      subscribers.delete(subscriber)
    }
  }
}

/**
 * Tears the push pipeline down on renderer teardown: drops the native SSE task (so the OS
 * connection is released promptly) and unbinds the event listeners. Marks push disconnected so
 * any surviving subscriber re-arms its polling fallback rather than going dark.
 */
export function stopRuntimeEventPush(): void {
  if (!startPromise) {
    return
  }
  startPromise = null
  setPushConnected(false)
  void teardownPushPipeline()
  void invoke('stop_runtime_event_stream').catch(() => undefined)
}

async function ensurePushPipeline(): Promise<boolean> {
  if (!startPromise) {
    startPromise = startPushPipeline()
  }
  return startPromise
}

async function startPushPipeline(): Promise<boolean> {
  try {
    unlistenEvent = await listen<RuntimeEventStreamEntry>(RUNTIME_EVENT, (event) => {
      dispatchEvent(event.payload)
    })
    unlistenStatus = await listen<RuntimeEventStatus>(RUNTIME_EVENT_STATUS, (event) => {
      setPushConnected(event.payload.connected)
    })
    const result = await invoke<StartResult>('start_runtime_event_stream', {
      input: { runtimeUrl: DEFAULT_RUNTIME_URL, bearerToken: null }
    })
    if (!result.supported) {
      await teardownPushPipeline()
      return false
    }
    return true
  } catch {
    await teardownPushPipeline()
    // Reset so a later subscriber can retry (e.g. runtime came up after first attempt).
    startPromise = null
    return false
  }
}

async function teardownPushPipeline(): Promise<void> {
  if (unlistenEvent) {
    unlistenEvent()
    unlistenEvent = null
  }
  if (unlistenStatus) {
    unlistenStatus()
    unlistenStatus = null
  }
}

function setPushConnected(connected: boolean): void {
  if (connected === pushConnected) {
    return
  }
  pushConnected = connected
  for (const subscriber of subscribers) {
    subscriber.onPushStateChange?.(connected)
  }
}

function dispatchEvent(entry: RuntimeEventStreamEntry): void {
  for (const subscriber of subscribers) {
    subscriber.onEvent(entry)
  }
}
