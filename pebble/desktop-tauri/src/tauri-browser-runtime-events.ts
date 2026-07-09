import type { BrowserApi } from '../../../src/preload/api-types'
import { createRuntimeEventStreamCommand, readRuntimeEventStream } from './runtime-bridge'
import type { RuntimeEventStreamEntry } from './runtime-command-shapes'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'

type RuntimeBrowserTab = {
  id: string
  worktreeId?: string
  title?: string
  url?: string
}

type RuntimeBrowserDownload = {
  id: string
  tabId?: string
  filename?: string
  path?: string
  status?: 'queued' | 'inProgress' | 'completed' | 'canceled' | 'failed'
  bytesReceived?: number
  totalBytes?: number
  error?: string
}

type RuntimeEvent = {
  topic: string
  payload?: unknown
}

type GuestRegistration = {
  browserPageId: string
  worktreeId: string
  sessionProfileId: string | null
  webContentsId: number
}

type NavigationListener = Parameters<BrowserApi['onNavigationUpdate']>[0]
type ActivateViewListener = Parameters<BrowserApi['onActivateView']>[0]
type PaneFocusListener = Parameters<BrowserApi['onPaneFocus']>[0]
type DownloadRequestedListener = Parameters<BrowserApi['onDownloadRequested']>[0]
type DownloadProgressListener = Parameters<BrowserApi['onDownloadProgress']>[0]
type DownloadFinishedListener = Parameters<BrowserApi['onDownloadFinished']>[0]

const guestRegistrations = new Map<string, GuestRegistration>()
const navigationListeners = new Set<NavigationListener>()
const activateViewListeners = new Set<ActivateViewListener>()
const paneFocusListeners = new Set<PaneFocusListener>()
const downloadRequestedListeners = new Set<DownloadRequestedListener>()
const downloadProgressListeners = new Set<DownloadProgressListener>()
const downloadFinishedListeners = new Set<DownloadFinishedListener>()
let browserEventPumpStarted = false
let browserPollingActive = false
let browserPollingGeneration = 0

export function registerTauriBrowserGuest(args: Parameters<BrowserApi['registerGuest']>[0]): void {
  guestRegistrations.set(args.browserPageId, {
    browserPageId: args.browserPageId,
    worktreeId: args.worktreeId,
    sessionProfileId: args.sessionProfileId ?? null,
    webContentsId: args.webContentsId
  })
}

export function unregisterTauriBrowserGuest(browserPageId: string): void {
  guestRegistrations.delete(browserPageId)
}

export function notifyTauriBrowserActiveTab(browserPageId: string): boolean {
  const registration = guestRegistrations.get(browserPageId)
  if (!registration) {
    return false
  }
  emitTo(paneFocusListeners, {
    worktreeId: registration.worktreeId,
    browserPageId
  })
  return true
}

export function onTauriBrowserNavigationUpdate(callback: NavigationListener): () => void {
  return subscribe(navigationListeners, callback)
}

export function onTauriBrowserActivateView(callback: ActivateViewListener): () => void {
  return subscribe(activateViewListeners, callback)
}

export function onTauriBrowserPaneFocus(callback: PaneFocusListener): () => void {
  return subscribe(paneFocusListeners, callback)
}

export function onTauriBrowserDownloadRequested(callback: DownloadRequestedListener): () => void {
  return subscribe(downloadRequestedListeners, callback)
}

export function onTauriBrowserDownloadProgress(callback: DownloadProgressListener): () => void {
  return subscribe(downloadProgressListeners, callback)
}

export function onTauriBrowserDownloadFinished(callback: DownloadFinishedListener): () => void {
  return subscribe(downloadFinishedListeners, callback)
}

export function ensureTauriBrowserRuntimeEventPump(): void {
  if (browserEventPumpStarted) {
    return
  }
  browserEventPumpStarted = true
  void startBrowserEventDelivery()
}

function subscribe<Callback>(listeners: Set<Callback>, callback: Callback): () => void {
  listeners.add(callback)
  ensureTauriBrowserRuntimeEventPump()
  return () => {
    listeners.delete(callback)
  }
}

// Prefer the native push pipeline; only fall back to polling when push is unavailable
// (older runtime, remote/SSH transport that can't stream), so idle sessions do no round trips.
async function startBrowserEventDelivery(): Promise<void> {
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

function emitBrowserDownload(download: RuntimeBrowserDownload): void {
  const downloadId = download.id
  const totalBytes = download.totalBytes ?? null
  if (download.status === 'inProgress' || download.status === 'queued') {
    emitTo(downloadRequestedListeners, {
      browserPageId: download.tabId ?? '',
      downloadId,
      origin: download.path ?? '',
      filename: download.filename ?? downloadId,
      totalBytes,
      mimeType: null,
      savePath: download.path ?? '',
      status: 'downloading'
    })
    emitTo(downloadProgressListeners, {
      browserPageId: download.tabId,
      downloadId,
      receivedBytes: download.bytesReceived ?? 0,
      totalBytes,
      state: 'progressing'
    })
  }
  if (
    download.status === 'completed' ||
    download.status === 'canceled' ||
    download.status === 'failed'
  ) {
    emitTo(downloadFinishedListeners, {
      browserPageId: download.tabId,
      downloadId,
      status: download.status === 'canceled' ? 'canceled' : download.status,
      savePath: download.path ?? null,
      error: download.error ?? null
    })
  }
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

function isRuntimeBrowserDownload(value: Record<string, unknown>): value is RuntimeBrowserDownload {
  if (typeof value.id !== 'string') {
    return false
  }
  if ('bytesReceived' in value || 'totalBytes' in value || 'filename' in value || 'path' in value) {
    return true
  }
  return (
    value.status === 'queued' ||
    value.status === 'inProgress' ||
    value.status === 'completed' ||
    value.status === 'canceled' ||
    value.status === 'failed'
  )
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function emitTo<Payload>(listeners: Set<(payload: Payload) => void>, payload: Payload): void {
  for (const listener of listeners) {
    listener(payload)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
