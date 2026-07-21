import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

type PtyData = Parameters<Parameters<PreloadApi['pty']['onData']>[0]>[0]
type DeliveryListener = (data: PtyData) => void

const ACTIVE_IN_FLIGHT_LIMIT = 256 * 1024
const VISIBLE_IN_FLIGHT_LIMIT = 128 * 1024
const BACKGROUND_IN_FLIGHT_LIMIT = 32 * 1024

const listeners = new Set<DeliveryListener>()
const pendingByPty = new Map<string, PtyData[]>()
const pendingCharsByPty = new Map<string, number>()
const inFlightCharsByPty = new Map<string, number>()
const activePtys = new Set<string>()
const visibilityKnownPtys = new Set<string>()
const visiblePtys = new Set<string>()
let flushScheduled = false
let peakPendingChars = 0
let peakMaxPendingCharsByPty = 0
let peakRendererInFlightChars = 0
let peakMaxRendererInFlightCharsByPty = 0
let ackGatedFlushSkipCount = 0

export function addRuntimePtyDeliveryListener(listener: DeliveryListener): () => void {
  listeners.add(listener)
  scheduleFlush()
  return () => listeners.delete(listener)
}

export function enqueueRuntimePtyData(data: PtyData): void {
  const background = visibilityKnownPtys.has(data.id) && !visiblePtys.has(data.id)
  const queue = pendingByPty.get(data.id) ?? []
  queue.push({ ...data, background })
  pendingByPty.set(data.id, queue)
  pendingCharsByPty.set(data.id, (pendingCharsByPty.get(data.id) ?? 0) + data.data.length)
  recordPeaks()
  scheduleFlush()
}

export function acknowledgeRuntimePtyData(id: string, charCount: number): void {
  const acknowledged = Number.isFinite(charCount) ? Math.max(0, Math.floor(charCount)) : 0
  const next = Math.max(0, (inFlightCharsByPty.get(id) ?? 0) - acknowledged)
  if (next === 0) {
    inFlightCharsByPty.delete(id)
  } else {
    inFlightCharsByPty.set(id, next)
  }
  scheduleFlush()
}

export function setActiveRuntimeRendererPty(id: string, active: boolean): void {
  updateSet(activePtys, id, active)
  scheduleFlush()
}

export function setRuntimeRendererPtyVisible(id: string, visible: boolean): void {
  visibilityKnownPtys.add(id)
  updateSet(visiblePtys, id, visible)
  scheduleFlush()
}

export function forgetRuntimePtyDelivery(id: string): void {
  pendingByPty.delete(id)
  pendingCharsByPty.delete(id)
  inFlightCharsByPty.delete(id)
  activePtys.delete(id)
  visibilityKnownPtys.delete(id)
  visiblePtys.delete(id)
}

export function getRuntimePtyDeliveryDebugSnapshot(): Promise<
  Awaited<ReturnType<PreloadApi['pty']['getRendererDeliveryDebugSnapshot']>>
> {
  const pendingValues = [...pendingCharsByPty.values()]
  const inFlightValues = [...inFlightCharsByPty.values()]
  return Promise.resolve({
    pendingPtyCount: pendingByPty.size,
    pendingChars: sum(pendingValues),
    maxPendingCharsByPty: Math.max(0, ...pendingValues),
    rendererInFlightPtyCount: inFlightCharsByPty.size,
    rendererInFlightChars: sum(inFlightValues),
    maxRendererInFlightCharsByPty: Math.max(0, ...inFlightValues),
    activeRendererPtyCount: activePtys.size,
    flushScheduled,
    peakPendingChars,
    peakMaxPendingCharsByPty,
    peakRendererInFlightChars,
    peakMaxRendererInFlightCharsByPty,
    ackGatedFlushSkipCount
  })
}

export function resetRuntimePtyDeliveryDebug(): Promise<void> {
  peakPendingChars = 0
  peakMaxPendingCharsByPty = 0
  peakRendererInFlightChars = 0
  peakMaxRendererInFlightCharsByPty = 0
  ackGatedFlushSkipCount = 0
  recordPeaks()
  return Promise.resolve()
}

function scheduleFlush(): void {
  if (flushScheduled || listeners.size === 0 || pendingByPty.size === 0) {
    return
  }
  flushScheduled = true
  queueMicrotask(flushPendingData)
}

function flushPendingData(): void {
  flushScheduled = false
  if (listeners.size === 0) {
    return
  }
  for (const id of prioritizedPendingPtyIds()) {
    const queue = pendingByPty.get(id)
    if (!queue) {
      continue
    }
    while (queue.length > 0) {
      const next = queue[0]
      const inFlight = inFlightCharsByPty.get(id) ?? 0
      if (inFlight > 0 && inFlight + next.data.length > deliveryLimit(id)) {
        ackGatedFlushSkipCount += 1
        break
      }
      queue.shift()
      const remaining = Math.max(0, (pendingCharsByPty.get(id) ?? 0) - next.data.length)
      if (remaining === 0) {
        pendingCharsByPty.delete(id)
      } else {
        pendingCharsByPty.set(id, remaining)
      }
      inFlightCharsByPty.set(id, inFlight + next.data.length)
      for (const listener of listeners) {
        listener(next)
      }
    }
    if (queue.length === 0) {
      pendingByPty.delete(id)
    }
  }
  recordPeaks()
  if (hasImmediatelyDeliverableData()) {
    scheduleFlush()
  }
}

function prioritizedPendingPtyIds(): string[] {
  return [...pendingByPty.keys()].sort(
    (left, right) => deliveryPriority(right) - deliveryPriority(left)
  )
}

function deliveryPriority(id: string): number {
  if (activePtys.has(id)) {
    return 2
  }
  if (!visibilityKnownPtys.has(id) || visiblePtys.has(id)) {
    return 1
  }
  return 0
}

function deliveryLimit(id: string): number {
  if (activePtys.has(id)) {
    return ACTIVE_IN_FLIGHT_LIMIT
  }
  if (!visibilityKnownPtys.has(id) || visiblePtys.has(id)) {
    return VISIBLE_IN_FLIGHT_LIMIT
  }
  return BACKGROUND_IN_FLIGHT_LIMIT
}

function hasImmediatelyDeliverableData(): boolean {
  for (const [id, queue] of pendingByPty) {
    const next = queue[0]
    const inFlight = inFlightCharsByPty.get(id) ?? 0
    if (next && (inFlight === 0 || inFlight + next.data.length <= deliveryLimit(id))) {
      return true
    }
  }
  return false
}

function recordPeaks(): void {
  const pendingValues = [...pendingCharsByPty.values()]
  const inFlightValues = [...inFlightCharsByPty.values()]
  peakPendingChars = Math.max(peakPendingChars, sum(pendingValues))
  peakMaxPendingCharsByPty = Math.max(peakMaxPendingCharsByPty, ...pendingValues, 0)
  peakRendererInFlightChars = Math.max(peakRendererInFlightChars, sum(inFlightValues))
  peakMaxRendererInFlightCharsByPty = Math.max(
    peakMaxRendererInFlightCharsByPty,
    ...inFlightValues,
    0
  )
}

function updateSet(target: Set<string>, id: string, enabled: boolean): void {
  if (enabled) {
    target.add(id)
  } else {
    target.delete(id)
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
