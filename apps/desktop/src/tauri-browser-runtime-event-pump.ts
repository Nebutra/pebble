import { listen } from '@tauri-apps/api/event'
import { createRuntimeEventStreamCommand, readRuntimeEventStream } from './runtime-bridge'
import type { RuntimeEventStreamEntry } from './runtime-command-shapes'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'
import {
  navigationListeners,
  activateViewListeners,
  openLinkListeners,
  popupListeners,
  permissionDeniedListeners,
  contextMenuRequestedListeners,
  contextMenuDismissedListeners,
  grabModeToggleListeners,
  grabActionShortcutListeners,
  emitTo
} from './tauri-browser-event-listener-registry'
import {
  NATIVE_BROWSER_DOWNLOAD_EVENT,
  type NativeBrowserDownloadEvent,
  emitBrowserDownload,
  handleNativeBrowserDownload,
  isRuntimeBrowserDownload
} from './tauri-browser-download-bridge'

type RuntimeBrowserTab = {
  id: string
  worktreeId?: string
  title?: string
  url?: string
}

type NativeBrowserContextMenuEvent =
  | {
      kind: 'requested'
      browserTabId: string
      screenX: number
      screenY: number
      pageUrl: string
      linkUrl: string
      selectionText: string
    }
  | { kind: 'dismissed'; browserTabId: string }
  | { kind: 'permissionDenied'; browserTabId: string; permission: string; origin: string }
  | { kind: 'grabModeToggle'; browserTabId: string }
  | { kind: 'grabActionShortcut'; browserTabId: string; key: 'c' | 's' }

type RuntimeEvent = {
  topic: string
  payload?: unknown
}

const NATIVE_BROWSER_NEW_WINDOW_EVENT = 'pebble://browser-new-window'
const NATIVE_BROWSER_CONTEXT_MENU_EVENT = 'pebble://browser-context-menu'
let browserEventPumpStarted = false
let browserPollingActive = false
let browserPollingGeneration = 0

export function ensureTauriBrowserRuntimeEventPump(): void {
  if (browserEventPumpStarted) {
    return
  }
  browserEventPumpStarted = true
  void startBrowserEventDelivery()
}

// Prefer the native push pipeline; only fall back to polling when push is unavailable
// (older runtime, remote/SSH transport that can't stream), so idle sessions do no round trips.
async function startBrowserEventDelivery(): Promise<void> {
  void listen<NativeBrowserDownloadEvent>(NATIVE_BROWSER_DOWNLOAD_EVENT, (event) => {
    void handleNativeBrowserDownload(event.payload)
  })
  void listen<{
    browserTabId: string
    url: string
    allowedInPebble: boolean
  }>(NATIVE_BROWSER_NEW_WINDOW_EVENT, ({ payload }) => {
    const origin = safeBrowserOrigin(payload.url)
    if (payload.allowedInPebble) {
      emitTo(openLinkListeners, { browserPageId: payload.browserTabId, url: payload.url })
    }
    emitTo(popupListeners, {
      browserPageId: payload.browserTabId,
      origin,
      action: payload.allowedInPebble ? 'opened-in-pebble' : 'blocked'
    })
  })
  void listen<NativeBrowserContextMenuEvent>(NATIVE_BROWSER_CONTEXT_MENU_EVENT, ({ payload }) => {
    if (payload.kind === 'grabModeToggle') {
      emitTo(grabModeToggleListeners, payload.browserTabId)
      return
    }
    if (payload.kind === 'grabActionShortcut') {
      emitTo(grabActionShortcutListeners, {
        browserPageId: payload.browserTabId,
        key: payload.key
      })
      return
    }
    if (payload.kind === 'permissionDenied') {
      emitTo(permissionDeniedListeners, {
        browserPageId: payload.browserTabId,
        permission: payload.permission,
        origin: safeBrowserOrigin(payload.origin)
      })
      return
    }
    if (payload.kind === 'dismissed') {
      emitTo(contextMenuDismissedListeners, { browserPageId: payload.browserTabId })
      return
    }
    emitTo(contextMenuRequestedListeners, {
      browserPageId: payload.browserTabId,
      x: 0,
      y: 0,
      screenX: payload.screenX,
      screenY: payload.screenY,
      pageUrl: payload.pageUrl,
      linkUrl: payload.linkUrl || null,
      selectionText: payload.selectionText,
      canGoBack: false,
      canGoForward: false
    })
  })
  const { supported } = await subscribeRuntimeEventPush(
    (entry) => {
      if (entry.topic && entry.topic !== 'browser.changed') {
        return
      }
      handleBrowserChangedEvent(entry)
    },
    // Push disconnected (or never connected) -> poll; reconnected -> stop polling so a live
    // stream isn't shadowed by a poller delivering the same browser.changed events twice.
    (pushActive) => setBrowserPolling(!pushActive)
  )
  if (!supported) {
    setBrowserPolling(true)
  }
}

function safeBrowserOrigin(value: string): string {
  try {
    const url = new URL(value)
    return url.origin === 'null' ? url.protocol : url.origin
  } catch {
    return 'unknown'
  }
}

// A generation counter fences the poll loop: enabling bumps it and starts a fresh loop; the
// old loop sees a stale generation and exits, so a reconnect never leaves a duplicate poller.
function setBrowserPolling(active: boolean): void {
  if (active === browserPollingActive) {
    return
  }
  browserPollingActive = active
  if (!active) {
    browserPollingGeneration += 1
    return
  }
  void pumpBrowserEvents(browserPollingGeneration)
}

function isBrowserPollGenerationCurrent(generation: number): boolean {
  return browserPollingActive && generation === browserPollingGeneration
}

async function pumpBrowserEvents(generation: number): Promise<void> {
  while (isBrowserPollGenerationCurrent(generation)) {
    const events = await readRuntimeEvents()
    if (events.length === 0) {
      await delay(1000)
    }
    for (const event of events) {
      handleBrowserChangedEvent(event)
    }
  }
}

async function readRuntimeEvents(): Promise<RuntimeEventStreamEntry[]> {
  const result = await readRuntimeEventStream(
    // Why: browser events are polled from the renderer; keep each native invoke
    // bounded so a quiet runtime cannot make the desktop shell feel hung.
    createRuntimeEventStreamCommand({ topic: 'browser.changed', limit: 20 })
  ).catch(() => null)
  return result?.transport === 'connected' ? result.events : []
}

function handleBrowserChangedEvent(entry: RuntimeEventStreamEntry): void {
  const event = parseRuntimeEvent(entry)
  if (!event || event.topic !== 'browser.changed') {
    return
  }
  const payload = readObject(event.payload)
  const deleted = readObject(payload.deleted)
  const value = Object.keys(deleted).length > 0 ? deleted : payload
  if (isRuntimeBrowserDownload(value)) {
    emitBrowserDownload(value)
    return
  }
  if (isRuntimeBrowserTab(value)) {
    emitBrowserTab(value)
  }
}

function emitBrowserTab(tab: RuntimeBrowserTab): void {
  if (tab.url) {
    emitTo(navigationListeners, {
      browserPageId: tab.id,
      url: tab.url,
      title: tab.title ?? tab.url
    })
  }
  emitTo(activateViewListeners, { worktreeId: tab.worktreeId, browserPageId: tab.id })
}

function parseRuntimeEvent(entry: RuntimeEventStreamEntry): RuntimeEvent | null {
  try {
    return JSON.parse(entry.data) as RuntimeEvent
  } catch {
    return null
  }
}

function isRuntimeBrowserTab(value: Record<string, unknown>): value is RuntimeBrowserTab {
  return typeof value.id === 'string' && typeof value.url === 'string'
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
