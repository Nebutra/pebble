import type {
  RemoteWorkspaceChangedEvent,
  RemoteWorkspaceSnapshot
} from '../../../packages/product-core/shared/remote-workspace-types'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'
import type { RuntimeEventStreamEntry } from './runtime-command-shapes'

// Snapshot cache plus the push/watch/poll subsystem, split out of
// tauri-remote-workspace-api.ts so the reassignable push/poll state lives beside
// the code that mutates it and the API module stays focused on request handling.
export const clientId = crypto.randomUUID()
export const snapshots = new Map<string, RemoteWorkspaceSnapshot>()
export const listeners = new Set<(event: RemoteWorkspaceChangedEvent) => void>()

const watchedTargets = new Set<string>()
const retainedWatchTargets = new Set<string>()
const watchConnectedByTarget = new Map<string, boolean>()
const watchRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let pushConnected = false
let pushGeneration = 0
let pushSubscriptionPromise: Promise<{ unsubscribe: () => void }> | null = null
let pushUnsubscribe: (() => void) | null = null

export async function runtimePost<T>(path: string, body: unknown): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, {
    method: 'POST',
    body,
    timeoutMs: 60_000
  })
}

export function rememberSnapshot(targetId: string, snapshot: RemoteWorkspaceSnapshot): void {
  snapshots.set(targetId, snapshot)
  watchedTargets.add(targetId)
}

export async function fetchSnapshot(targetId: string): Promise<RemoteWorkspaceSnapshot> {
  watchedTargets.add(targetId)
  if (listeners.size > 0) {
    void retainTargetWatch(targetId)
  }
  return runtimePost('/v1/remote-workspace/get', { targetId })
}

export async function ensureWorkspacePush(): Promise<void> {
  if (pushSubscriptionPromise || listeners.size === 0) {
    return
  }
  const generation = ++pushGeneration
  pushSubscriptionPromise = subscribeRuntimeEventPush(handleWorkspaceRuntimeEvent, (active) => {
    pushConnected = active
    if (active) {
      void syncTargetWatches()
    }
    updatePollingState()
  }).then((subscription) => {
    if (generation !== pushGeneration || listeners.size === 0) {
      subscription.unsubscribe()
      return { unsubscribe: () => undefined }
    }
    pushUnsubscribe = subscription.unsubscribe
    pushConnected = subscription.pushActive
    updatePollingState()
    return subscription
  })
  await pushSubscriptionPromise
}

export async function stopWorkspacePush(): Promise<void> {
  pushGeneration++
  pushUnsubscribe?.()
  pushUnsubscribe = null
  pushSubscriptionPromise = null
  pushConnected = false
  await Promise.all([...retainedWatchTargets].map((targetId) => releaseTargetWatch(targetId)))
  for (const timer of watchRetryTimers.values()) {
    clearTimeout(timer)
  }
  watchRetryTimers.clear()
  watchConnectedByTarget.clear()
  updatePollingState()
}

export async function syncTargetWatches(): Promise<void> {
  if (listeners.size === 0) {
    return
  }
  await Promise.all([...watchedTargets].map((targetId) => retainTargetWatch(targetId)))
}

async function retainTargetWatch(targetId: string): Promise<void> {
  if (retainedWatchTargets.has(targetId)) {
    return
  }
  retainedWatchTargets.add(targetId)
  watchConnectedByTarget.set(targetId, false)
  try {
    await runtimePost('/v1/remote-workspace/watch', {
      targetId,
      enabled: true
    })
  } catch {
    retainedWatchTargets.delete(targetId)
    watchConnectedByTarget.set(targetId, false)
    scheduleTargetWatchRetry(targetId)
  }
  updatePollingState()
}

async function releaseTargetWatch(targetId: string): Promise<void> {
  if (!retainedWatchTargets.delete(targetId)) {
    return
  }
  watchConnectedByTarget.delete(targetId)
  await runtimePost('/v1/remote-workspace/watch', {
    targetId,
    enabled: false
  }).catch(() => undefined)
}

function handleWorkspaceRuntimeEvent(entry: RuntimeEventStreamEntry): void {
  if (entry.topic !== 'workspace.changed' && entry.topic !== 'workspace.watch-status') {
    return
  }
  try {
    const envelope = JSON.parse(entry.data) as { payload?: unknown }
    if (entry.topic === 'workspace.watch-status') {
      const payload = envelope.payload as { targetId?: string; connected?: boolean } | undefined
      if (!payload?.targetId) {
        return
      }
      watchConnectedByTarget.set(payload.targetId, payload.connected === true)
      if (payload.connected !== true) {
        scheduleTargetWatchRetry(payload.targetId)
      }
      updatePollingState()
      return
    }
    const event = envelope.payload as RemoteWorkspaceChangedEvent | undefined
    if (!event?.targetId || !event.snapshot) {
      return
    }
    const previous = snapshots.get(event.targetId)
    rememberSnapshot(event.targetId, event.snapshot)
    if (previous?.revision === event.snapshot.revision) {
      return
    }
    for (const listener of listeners) {
      listener(event)
    }
  } catch {
    // A malformed push must not disable the compatibility poll.
  }
}

function scheduleTargetWatchRetry(targetId: string): void {
  retainedWatchTargets.delete(targetId)
  if (watchRetryTimers.has(targetId) || listeners.size === 0) {
    return
  }
  watchRetryTimers.set(
    targetId,
    setTimeout(() => {
      watchRetryTimers.delete(targetId)
      if (listeners.size > 0 && watchedTargets.has(targetId)) {
        void retainTargetWatch(targetId)
      }
    }, 2_000)
  )
}

export function updatePollingState(): void {
  const needsPolling =
    listeners.size > 0 &&
    (!pushConnected ||
      [...watchedTargets].some((targetId) => watchConnectedByTarget.get(targetId) !== true))
  if (needsPolling && !pollTimer) {
    pollTimer = setInterval(() => void pollSnapshots(), 2_000)
    return
  }
  if (!needsPolling && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function pollSnapshots(): Promise<void> {
  await Promise.all(
    [...watchedTargets].map(async (targetId) => {
      const previous = snapshots.get(targetId)
      const snapshot = await fetchSnapshot(targetId).catch(() => null)
      if (!snapshot || snapshot.revision === previous?.revision) {
        return
      }
      rememberSnapshot(targetId, snapshot)
      for (const listener of listeners) {
        listener({ targetId, snapshot })
      }
    })
  )
}

export async function resetRemoteWorkspaceSnapshotWatch(): Promise<void> {
  listeners.clear()
  await stopWorkspacePush()
  snapshots.clear()
  watchedTargets.clear()
  retainedWatchTargets.clear()
  watchConnectedByTarget.clear()
  for (const timer of watchRetryTimers.values()) {
    clearTimeout(timer)
  }
  watchRetryTimers.clear()
}
