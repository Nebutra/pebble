import type { BrowserApi } from '../../../packages/product-core/shared/browser-api-types'

export type NavigationListener = Parameters<BrowserApi['onNavigationUpdate']>[0]
export type ActivateViewListener = Parameters<BrowserApi['onActivateView']>[0]
export type PaneFocusListener = Parameters<BrowserApi['onPaneFocus']>[0]
export type DownloadRequestedListener = Parameters<BrowserApi['onDownloadRequested']>[0]
export type DownloadProgressListener = Parameters<BrowserApi['onDownloadProgress']>[0]
export type DownloadFinishedListener = Parameters<BrowserApi['onDownloadFinished']>[0]
export type PopupListener = Parameters<BrowserApi['onPopup']>[0]
export type OpenLinkListener = Parameters<BrowserApi['onOpenLinkInPebbleTab']>[0]
export type GuestLoadFailedListener = Parameters<BrowserApi['onGuestLoadFailed']>[0]
export type PermissionDeniedListener = Parameters<BrowserApi['onPermissionDenied']>[0]
export type ContextMenuRequestedListener = Parameters<BrowserApi['onContextMenuRequested']>[0]
export type ContextMenuDismissedListener = Parameters<BrowserApi['onContextMenuDismissed']>[0]
export type GrabModeToggleListener = Parameters<BrowserApi['onGrabModeToggle']>[0]
export type GrabActionShortcutListener = Parameters<BrowserApi['onGrabActionShortcut']>[0]

export const navigationListeners = new Set<NavigationListener>()
export const activateViewListeners = new Set<ActivateViewListener>()
export const paneFocusListeners = new Set<PaneFocusListener>()
export const downloadRequestedListeners = new Set<DownloadRequestedListener>()
export const downloadProgressListeners = new Set<DownloadProgressListener>()
export const downloadFinishedListeners = new Set<DownloadFinishedListener>()
export const popupListeners = new Set<PopupListener>()
export const openLinkListeners = new Set<OpenLinkListener>()
export const guestLoadFailedListeners = new Set<GuestLoadFailedListener>()
export const permissionDeniedListeners = new Set<PermissionDeniedListener>()
export const contextMenuRequestedListeners = new Set<ContextMenuRequestedListener>()
export const contextMenuDismissedListeners = new Set<ContextMenuDismissedListener>()
export const grabModeToggleListeners = new Set<GrabModeToggleListener>()
export const grabActionShortcutListeners = new Set<GrabActionShortcutListener>()

export function emitTo<Payload>(
  listeners: Set<(payload: Payload) => void>,
  payload: Payload
): void {
  for (const listener of listeners) {
    listener(payload)
  }
}
