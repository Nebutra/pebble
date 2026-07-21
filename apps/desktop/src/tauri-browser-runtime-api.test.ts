import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  awaitTauriBrowserGrabSelectionMock,
  cancelTauriBrowserGrabMock,
  captureTauriBrowserSelectionScreenshotMock,
  clearTauriBrowserDefaultCookiesMock,
  ensureTauriBrowserActionConsumerMock,
  ensureTauriBrowserProviderRefreshMock,
  ensureTauriBrowserRuntimeEventPumpMock,
  extractTauriBrowserHoverPayloadMock,
  importTauriBrowserCookiesFromFileMock,
  importTauriBrowserCookiesFromBrowserMock,
  installTauriBrowserActionExecutorBridgeMock,
  installTauriBrowserPermissionOverrideBridgeMock,
  openTauriBrowserPageDevToolsMock,
  registerTauriBrowserActionExecutorMock,
  setTauriBrowserAnnotationViewportBridgeMock,
  setTauriBrowserGrabModeMock
} = vi.hoisted(() => ({
  ensureTauriBrowserActionConsumerMock: vi.fn(),
  ensureTauriBrowserProviderRefreshMock: vi.fn(),
  ensureTauriBrowserRuntimeEventPumpMock: vi.fn(),
  clearTauriBrowserDefaultCookiesMock: vi.fn(),
  awaitTauriBrowserGrabSelectionMock: vi.fn(),
  cancelTauriBrowserGrabMock: vi.fn(),
  captureTauriBrowserSelectionScreenshotMock: vi.fn(),
  extractTauriBrowserHoverPayloadMock: vi.fn(),
  importTauriBrowserCookiesFromFileMock: vi.fn(),
  importTauriBrowserCookiesFromBrowserMock: vi.fn(),
  installTauriBrowserActionExecutorBridgeMock: vi.fn(() => {
    window.__pebbleTauriBrowserActionExecutors = {
      register: registerTauriBrowserActionExecutorMock
    }
  }),
  installTauriBrowserPermissionOverrideBridgeMock: vi.fn(),
  openTauriBrowserPageDevToolsMock: vi.fn(),
  registerTauriBrowserActionExecutorMock: vi.fn(),
  setTauriBrowserAnnotationViewportBridgeMock: vi.fn(),
  setTauriBrowserGrabModeMock: vi.fn()
}))

vi.mock('./tauri-browser-action-consumer', () => ({
  ensureTauriBrowserActionConsumer: ensureTauriBrowserActionConsumerMock,
  installTauriBrowserActionExecutorBridge: installTauriBrowserActionExecutorBridgeMock,
  registerTauriBrowserActionExecutor: registerTauriBrowserActionExecutorMock
}))

vi.mock('./tauri-browser-runtime-events', () => ({
  ensureTauriBrowserRuntimeEventPump: ensureTauriBrowserRuntimeEventPumpMock,
  notifyTauriBrowserActiveTab: vi.fn(),
  onTauriBrowserActivateView: vi.fn(),
  onTauriBrowserDownloadFinished: vi.fn(),
  onTauriBrowserDownloadProgress: vi.fn(),
  onTauriBrowserDownloadRequested: vi.fn(),
  onTauriBrowserGuestLoadFailed: vi.fn(),
  onTauriBrowserGrabActionShortcut: vi.fn(),
  onTauriBrowserGrabModeToggle: vi.fn(),
  onTauriBrowserPermissionDenied: vi.fn(),
  onTauriBrowserContextMenuDismissed: vi.fn(),
  onTauriBrowserContextMenuRequested: vi.fn(),
  onTauriBrowserNavigationUpdate: vi.fn(),
  onTauriBrowserOpenLink: vi.fn(),
  onTauriBrowserPaneFocus: vi.fn(),
  onTauriBrowserPopup: vi.fn(),
  registerTauriBrowserGuest: vi.fn(),
  unregisterTauriBrowserGuest: vi.fn()
}))

vi.mock('./tauri-browser-runtime-profiles', () => ({
  cancelTauriBrowserDownload: vi.fn(),
  createTauriBrowserSessionProfile: vi.fn(),
  deleteTauriBrowserSessionProfile: vi.fn(),
  detectTauriBrowserSessionBrowsers: vi.fn(),
  ensureTauriBrowserProviderRefresh: ensureTauriBrowserProviderRefreshMock,
  listTauriBrowserSessionProfiles: vi.fn(),
  resolveTauriBrowserSessionPartition: vi.fn(),
  TAURI_BROWSER_GUEST_UNAVAILABLE: 'Tauri browser guest unavailable.'
}))

vi.mock('./tauri-browser-permission-overrides', () => ({
  installTauriBrowserPermissionOverrideBridge: installTauriBrowserPermissionOverrideBridgeMock
}))

vi.mock('./tauri-browser-viewport-state', () => ({
  setTauriBrowserViewportOverride: vi.fn()
}))

vi.mock('@/components/browser-pane/tauri-browser-page-webview', () => ({
  awaitTauriBrowserGrabSelection: awaitTauriBrowserGrabSelectionMock,
  cancelTauriBrowserGrab: cancelTauriBrowserGrabMock,
  captureTauriBrowserSelectionScreenshot: captureTauriBrowserSelectionScreenshotMock,
  clearTauriBrowserDefaultCookies: clearTauriBrowserDefaultCookiesMock,
  extractTauriBrowserHoverPayload: extractTauriBrowserHoverPayloadMock,
  importTauriBrowserCookiesFromFile: importTauriBrowserCookiesFromFileMock,
  importTauriBrowserCookiesFromBrowser: importTauriBrowserCookiesFromBrowserMock,
  openTauriBrowserPageDevTools: openTauriBrowserPageDevToolsMock,
  setTauriBrowserAnnotationViewportBridge: setTauriBrowserAnnotationViewportBridgeMock,
  setTauriBrowserGrabMode: setTauriBrowserGrabModeMock
}))

import { installTauriBrowserRuntimeApi } from './tauri-browser-runtime-api'

describe('installTauriBrowserRuntimeApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.window = {
      __TAURI_INTERNALS__: {},
      api: {
        browser: {}
      }
    } as unknown as Window & typeof globalThis
  })

  it('exposes the WebView action executor bridge and starts the browser action consumer', () => {
    installTauriBrowserRuntimeApi()

    expect(window.__pebbleTauriBrowserActionExecutors?.register).toBe(
      registerTauriBrowserActionExecutorMock
    )
    expect(installTauriBrowserActionExecutorBridgeMock).toHaveBeenCalled()
    expect(installTauriBrowserPermissionOverrideBridgeMock).toHaveBeenCalled()
    expect(ensureTauriBrowserRuntimeEventPumpMock).toHaveBeenCalled()
    expect(ensureTauriBrowserProviderRefreshMock).toHaveBeenCalled()
    expect(ensureTauriBrowserActionConsumerMock).toHaveBeenCalled()
    expect(window.api.browser.setGrabMode).toBe(setTauriBrowserGrabModeMock)
    expect(window.api.browser.captureSelectionScreenshot).toBe(
      captureTauriBrowserSelectionScreenshotMock
    )
    expect(window.api.browser.awaitGrabSelection).toBe(awaitTauriBrowserGrabSelectionMock)
    expect(window.api.browser.cancelGrab).toBe(cancelTauriBrowserGrabMock)
    expect(window.api.browser.extractHoverPayload).toBe(extractTauriBrowserHoverPayloadMock)
  })

  it('routes browser devtools requests to the live Tauri child WebView', async () => {
    openTauriBrowserPageDevToolsMock.mockResolvedValue(true)

    installTauriBrowserRuntimeApi()

    await expect(
      window.api.browser.openDevTools({ browserPageId: 'browser-page-1' })
    ).resolves.toBe(true)
    expect(openTauriBrowserPageDevToolsMock).toHaveBeenCalledWith('browser-page-1')
  })

  it('routes default cookie clearing to the live Tauri child WebView data clearer', async () => {
    clearTauriBrowserDefaultCookiesMock.mockResolvedValue(true)

    installTauriBrowserRuntimeApi()

    await expect(window.api.browser.sessionClearDefaultCookies()).resolves.toBe(true)
    expect(clearTauriBrowserDefaultCookiesMock).toHaveBeenCalled()
  })

  it('routes manual cookie files to the native WebView cookie importer', async () => {
    importTauriBrowserCookiesFromFileMock.mockResolvedValue({
      ok: true,
      profileId: 'default',
      summary: { totalCookies: 2, importedCookies: 2, skippedCookies: 0, domains: ['example.com'] }
    })
    installTauriBrowserRuntimeApi()

    await expect(
      window.api.browser.sessionImportCookies({ profileId: 'default' })
    ).resolves.toMatchObject({
      ok: true,
      profileId: 'default'
    })
    expect(importTauriBrowserCookiesFromFileMock).toHaveBeenCalledWith({ profileId: 'default' })
  })

  it('routes installed Firefox profiles to the native source importer', async () => {
    importTauriBrowserCookiesFromBrowserMock.mockResolvedValue({
      ok: true,
      profileId: 'default',
      summary: { totalCookies: 2, importedCookies: 2, skippedCookies: 0, domains: ['example.com'] }
    })
    installTauriBrowserRuntimeApi()
    const args = {
      profileId: 'default',
      browserFamily: 'firefox',
      browserProfile: 'abc.default-release'
    }

    await expect(window.api.browser.sessionImportFromBrowser(args)).resolves.toMatchObject({
      ok: true,
      profileId: 'default'
    })
    expect(importTauriBrowserCookiesFromBrowserMock).toHaveBeenCalledWith(args)
  })

  it('routes installed Chromium profiles to the native source importer', async () => {
    importTauriBrowserCookiesFromBrowserMock.mockResolvedValue({
      ok: true,
      profileId: 'default',
      summary: { totalCookies: 3, importedCookies: 3, skippedCookies: 0, domains: ['github.com'] }
    })
    installTauriBrowserRuntimeApi()
    const args = {
      profileId: 'default',
      browserFamily: 'chrome',
      browserProfile: 'Profile 1'
    }

    await expect(window.api.browser.sessionImportFromBrowser(args)).resolves.toMatchObject({
      ok: true,
      profileId: 'default'
    })
    expect(importTauriBrowserCookiesFromBrowserMock).toHaveBeenCalledWith(args)
  })

  it('routes persisted annotations to the native child WebView overlay bridge', async () => {
    setTauriBrowserAnnotationViewportBridgeMock.mockResolvedValue(true)
    installTauriBrowserRuntimeApi()
    const args = {
      browserPageId: 'browser-page-1',
      enabled: true,
      emitViewport: false,
      token: 'annotationtoken1234',
      markers: []
    }

    await expect(window.api.browser.setAnnotationViewportBridge(args)).resolves.toBe(true)
    expect(setTauriBrowserAnnotationViewportBridgeMock).toHaveBeenCalledWith(args)
  })
})
