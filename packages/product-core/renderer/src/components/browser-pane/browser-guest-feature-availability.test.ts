// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { getBrowserGuestFeatureAvailability } from './browser-guest-feature-availability'

type TauriFeatureTestWindow = Window & {
  __TAURI_INTERNALS__?: unknown
}

describe('browser guest feature availability', () => {
  afterEach(() => {
    delete (window as TauriFeatureTestWindow).__TAURI_INTERNALS__
  })

  it('keeps Electron browser grab and annotation surfaces enabled', () => {
    expect(getBrowserGuestFeatureAvailability()).toEqual({
      canGrabElement: true,
      canAnnotateElement: true,
      canFindInPage: true,
      canImportCookies: true,
      elementGrabUnavailableReason: null,
      annotationUnavailableReason: null,
      findInPageUnavailableReason: null,
      cookieFileImportUnavailableReason: null,
      cookieImportUnavailableReason: null
    })
  })

  it('enables native Tauri grab, annotation, find, and supported cookie imports', () => {
    ;(window as TauriFeatureTestWindow).__TAURI_INTERNALS__ = {}

    expect(getBrowserGuestFeatureAvailability()).toEqual({
      canGrabElement: true,
      canAnnotateElement: true,
      canFindInPage: true,
      canImportCookies: true,
      elementGrabUnavailableReason: null,
      annotationUnavailableReason: null,
      findInPageUnavailableReason: null,
      cookieFileImportUnavailableReason: null,
      cookieImportUnavailableReason: null
    })
  })
})
