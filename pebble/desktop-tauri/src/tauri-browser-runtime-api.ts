import type { BrowserApi } from '../../../src/preload/api-types'
import {
  ensureTauriBrowserRuntimeEventPump,
  notifyTauriBrowserActiveTab,
  onTauriBrowserActivateView,
  onTauriBrowserDownloadFinished,
  onTauriBrowserDownloadProgress,
  onTauriBrowserDownloadRequested,
  onTauriBrowserNavigationUpdate,
  onTauriBrowserPaneFocus,
  registerTauriBrowserGuest,
  unregisterTauriBrowserGuest
} from './tauri-browser-runtime-events'
import {
  cancelTauriBrowserDownload,
  createTauriBrowserSessionProfile,
  deleteTauriBrowserSessionProfile,
  ensureTauriBrowserProviderRefresh,
  listTauriBrowserSessionProfiles,
  resolveTauriBrowserSessionPartition,
  TAURI_BROWSER_GUEST_UNAVAILABLE
} from './tauri-browser-runtime-profiles'

export function installTauriBrowserRuntimeApi(): void {
  if (!hasTauriInternals()) {
    return
  }

  const base = window.api.browser
  window.api.browser = {
    ...base,
    registerGuest: async (args) => {
      registerTauriBrowserGuest(args)
    },
    unregisterGuest: async ({ browserPageId }) => {
      unregisterTauriBrowserGuest(browserPageId)
    },
    openDevTools: () => Promise.resolve(false),
    setViewportOverride: () => Promise.resolve(false),
    setAnnotationViewportBridge: () => Promise.resolve(false),
    onNavigationUpdate: onTauriBrowserNavigationUpdate,
    onActivateView: onTauriBrowserActivateView,
    onPaneFocus: onTauriBrowserPaneFocus,
    onDownloadRequested: onTauriBrowserDownloadRequested,
    onDownloadProgress: onTauriBrowserDownloadProgress,
    onDownloadFinished: onTauriBrowserDownloadFinished,
    cancelDownload: cancelTauriBrowserDownload,
    setGrabMode: async () => ({ ok: false, reason: 'not-ready' }),
    awaitGrabSelection: async ({ opId }) => ({
      opId,
      kind: 'error',
      reason: TAURI_BROWSER_GUEST_UNAVAILABLE
    }),
    cancelGrab: () => Promise.resolve(false),
    captureSelectionScreenshot: async () => ({
      ok: false,
      reason: TAURI_BROWSER_GUEST_UNAVAILABLE
    }),
    extractHoverPayload: async () => ({
      ok: false,
      reason: TAURI_BROWSER_GUEST_UNAVAILABLE
    }),
    sessionListProfiles: listTauriBrowserSessionProfiles,
    sessionCreateProfile: createTauriBrowserSessionProfile,
    sessionDeleteProfile: deleteTauriBrowserSessionProfile,
    sessionImportCookies: async () => ({
      ok: false,
      reason: TAURI_BROWSER_GUEST_UNAVAILABLE
    }),
    sessionResolvePartition: resolveTauriBrowserSessionPartition,
    sessionDetectBrowsers: () => Promise.resolve([]),
    sessionImportFromBrowser: async () => ({
      ok: false,
      reason: TAURI_BROWSER_GUEST_UNAVAILABLE
    }),
    sessionClearDefaultCookies: () => Promise.resolve(false),
    notifyActiveTabChanged: async ({ browserPageId }) =>
      notifyTauriBrowserActiveTab(browserPageId)
  } satisfies BrowserApi

  ensureTauriBrowserRuntimeEventPump()
  ensureTauriBrowserProviderRefresh()
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
