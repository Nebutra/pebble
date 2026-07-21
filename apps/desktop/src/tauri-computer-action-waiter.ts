import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  isTerminalTauriComputerAction,
  readTauriComputerAction,
  readTauriComputerActionEvent,
  type TauriComputerActionRecord
} from './tauri-computer-action-event'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'

type ActionWaitOptions = {
  actionId: string
  kindPrefix: string
  timeoutMs: number
  timeoutMessage: string
  afterSequence?: number
  signal?: AbortSignal
}

type PendingActionWait = ActionWaitOptions & {
  resolve: (action: TauriComputerActionRecord) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  abort?: () => void
}

type PollGroup = {
  timer: ReturnType<typeof setTimeout> | null
  inFlight: Promise<void> | null
}

const FALLBACK_POLL_INTERVAL_MS = 100
const TERMINAL_CACHE_LIMIT = 128
const TERMINAL_CACHE_TTL_MS = 30_000

const pendingWaits = new Map<string, PendingActionWait>()
const pollGroups = new Map<string, PollGroup>()
const terminalCache = new Map<
  string,
  { action: TauriComputerActionRecord; sequence: number; expiresAt: number }
>()
let pushSubscription: Awaited<ReturnType<typeof subscribeRuntimeEventPush>> | null = null
let pushSubscriptionPromise: Promise<void> | null = null
let pushActive = false
let waiterGeneration = 0
let terminalSequence = 0

export function getTauriComputerActionCursor(): number {
  return terminalSequence
}

export function waitForTauriComputerAction(
  options: ActionWaitOptions
): Promise<TauriComputerActionRecord> {
  const cached = readCachedTerminalAction(options.actionId, options.afterSequence)
  if (cached) {
    return Promise.resolve(cached)
  }
  const existing = pendingWaits.get(options.actionId)
  if (existing) {
    return Promise.reject(new Error(`Action ${options.actionId} is already being awaited.`))
  }
  return new Promise((resolve, reject) => {
    const wait: PendingActionWait = {
      ...options,
      resolve,
      reject,
      timeout: setTimeout(() => {
        settleActionWait(options.actionId, null, new Error(options.timeoutMessage))
      }, options.timeoutMs)
    }
    if (options.signal) {
      wait.abort = () => {
        settleActionWait(options.actionId, null, new Error('Action wait was canceled.'))
      }
      options.signal.addEventListener('abort', wait.abort, { once: true })
    }
    pendingWaits.set(options.actionId, wait)
    void ensureActionPushSubscription().then(() => {
      if (!pendingWaits.has(options.actionId)) {
        return
      }
      // Why: the action may have completed between POST and listener setup.
      if (pushActive) {
        void pollActionGroupOnce(options.kindPrefix)
      } else {
        scheduleActionGroupPoll(options.kindPrefix, 0)
      }
    })
  })
}

function ensureActionPushSubscription(): Promise<void> {
  const generation = waiterGeneration
  pushSubscriptionPromise ??= subscribeRuntimeEventPush(handleActionEvent, handlePushState)
    .then((subscription) => {
      if (generation !== waiterGeneration) {
        subscription.unsubscribe()
        return
      }
      pushSubscription = subscription
      pushActive = subscription.pushActive
    })
    .catch(() => {
      pushActive = false
    })
    .then(syncFallbackPolling)
  return pushSubscriptionPromise
}

function handleActionEvent(entry: Parameters<typeof readTauriComputerActionEvent>[0]): void {
  const action = readTauriComputerActionEvent(entry)
  if (!action || !isTerminalTauriComputerAction(action)) {
    return
  }
  rememberTerminalAction(action)
  settleActionWait(action.id, action)
}

function handlePushState(active: boolean): void {
  pushActive = active
  syncFallbackPolling()
}

function syncFallbackPolling(): void {
  const prefixes = new Set(Array.from(pendingWaits.values(), (wait) => wait.kindPrefix))
  for (const [prefix, group] of pollGroups) {
    if (pushActive || !prefixes.has(prefix)) {
      if (group.timer) {
        clearTimeout(group.timer)
      }
      group.timer = null
      if (!prefixes.has(prefix) && !group.inFlight) {
        pollGroups.delete(prefix)
      }
    }
  }
  if (pushActive) {
    return
  }
  for (const prefix of prefixes) {
    scheduleActionGroupPoll(prefix, 0)
  }
}

function scheduleActionGroupPoll(kindPrefix: string, delayMs: number): void {
  const group = pollGroups.get(kindPrefix) ?? { timer: null, inFlight: null }
  pollGroups.set(kindPrefix, group)
  if (group.timer || group.inFlight) {
    return
  }
  group.timer = setTimeout(() => {
    group.timer = null
    void pollActionGroupOnce(kindPrefix)
  }, delayMs)
}

async function pollActionGroupOnce(kindPrefix: string): Promise<void> {
  const group = pollGroups.get(kindPrefix) ?? { timer: null, inFlight: null }
  pollGroups.set(kindPrefix, group)
  if (group.inFlight) {
    return group.inFlight
  }
  group.inFlight = requestRuntimeJson<unknown[]>(
    `/v1/computer/actions?kindPrefix=${encodeURIComponent(kindPrefix)}`,
    { method: 'GET' }
  )
    .then((values) => {
      for (const value of values) {
        const action = readTauriComputerAction(value)
        if (!action || !isTerminalTauriComputerAction(action)) {
          continue
        }
        rememberTerminalAction(action)
        settleActionWait(action.id, action)
      }
    })
    .catch(() => undefined)
    .then(() => {
      group.inFlight = null
      if (!pushActive && hasPendingPrefix(kindPrefix)) {
        scheduleActionGroupPoll(kindPrefix, FALLBACK_POLL_INTERVAL_MS)
      } else if (!group.timer) {
        pollGroups.delete(kindPrefix)
      }
    })
  return group.inFlight
}

function hasPendingPrefix(kindPrefix: string): boolean {
  return Array.from(pendingWaits.values()).some((wait) => wait.kindPrefix === kindPrefix)
}

function settleActionWait(
  actionId: string,
  action: TauriComputerActionRecord | null,
  error?: Error
): void {
  const wait = pendingWaits.get(actionId)
  if (!wait) {
    return
  }
  pendingWaits.delete(actionId)
  clearTimeout(wait.timeout)
  if (wait.abort && wait.signal) {
    wait.signal.removeEventListener('abort', wait.abort)
  }
  if (error) {
    wait.reject(error)
  } else if (action) {
    wait.resolve(action)
  }
  syncFallbackPolling()
}

function rememberTerminalAction(action: TauriComputerActionRecord): void {
  const now = Date.now()
  pruneTerminalCache(now)
  terminalCache.set(action.id, {
    action,
    sequence: ++terminalSequence,
    expiresAt: now + TERMINAL_CACHE_TTL_MS
  })
  while (terminalCache.size > TERMINAL_CACHE_LIMIT) {
    const oldest = terminalCache.keys().next().value as string | undefined
    if (!oldest) {
      break
    }
    terminalCache.delete(oldest)
  }
}

function readCachedTerminalAction(
  actionId: string,
  afterSequence: number | undefined
): TauriComputerActionRecord | null {
  const now = Date.now()
  pruneTerminalCache(now)
  const cached = terminalCache.get(actionId)
  if (!cached || (afterSequence !== undefined && cached.sequence <= afterSequence)) {
    return null
  }
  return cached.action
}

function pruneTerminalCache(now: number): void {
  for (const [id, cached] of terminalCache) {
    if (cached.expiresAt <= now) {
      terminalCache.delete(id)
    }
  }
}

export function resetTauriComputerActionWaiterForTests(): void {
  waiterGeneration += 1
  pushSubscription?.unsubscribe()
  pushSubscription = null
  pushSubscriptionPromise = null
  pushActive = false
  for (const wait of pendingWaits.values()) {
    clearTimeout(wait.timeout)
    if (wait.abort && wait.signal) {
      wait.signal.removeEventListener('abort', wait.abort)
    }
  }
  pendingWaits.clear()
  for (const group of pollGroups.values()) {
    if (group.timer) {
      clearTimeout(group.timer)
    }
  }
  pollGroups.clear()
  terminalCache.clear()
  terminalSequence = 0
}
