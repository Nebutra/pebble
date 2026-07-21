// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PEBBLE_BROWSER_PARTITION } from '../../../../shared/constants'
import type { BrowserPageWebview } from '../../../../shared/browser-page-webview-types'
import type { TauriBrowserPermissionWindow } from './tauri-browser-permission-profile'

const tauriCoreMocks = vi.hoisted(() => ({
  invoke: vi.fn()
}))

const tauriWebviewMocks = vi.hoisted(() => ({
  getByLabel: vi.fn()
}))

const tauriEventMocks = vi.hoisted(() => ({
  autoCompletePageLoads: true,
  listen: vi.fn(),
  pageLoadListener: null as ((event: { payload: Record<string, unknown> }) => void) | null
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriCoreMocks.invoke
}))

vi.mock('@tauri-apps/api/webview', () => ({
  Webview: { getByLabel: tauriWebviewMocks.getByLabel }
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriEventMocks.listen
}))

function installTauriInvokeHost(): void {
  tauriCoreMocks.invoke.mockImplementation(async (command, payload) => {
    if (command === 'browser_child_webview_create' && tauriEventMocks.autoCompletePageLoads) {
      const input = (payload as { input: Record<string, unknown> }).input
      queueMicrotask(() =>
        tauriEventMocks.pageLoadListener?.({
          payload: {
            browserTabId: input.browserTabId,
            label: input.label,
            url: input.url,
            event: 'finished'
          }
        })
      )
    }
    return undefined
  })
}

import {
  clearTauriBrowserDefaultCookies,
  clearTauriBrowserPageCookies,
  ensureTauriBrowserPageWebview,
  importTauriBrowserCookiesFromFile,
  importTauriBrowserCookiesFromBrowser,
  setTauriBrowserPageHeaders,
  setTauriBrowserCookie,
  setTauriBrowserPageOffline,
  setTauriBrowserPageCredentials,
  setTauriBrowserPageDeviceEmulation,
} from './tauri-browser-page-webview'
import { webviewRegistry } from './webview-registry'

class TestResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}

type RuntimeComputerAction = {
  id: string
  kind: string
  target?: string
  payload?: Record<string, unknown>
}

describe('ensureTauriBrowserPageWebview', () => {
  const unregister = vi.fn()
  const register = vi.fn(
    (
      _tabId: string,
      _executor: (action: RuntimeComputerAction) => Promise<Record<string, unknown> | void>
    ) => unregister
  )

  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    window.__pebbleTauriBrowserActionExecutors = { register }
    tauriEventMocks.autoCompletePageLoads = true
    tauriEventMocks.pageLoadListener = null
    tauriEventMocks.listen.mockImplementation(async (_event, listener) => {
      tauriEventMocks.pageLoadListener = listener
      return vi.fn()
    })
    installTauriInvokeHost()
    tauriWebviewMocks.getByLabel.mockResolvedValue({
      label: 'browser-page-1',
      close: vi.fn(() => Promise.resolve()),
      setPosition: vi.fn(() => Promise.resolve()),
      setSize: vi.fn(() => Promise.resolve()),
      setZoom: vi.fn(() => Promise.resolve())
    })
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    webviewRegistry.clear()
    delete (window as Window & { __pebbleTauriBrowserActionExecutors?: unknown })
      .__pebbleTauriBrowserActionExecutors
    delete (window as TauriBrowserPermissionWindow).__pebbleTauriBrowserPermissionOverrides
    delete (window as unknown as { api?: unknown }).api
  })

  it('recreates an active child WebView with the native request user agent', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    ensureTauriBrowserPageWebview({
      browserTabId: 'native-ua-page',
      container,
      inputLocked: false,
      webviewPartition: 'persist:default'
    })
    const webview = webviewRegistry.get('native-ua-page') as BrowserPageWebview & {
      __pebbleTauriBrowserWebviewState?: {
        currentUrl: string
        nativeWebview: { label: string; close: () => Promise<void> } | null
      }
    }
    webview.__pebbleTauriBrowserWebviewState!.currentUrl = 'https://example.com/device'
    webview.__pebbleTauriBrowserWebviewState!.nativeWebview = {
      label: 'browser-old',
      close: vi.fn(async () => undefined)
    }
    tauriCoreMocks.invoke.mockResolvedValueOnce({ label: 'browser-new', isolatedProfile: false })

    await setTauriBrowserPageDeviceEmulation('native-ua-page', {
      name: 'iPhone 13',
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      mobile: true
    })

    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_child_webview_create', {
      input: expect.objectContaining({
        url: 'https://example.com/device',
        userAgent: expect.stringContaining('iPhone OS 17_0')
      })
    })
  })

  it('updates bounded fetch/XHR headers without persisting credentials in runtime actions', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'headers-page',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-headers-page-1' }
    tauriCoreMocks.invoke.mockResolvedValueOnce(
      JSON.stringify({ ok: true, applied: 2, scope: 'fetch-xhr' })
    )

    await expect(
      setTauriBrowserPageHeaders(
        'headers-page',
        JSON.stringify({ Authorization: 'Bearer test', 'X-Pebble': 'yes' })
      )
    ).resolves.toEqual({ applied: 2, scope: 'fetch-xhr' })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_guest_evaluate', {
      input: expect.objectContaining({
        label: 'browser-headers-page-1',
        timeoutMs: 5_000,
        script: expect.stringContaining('capture.extraHeaders')
      })
    })
    await expect(
      setTauriBrowserPageHeaders('headers-page', '{"Bad Header":"value"}')
    ).rejects.toThrow('header names and values are invalid')
    await expect(
      setTauriBrowserPageHeaders('headers-page', '{"X-Test":"line\\nbreak"}')
    ).rejects.toThrow('header names and values are invalid')
  })

  it('sets and toggles document fetch/XHR offline state', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'offline-page',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-offline-page-1' }
    tauriCoreMocks.invoke
      .mockResolvedValueOnce(JSON.stringify({ ok: true, offline: true, scope: 'fetch-xhr' }))
      .mockResolvedValueOnce(JSON.stringify({ ok: true, offline: false, scope: 'fetch-xhr' }))

    await expect(setTauriBrowserPageOffline('offline-page', 'on')).resolves.toEqual({
      offline: true,
      scope: 'fetch-xhr'
    })
    await expect(setTauriBrowserPageOffline('offline-page')).resolves.toEqual({
      offline: false,
      scope: 'fetch-xhr'
    })
    expect(tauriCoreMocks.invoke.mock.calls[0]?.[1]).toMatchObject({
      input: { script: expect.stringContaining('capture.offline = true') }
    })
    expect(tauriCoreMocks.invoke.mock.calls[1]?.[1]).toMatchObject({
      input: { script: expect.stringContaining('capture.offline = !capture.offline') }
    })
    await expect(setTauriBrowserPageOffline('offline-page', 'sometimes')).rejects.toThrow(
      'must be on or off'
    )
  })

  it('stores bounded Basic credentials in guest memory with UTF-8 encoding', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'credentials-page',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = {
      label: 'browser-credentials-page-1'
    }
    tauriCoreMocks.invoke
      .mockResolvedValueOnce({ configured: true, scope: 'native-http-basic' })
      .mockResolvedValueOnce(
        JSON.stringify({ ok: true, configured: true, scope: 'fetch-xhr-basic' })
      )

    await expect(
      setTauriBrowserPageCredentials('credentials-page', '用户', 'päss')
    ).resolves.toEqual({ configured: true, scope: 'native-http-basic' })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_child_webview_set_http_auth', {
      input: {
        label: 'browser-credentials-page-1',
        user: '用户',
        password: 'päss'
      }
    })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_guest_evaluate', {
      input: expect.objectContaining({
        script: expect.stringContaining('capture.authorization = "Basic ')
      })
    })
    await expect(
      setTauriBrowserPageCredentials('credentials-page', 'bad\nuser', 'pass')
    ).rejects.toThrow('credentials are invalid')
    await expect(
      setTauriBrowserPageCredentials('credentials-page', 'user', 'bad\rpass')
    ).rejects.toThrow('credentials are invalid')
  })

  it('bridges compatibility find calls to the native Tauri child WebView', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'find-page',
      container,
      inputLocked: false,
      webviewPartition: 'persist:default'
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-find-page-1' }
    const onFound = vi.fn()
    webview.addEventListener('found-in-page', onFound)
    tauriCoreMocks.invoke.mockResolvedValueOnce({
      activeMatchOrdinal: 2,
      matches: 3,
      finalUpdate: true
    })

    const requestId = (webview as unknown as { findInPage: (query: string) => number }).findInPage(
      'Pebble'
    )
    expect(requestId).toBe(1)
    await vi.waitFor(() => {
      expect(onFound).toHaveBeenCalled()
    })

    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_guest_find', {
      input: {
        label: 'browser-find-page-1',
        query: 'Pebble',
        forward: true,
        findNext: false
      }
    })
    expect(onFound.mock.calls[0]?.[0]).toMatchObject({
      result: { activeMatchOrdinal: 2, matches: 3, finalUpdate: true }
    })

    ;(webview as unknown as { stopFindInPage: () => void }).stopFindInPage()
    await vi.waitFor(() => {
      expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_guest_stop_find', {
        input: { label: 'browser-find-page-1' }
      })
    })
  })

  it('clears only cookies for live default-partition Tauri child WebViews', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'default-page',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: {
          nativeWebview: { label: string } | null
        }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-default-page-1' }
    tauriCoreMocks.invoke.mockResolvedValueOnce(3)

    await expect(clearTauriBrowserDefaultCookies()).resolves.toBe(true)
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_guest_clear_cookies', {
      input: { label: 'browser-default-page-1' }
    })
  })

  it('sets URL-scoped cookie metadata and clears the targeted native store', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'cookie-page',
      container,
      inputLocked: false,
      webviewPartition: 'persist:profile-1'
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-cookie-page-1' }
    tauriCoreMocks.invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(2)

    await expect(
      setTauriBrowserCookie('cookie-page', {
        name: 'session',
        value: 'token',
        url: 'https://example.com/account/profile',
        httpOnly: true
      })
    ).resolves.toEqual({ success: true })
    expect(tauriCoreMocks.invoke).toHaveBeenNthCalledWith(1, 'browser_guest_cookie_set', {
      input: {
        label: 'browser-cookie-page-1',
        name: 'session',
        value: 'token',
        domain: 'example.com',
        path: '/account/profile',
        secure: true,
        httpOnly: true
      }
    })
    await expect(clearTauriBrowserPageCookies('cookie-page')).resolves.toEqual({ cleared: true })
    expect(tauriCoreMocks.invoke).toHaveBeenNthCalledWith(2, 'browser_guest_clear_cookies', {
      input: { label: 'browser-cookie-page-1' }
    })
  })

  it('imports a cookie file into a live matching Tauri profile WebView', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'cookie-import-page',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-cookie-import-1' }
    tauriCoreMocks.invoke.mockResolvedValueOnce({
      ok: true,
      profileId: 'default',
      summary: { totalCookies: 2, importedCookies: 1, skippedCookies: 1, domains: ['example.com'] }
    })

    await expect(
      importTauriBrowserCookiesFromFile({ profileId: 'default' })
    ).resolves.toMatchObject({
      ok: true,
      summary: { importedCookies: 1, domains: ['example.com'] }
    })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_guest_import_cookie_file', {
      input: { label: 'browser-cookie-import-1', profileId: 'default' }
    })
  })

  it('imports an installed Firefox profile into the matching native cookie store', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'firefox-import-page',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-firefox-import-1' }
    tauriCoreMocks.invoke.mockResolvedValueOnce({
      ok: true,
      profileId: 'default',
      summary: { totalCookies: 4, importedCookies: 4, skippedCookies: 0, domains: ['example.com'] }
    })

    await expect(
      importTauriBrowserCookiesFromBrowser({
        profileId: 'default',
        browserFamily: 'firefox',
        browserProfile: 'abc.default-release'
      })
    ).resolves.toMatchObject({ ok: true, summary: { importedCookies: 4 } })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_guest_import_from_browser', {
      input: {
        label: 'browser-firefox-import-1',
        profileId: 'default',
        browserFamily: 'firefox',
        browserProfile: 'abc.default-release'
      }
    })
  })

  it('clears a shared default cookie store through one live child WebView', async () => {
    for (const browserTabId of ['default-one', 'default-two']) {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const { webview } = ensureTauriBrowserPageWebview({
        browserTabId,
        container,
        inputLocked: false,
        webviewPartition: PEBBLE_BROWSER_PARTITION
      })
      ;(
        webview as typeof webview & {
          __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
        }
      ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: `browser-${browserTabId}-1` }
    }
    tauriCoreMocks.invoke.mockResolvedValueOnce(2)

    await expect(clearTauriBrowserDefaultCookies()).resolves.toBe(true)
    expect(tauriCoreMocks.invoke).toHaveBeenCalledTimes(1)
  })

  it('does not clear isolated-profile child WebView cookies from the default action', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'isolated-page',
      container,
      inputLocked: false,
      webviewPartition: 'persist:pebble-browser-session-profile-1'
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: {
          nativeWebview: { label: string } | null
        }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-isolated-page-1' }

    await expect(clearTauriBrowserDefaultCookies()).resolves.toBe(false)
    expect(tauriCoreMocks.invoke).not.toHaveBeenCalledWith(
      'browser_guest_clear_cookies',
      expect.anything()
    )
  })
})
