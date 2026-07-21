export type BrowserGuestFeatureAvailability = {
  canGrabElement: boolean
  canAnnotateElement: boolean
  canFindInPage: boolean
  canImportCookies: boolean
  elementGrabUnavailableReason: string | null
  annotationUnavailableReason: string | null
  findInPageUnavailableReason: string | null
  cookieFileImportUnavailableReason: string | null
  cookieImportUnavailableReason: string | null
}

export function getBrowserGuestFeatureAvailability(): BrowserGuestFeatureAvailability {
  if (isTauriBrowserGuestHost()) {
    // Firefox and validated JSON imports now write through the native WebView
    // cookie store; unsupported encrypted sources fail per source selection.
    return {
      canGrabElement: true,
      canAnnotateElement: true,
      canFindInPage: true,
      canImportCookies: true,
      elementGrabUnavailableReason: null,
      annotationUnavailableReason: null,
      findInPageUnavailableReason: null,
      cookieFileImportUnavailableReason: null,
      cookieImportUnavailableReason: null
    }
  }
  return {
    canGrabElement: true,
    canAnnotateElement: true,
    canFindInPage: true,
    canImportCookies: true,
    elementGrabUnavailableReason: null,
    annotationUnavailableReason: null,
    findInPageUnavailableReason: null,
    cookieFileImportUnavailableReason: null,
    cookieImportUnavailableReason: null
  }
}

function isTauriBrowserGuestHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
