import type { BrowserApi } from '../../../packages/product-core/shared/browser-api-types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  type NavigationListener,
  type ActivateViewListener,
  type PaneFocusListener,
  type DownloadRequestedListener,
  type DownloadProgressListener,
  type DownloadFinishedListener,
  type PopupListener,
  type OpenLinkListener,
  type GuestLoadFailedListener,
  type PermissionDeniedListener,
  type ContextMenuRequestedListener,
  type ContextMenuDismissedListener,
  type GrabModeToggleListener,
  type GrabActionShortcutListener,
  navigationListeners,
  activateViewListeners,
  paneFocusListeners,
  downloadRequestedListeners,
  downloadProgressListeners,
  downloadFinishedListeners,
  popupListeners,
  openLinkListeners,
  guestLoadFailedListeners,
  permissionDeniedListeners,
  contextMenuRequestedListeners,
  contextMenuDismissedListeners,
  grabModeToggleListeners,
  grabActionShortcutListeners,
  emitTo
} from './tauri-browser-event-listener-registry'
import { ensureTauriBrowserRuntimeEventPump } from './tauri-browser-runtime-event-pump'

export { ensureTauriBrowserRuntimeEventPump } from './tauri-browser-runtime-event-pump'
export { cancelNativeTauriBrowserDownload } from './tauri-browser-download-bridge'

type RuntimeBrowserTab = {
  id: string
  worktreeId?: string
  title?: string
  url?: string
}

type GuestRegistration = {
  browserPageId: string
  worktreeId: string
  sessionProfileId: string | null
  webContentsId: number
}

const guestRegistrations = new Map<string, GuestRegistration>()
if (typeof window !== 'undefined') {
  window.__pebbleReportTauriBrowserLoadFailure = reportTauriBrowserGuestLoadFailed
}

export async function registerTauriBrowserGuest(
  args: Parameters<BrowserApi['registerGuest']>[0]
): Promise<void> {
  await requestRuntimeJson<RuntimeBrowserTab>('/v1/browser/tabs', {
    method: 'POST',
    body: {
      id: args.browserPageId,
      projectId: args.workspaceId,
      worktreeId: args.worktreeId,
      profileId: args.sessionProfileId ?? undefined,
      title: args.browserPageId,
      url: 'about:blank'
    }
  })
  guestRegistrations.set(args.browserPageId, {
    browserPageId: args.browserPageId,
    worktreeId: args.worktreeId,
    sessionProfileId: args.sessionProfileId ?? null,
    webContentsId: args.webContentsId
  })
}

export async function unregisterTauriBrowserGuest(browserPageId: string): Promise<void> {
  await requestRuntimeJson<RuntimeBrowserTab>(
    `/v1/browser/tabs/${encodeURIComponent(browserPageId)}`,
    { method: 'DELETE' }
  )
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

export function onTauriBrowserPopup(callback: PopupListener): () => void {
  return subscribe(popupListeners, callback)
}

export function onTauriBrowserOpenLink(callback: OpenLinkListener): () => void {
  return subscribe(openLinkListeners, callback)
}

export function onTauriBrowserGuestLoadFailed(callback: GuestLoadFailedListener): () => void {
  return subscribe(guestLoadFailedListeners, callback)
}

export function onTauriBrowserPermissionDenied(callback: PermissionDeniedListener): () => void {
  return subscribe(permissionDeniedListeners, callback)
}

export function onTauriBrowserContextMenuRequested(
  callback: ContextMenuRequestedListener
): () => void {
  return subscribe(contextMenuRequestedListeners, callback)
}

export function onTauriBrowserContextMenuDismissed(
  callback: ContextMenuDismissedListener
): () => void {
  return subscribe(contextMenuDismissedListeners, callback)
}

export function onTauriBrowserGrabModeToggle(callback: GrabModeToggleListener): () => void {
  return subscribe(grabModeToggleListeners, callback)
}

export function onTauriBrowserGrabActionShortcut(callback: GrabActionShortcutListener): () => void {
  return subscribe(grabActionShortcutListeners, callback)
}

export function reportTauriBrowserGuestLoadFailed(
  args: Parameters<GuestLoadFailedListener>[0]
): void {
  emitTo(guestLoadFailedListeners, args)
}

function subscribe<Callback>(listeners: Set<Callback>, callback: Callback): () => void {
  listeners.add(callback)
  ensureTauriBrowserRuntimeEventPump()
  return () => {
    listeners.delete(callback)
  }
}
