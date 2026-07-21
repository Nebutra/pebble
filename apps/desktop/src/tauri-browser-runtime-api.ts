import type { BrowserApi } from '../../../packages/product-core/shared/browser-api-types'
import {
  ensureTauriBrowserRuntimeEventPump,
  notifyTauriBrowserActiveTab,
  onTauriBrowserActivateView,
  onTauriBrowserDownloadFinished,
  onTauriBrowserDownloadProgress,
  onTauriBrowserDownloadRequested,
  onTauriBrowserGuestLoadFailed,
  onTauriBrowserGrabActionShortcut,
  onTauriBrowserGrabModeToggle,
  onTauriBrowserPermissionDenied,
  onTauriBrowserContextMenuDismissed,
  onTauriBrowserContextMenuRequested,
  onTauriBrowserNavigationUpdate,
  onTauriBrowserOpenLink,
  onTauriBrowserPaneFocus,
  onTauriBrowserPopup,
  registerTauriBrowserGuest,
  unregisterTauriBrowserGuest
} from './tauri-browser-runtime-events'
import {
  cancelTauriBrowserDownload,
  createTauriBrowserSessionProfile,
  deleteTauriBrowserSessionProfile,
  detectTauriBrowserSessionBrowsers,
  ensureTauriBrowserProviderRefresh,
  listTauriBrowserSessionProfiles,
  resolveTauriBrowserSessionPartition
} from './tauri-browser-runtime-profiles'
import {
  ensureTauriBrowserActionConsumer,
  installTauriBrowserActionExecutorBridge
} from './tauri-browser-action-consumer'
import { setTauriBrowserViewportOverride } from './tauri-browser-viewport-state'
import { installTauriBrowserScreencastBridge } from './tauri-browser-screencast-channel'
import { installTauriBrowserVideoRecordingBridge } from './tauri-browser-video-recording'
import { installTauriBrowserPermissionOverrideBridge } from './tauri-browser-permission-overrides'
import {
  awaitTauriBrowserGrabSelection,
  cancelTauriBrowserGrab,
  captureTauriBrowserSelectionScreenshot,
  clearTauriBrowserDefaultCookies,
  extractTauriBrowserHoverPayload,
  importTauriBrowserCookiesFromFile,
  importTauriBrowserCookiesFromBrowser,
  openTauriBrowserPageDevTools,
  setTauriBrowserAnnotationViewportBridge,
  setTauriBrowserGrabMode
} from '@/components/browser-pane/tauri-browser-page-webview'

export function installTauriBrowserRuntimeApi(): void {
  if (!hasTauriInternals()) {
    return
  }

  const base = window.api.browser
  installTauriBrowserPermissionOverrideBridge()
  window.api.browser = {
    ...base,
    registerGuest: async (args) => {
      await registerTauriBrowserGuest(args)
    },
    unregisterGuest: async ({ browserPageId }) => {
      await unregisterTauriBrowserGuest(browserPageId)
    },
    openDevTools: ({ browserPageId }) => openTauriBrowserPageDevTools(browserPageId),
    setViewportOverride: async ({ browserPageId, override }) => {
      setTauriBrowserViewportOverride({ browserPageId, override })
      return true
    },
    setAnnotationViewportBridge: setTauriBrowserAnnotationViewportBridge,
    onGuestLoadFailed: onTauriBrowserGuestLoadFailed,
    onPermissionDenied: onTauriBrowserPermissionDenied,
    onContextMenuRequested: onTauriBrowserContextMenuRequested,
    onContextMenuDismissed: onTauriBrowserContextMenuDismissed,
    onNavigationUpdate: onTauriBrowserNavigationUpdate,
    onActivateView: onTauriBrowserActivateView,
    onPaneFocus: onTauriBrowserPaneFocus,
    onPopup: onTauriBrowserPopup,
    onOpenLinkInPebbleTab: onTauriBrowserOpenLink,
    onDownloadRequested: onTauriBrowserDownloadRequested,
    onDownloadProgress: onTauriBrowserDownloadProgress,
    onDownloadFinished: onTauriBrowserDownloadFinished,
    cancelDownload: cancelTauriBrowserDownload,
    setGrabMode: setTauriBrowserGrabMode,
    awaitGrabSelection: awaitTauriBrowserGrabSelection,
    cancelGrab: cancelTauriBrowserGrab,
    captureSelectionScreenshot: captureTauriBrowserSelectionScreenshot,
    extractHoverPayload: extractTauriBrowserHoverPayload,
    onGrabModeToggle: onTauriBrowserGrabModeToggle,
    onGrabActionShortcut: onTauriBrowserGrabActionShortcut,
    sessionListProfiles: listTauriBrowserSessionProfiles,
    sessionCreateProfile: createTauriBrowserSessionProfile,
    sessionDeleteProfile: deleteTauriBrowserSessionProfile,
    sessionImportCookies: importTauriBrowserCookiesFromFile,
    sessionResolvePartition: resolveTauriBrowserSessionPartition,
    sessionDetectBrowsers: detectTauriBrowserSessionBrowsers,
    sessionImportFromBrowser: importTauriBrowserCookiesFromBrowser,
    sessionClearDefaultCookies: clearTauriBrowserDefaultCookies,
    notifyActiveTabChanged: async ({ browserPageId }) => notifyTauriBrowserActiveTab(browserPageId)
  } satisfies BrowserApi

  installTauriBrowserActionExecutorBridge()
  installTauriBrowserScreencastBridge()
  installTauriBrowserVideoRecordingBridge()
  ensureTauriBrowserRuntimeEventPump()
  ensureTauriBrowserProviderRefresh()
  ensureTauriBrowserActionConsumer()
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
