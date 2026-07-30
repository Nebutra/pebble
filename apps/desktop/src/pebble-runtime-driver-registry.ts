import type {
  RuntimeBrowserDriverState,
  RuntimeTerminalDriverState
} from '../../../packages/product-core/shared/runtime-types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { registerRuntimeSessionDriverConsumer } from './tauri-runtime-session-driver-relay'
import { registerRuntimeBrowserDriverConsumer } from './tauri-runtime-browser-driver-relay'
import { readProviderObject, readProviderOptionalString } from './pebble-runtime-native-providers'

type TerminalFitOverrideSnapshot = {
  ptyId: string
  mode: 'mobile-fit'
  cols: number
  rows: number
}

export type TerminalFitOverrideEvent = {
  ptyId: string
  mode: 'mobile-fit' | 'desktop-fit'
  cols: number
  rows: number
}

type TerminalDriverSnapshot = {
  ptyId: string
  driver: RuntimeTerminalDriverState
}

type BrowserDriverSnapshot = {
  browserPageId: string
  driver: RuntimeBrowserDriverState
}

export type TerminalDriverEvent = TerminalDriverSnapshot
export type BrowserDriverEvent = BrowserDriverSnapshot

const terminalFitOverrides = new Map<string, Omit<TerminalFitOverrideSnapshot, 'ptyId'>>()
const terminalDrivers = new Map<string, RuntimeTerminalDriverState>()
const browserDrivers = new Map<string, RuntimeBrowserDriverState>()
export const terminalFitOverrideListeners = new Set<(event: TerminalFitOverrideEvent) => void>()
export const terminalDriverListeners = new Set<(event: TerminalDriverEvent) => void>()
export const browserDriverListeners = new Set<(event: BrowserDriverEvent) => void>()

// Runtime session.driver events (mobile relay input takes the floor, desktop
// reclaims) feed the same driver map the renderer lock banner listens on.
registerRuntimeSessionDriverConsumer((sessionId, driver) => setTerminalDriver(sessionId, driver))
registerRuntimeBrowserDriverConsumer((browserPageId, driver) =>
  setBrowserDriver(browserPageId, driver)
)

export function readTerminalFitOverrides(): TerminalFitOverrideSnapshot[] {
  return Array.from(terminalFitOverrides.entries()).map(([ptyId, override]) => ({
    ptyId,
    ...override
  }))
}

export function readTerminalDrivers(): TerminalDriverSnapshot[] {
  return Array.from(terminalDrivers.entries()).map(([ptyId, driver]) => ({
    ptyId,
    driver
  }))
}

function readBrowserDrivers(): BrowserDriverSnapshot[] {
  return Array.from(browserDrivers.entries()).map(([browserPageId, driver]) => ({
    browserPageId,
    driver
  }))
}

export async function readBrowserDriversFromRuntime(): Promise<BrowserDriverSnapshot[]> {
  try {
    const snapshots = await requestRuntimeJson<unknown[]>('/v1/browser/drivers', {
      method: 'GET',
      timeoutMs: 5000
    })
    for (const snapshot of snapshots) {
      const input = readProviderObject(snapshot)
      const browserPageId = readProviderOptionalString(input.browserPageId)
      const driver = readProviderObject(input.driver)
      if (!browserPageId) {
        continue
      }
      if (driver.kind === 'mobile' && typeof driver.clientId === 'string') {
        setBrowserDriver(browserPageId, { kind: 'mobile', clientId: driver.clientId })
      } else if (driver.kind === 'desktop' || driver.kind === 'idle') {
        setBrowserDriver(browserPageId, { kind: driver.kind })
      }
    }
  } catch {
    // Why: retain push-fed state when an older runtime lacks snapshot hydration.
  }
  return readBrowserDrivers()
}

function getTerminalDriver(ptyId: string): RuntimeTerminalDriverState {
  return terminalDrivers.get(ptyId) ?? { kind: 'idle' }
}

export function setTerminalDriver(ptyId: string, driver: RuntimeTerminalDriverState): void {
  const previous = getTerminalDriver(ptyId)
  if (sameRuntimeDriver(previous, driver)) {
    return
  }
  if (driver.kind === 'idle') {
    terminalDrivers.delete(ptyId)
  } else {
    terminalDrivers.set(ptyId, driver)
  }
  emitToSet(terminalDriverListeners, { ptyId, driver })
}

function getBrowserDriver(browserPageId: string): RuntimeBrowserDriverState {
  return browserDrivers.get(browserPageId) ?? { kind: 'idle' }
}

function setBrowserDriver(browserPageId: string, driver: RuntimeBrowserDriverState): void {
  const previous = getBrowserDriver(browserPageId)
  if (sameRuntimeDriver(previous, driver)) {
    return
  }
  if (driver.kind === 'idle') {
    browserDrivers.delete(browserPageId)
  } else {
    browserDrivers.set(browserPageId, driver)
  }
  emitToSet(browserDriverListeners, { browserPageId, driver })
}

function sameRuntimeDriver(
  left: RuntimeTerminalDriverState | RuntimeBrowserDriverState,
  right: RuntimeTerminalDriverState | RuntimeBrowserDriverState
): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'mobile' && right.kind === 'mobile') {
    return left.clientId === right.clientId
  }
  return true
}

export function hasTerminalFitOverride(ptyId: string): boolean {
  return terminalFitOverrides.has(ptyId)
}

export function emitTerminalFitOverride(event: TerminalFitOverrideEvent): void {
  if (event.mode === 'mobile-fit') {
    terminalFitOverrides.set(event.ptyId, {
      mode: 'mobile-fit',
      cols: event.cols,
      rows: event.rows
    })
  } else {
    terminalFitOverrides.delete(event.ptyId)
  }
  emitToSet(terminalFitOverrideListeners, event)
}

export async function restoreTauriTerminalFit(ptyId: string): Promise<{ restored: boolean }> {
  const hadFitOverride = terminalFitOverrides.has(ptyId)
  const previousDriver = getTerminalDriver(ptyId)
  if (hadFitOverride) {
    emitTerminalFitOverride({ ptyId, mode: 'desktop-fit', cols: 0, rows: 0 })
  }
  // Why: the runtime enforces the presence lock on writes, so a desktop
  // take-back must flip the runtime-side driver too, not only the mirror.
  await requestRuntimeJson(`/v1/sessions/${encodeURIComponent(ptyId)}/reclaim-desktop`, {
    method: 'POST',
    timeoutMs: 5000
  }).catch(() => undefined)
  setTerminalDriver(ptyId, { kind: 'desktop' })
  return { restored: hadFitOverride || previousDriver.kind === 'mobile' }
}

export async function reclaimTauriBrowserForDesktop(
  browserPageId: string
): Promise<{ reclaimed: boolean }> {
  const previousDriver = getBrowserDriver(browserPageId)
  await requestRuntimeJson(
    `/v1/browser/tabs/${encodeURIComponent(browserPageId)}/reclaim-desktop`,
    { method: 'POST', timeoutMs: 5000 }
  )
  setBrowserDriver(browserPageId, { kind: 'desktop' })
  return { reclaimed: previousDriver.kind === 'mobile' }
}

export function subscribeToSet<TEvent>(
  listeners: Set<(event: TEvent) => void>,
  callback: (event: TEvent) => void
): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

function emitToSet<TEvent>(listeners: Set<(event: TEvent) => void>, event: TEvent): void {
  for (const listener of listeners) {
    listener(event)
  }
}
