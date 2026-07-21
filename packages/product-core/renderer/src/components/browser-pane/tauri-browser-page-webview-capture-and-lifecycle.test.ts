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
  awaitTauriBrowserGrabSelection,
  cancelTauriBrowserGrab,
  captureTauriBrowserSelectionScreenshot,
  ensureTauriBrowserPageWebview,
  evaluateTauriBrowserPageExpression,
  extractTauriBrowserHoverPayload,
  openTauriBrowserPageDevTools,
  setTauriBrowserAnnotationViewportBridge,
  setTauriBrowserPageDeviceEmulation,
  setTauriBrowserGrabMode
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

  it('executes remote cookie and dialog actions through native WebView commands', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'remote-state',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-remote-state' }
    const executor = register.mock.calls[0]?.[1]
    tauriCoreMocks.invoke
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce([{ name: 'session', value: '' }])
      .mockResolvedValueOnce(true)

    await expect(
      executor?.({
        id: 'cookie-set',
        kind: 'browser.cookieSet',
        payload: {
          command: 'cookieSet',
          name: 'session',
          value: '',
          url: 'https://example.test/account',
          httpOnly: true
        }
      })
    ).resolves.toEqual({ success: true })
    await expect(
      executor?.({
        id: 'cookie-get',
        kind: 'browser.cookieGet',
        payload: { command: 'cookieGet', url: 'https://example.test/account' }
      })
    ).resolves.toEqual({ cookies: [{ name: 'session', value: '' }] })
    await expect(
      executor?.({
        id: 'dialog-accept',
        kind: 'browser.dialogAccept',
        payload: { command: 'dialogAccept', text: '' }
      })
    ).resolves.toEqual({ handled: true })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_guest_cookie_set', {
      input: expect.objectContaining({
        label: 'browser-remote-state',
        name: 'session',
        value: '',
        httpOnly: true
      })
    })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_child_webview_resolve_dialog', {
      label: 'browser-remote-state',
      accept: true,
      text: ''
    })
  })

  it('executes declared storage and clipboard commands through the live guest adapter', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'page-commands',
      container,
      inputLocked: false,
      webviewPartition: 'persist:default'
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-page-commands-1' }
    const executor = register.mock.calls[0]?.[1]
    tauriCoreMocks.invoke
      .mockResolvedValueOnce(JSON.stringify({ values: { theme: 'dark' } }))
      .mockResolvedValueOnce(JSON.stringify({ copied: true, text: 'selected' }))

    await expect(
      executor?.({ id: 'storage-1', kind: 'browser.storageLocalGet', target: 'page-commands' })
    ).resolves.toEqual({ values: { theme: 'dark' } })
    await expect(
      executor?.({ id: 'clipboard-1', kind: 'browser.clipboardCopy', target: 'page-commands' })
    ).resolves.toEqual({ copied: true, text: 'selected' })
    expect(tauriCoreMocks.invoke).toHaveBeenNthCalledWith(1, 'browser_guest_evaluate', {
      input: expect.objectContaining({
        label: 'browser-page-commands-1',
        script: expect.stringContaining('storageLocalGet')
      })
    })
    expect(tauriCoreMocks.invoke).toHaveBeenNthCalledWith(2, 'browser_guest_evaluate', {
      input: expect.objectContaining({
        label: 'browser-page-commands-1',
        script: expect.stringContaining('clipboardCopy')
      })
    })
  })

  it('captures screenshot actions through the live native WebView command', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    ensureTauriBrowserPageWebview({
      browserTabId: 'page-1',
      container,
      inputLocked: false,
      webviewPartition: 'persist:default'
    })

    const webview = webviewRegistry.get('page-1') as BrowserPageWebview & {
      __pebbleTauriBrowserWebviewState?: {
        nativeWebview: { label: string } | null
      }
    }
    webview.__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-page-1-1' }
    tauriCoreMocks.invoke.mockResolvedValueOnce({ data: 'cG5n', format: 'png' })

    const executor = register.mock.calls[0]?.[1]
    await expect(
      executor?.({ id: 'action-2', kind: 'browser.screenshot', target: 'page-1' })
    ).resolves.toEqual({
      data: 'cG5n',
      format: 'png'
    })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_child_webview_screenshot', {
      input: {
        label: 'browser-page-1-1',
        format: 'png',
        crop: null,
        deviceScaleFactor: window.devicePixelRatio
      }
    })
  })

  it('captures PDF bytes through the live native WebView command', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    ensureTauriBrowserPageWebview({
      browserTabId: 'page-1',
      container,
      inputLocked: false,
      webviewPartition: 'persist:default'
    })
    const webview = webviewRegistry.get('page-1') as BrowserPageWebview & {
      __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
    }
    webview.__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-page-1-1' }
    tauriCoreMocks.invoke.mockResolvedValueOnce({ data: 'JVBERi0xLjQ=' })
    const executor = register.mock.calls[0]?.[1]
    await expect(
      executor?.({ id: 'action-pdf', kind: 'browser.pdf', target: 'page-1' })
    ).resolves.toEqual({ data: 'JVBERi0xLjQ=' })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_child_webview_pdf', {
      input: { label: 'browser-page-1-1' }
    })
  })

  it('waits for a native WebView download before completing the provider action', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    ensureTauriBrowserPageWebview({
      browserTabId: 'page-1',
      container,
      inputLocked: false,
      webviewPartition: 'persist:default'
    })
    const webview = webviewRegistry.get('page-1') as BrowserPageWebview & {
      __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
    }
    webview.__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-page-1-1' }
    tauriCoreMocks.invoke
      .mockResolvedValueOnce('download-request-1')
      .mockResolvedValueOnce(JSON.stringify({ clicked: '@e1' }))
      .mockResolvedValueOnce({ path: '/tmp/report.pdf', success: true })

    const executor = register.mock.calls[0]?.[1]
    await expect(
      executor?.({
        id: 'action-download',
        kind: 'browser.download',
        target: 'page-1',
        payload: { selector: '@e1', path: '/tmp/report.pdf' }
      })
    ).resolves.toEqual({ path: '/tmp/report.pdf' })
    expect(tauriCoreMocks.invoke).toHaveBeenNthCalledWith(
      1,
      'browser_child_webview_prepare_download',
      {
        input: { label: 'browser-page-1-1', browserTabId: 'page-1', path: '/tmp/report.pdf' }
      }
    )
    expect(tauriCoreMocks.invoke).toHaveBeenLastCalledWith('browser_child_webview_wait_download', {
      input: { requestId: 'download-request-1' }
    })
  })

  it('captures full-page screenshots as native viewport segments and restores page state', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    ensureTauriBrowserPageWebview({
      browserTabId: 'page-1',
      container,
      inputLocked: false,
      webviewPartition: 'persist:default'
    })
    const webview = webviewRegistry.get('page-1') as BrowserPageWebview & {
      __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
    }
    webview.__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-page-1-1' }
    tauriCoreMocks.invoke
      .mockResolvedValueOnce(
        JSON.stringify({
          viewportWidth: 800,
          viewportHeight: 600,
          pageHeight: 1200,
          scrollX: 0,
          scrollY: 120
        })
      )
      .mockResolvedValueOnce('true')
      .mockResolvedValueOnce(JSON.stringify({ y: 0 }))
      .mockResolvedValueOnce({ data: 'segment-zero', format: 'png' })
      .mockResolvedValueOnce('true')
      .mockResolvedValueOnce(JSON.stringify({ y: 600 }))
      .mockResolvedValueOnce({ data: 'segment-one', format: 'png' })
      .mockResolvedValueOnce('true')
      .mockResolvedValueOnce({ data: 'stitched', format: 'png' })

    const executor = register.mock.calls[0]?.[1]
    await expect(
      executor?.({
        id: 'action-full-shot',
        kind: 'browser.fullScreenshot',
        target: 'page-1',
        payload: { format: 'png' }
      })
    ).resolves.toEqual({ data: 'stitched', format: 'png' })

    expect(tauriCoreMocks.invoke).toHaveBeenLastCalledWith('browser_stitch_full_page_screenshot', {
      input: {
        format: 'png',
        viewportWidth: 800,
        pageHeight: 1200,
        segments: [
          { dataBase64: 'segment-zero', y: 0 },
          { dataBase64: 'segment-one', y: 600 }
        ]
      }
    })
    expect(
      tauriCoreMocks.invoke.mock.calls.some(
        ([, args]) =>
          typeof args === 'object' &&
          args !== null &&
          String((args as { input?: { script?: string } }).input?.script).includes(
            'window.scrollTo(0,120)'
          )
      )
    ).toBe(true)
  })

  it('captures and crops grab screenshots through the native WebView command', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    ensureTauriBrowserPageWebview({
      browserTabId: 'page-1',
      container,
      inputLocked: false,
      webviewPartition: 'persist:default'
    })
    const webview = webviewRegistry.get('page-1') as BrowserPageWebview & {
      __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
    }
    webview.__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-page-1-1' }
    tauriCoreMocks.invoke
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce({ data: 'cG5n', format: 'png' })
      .mockResolvedValueOnce('')

    await expect(
      captureTauriBrowserSelectionScreenshot({
        browserPageId: 'page-1',
        rect: { x: 12, y: 18, width: 240, height: 120 }
      })
    ).resolves.toEqual({
      ok: true,
      screenshot: {
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,cG5n',
        width: 240,
        height: 120
      }
    })
    expect(tauriCoreMocks.invoke).toHaveBeenNthCalledWith(2, 'browser_child_webview_screenshot', {
      input: {
        label: 'browser-page-1-1',
        format: 'png',
        crop: { x: 12, y: 18, width: 240, height: 120 },
        deviceScaleFactor: window.devicePixelRatio
      }
    })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledTimes(3)
  })

  it('opens native devtools for the live Tauri child WebView', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'page-1',
      container,
      inputLocked: false,
      webviewPartition: 'persist:default'
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-page-1-1' }

    await expect(openTauriBrowserPageDevTools('page-1')).resolves.toBe(true)
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith(
      'plugin:webview|internal_toggle_devtools',
      expect.objectContaining({ label: 'browser-page-1-1' })
    )
  })

  it('does not claim devtools opened before the native WebView exists', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    ensureTauriBrowserPageWebview({
      browserTabId: 'page-1',
      container,
      inputLocked: false,
      webviewPartition: 'persist:default'
    })

    await expect(openTauriBrowserPageDevTools('page-1')).resolves.toBe(false)
    expect(tauriCoreMocks.invoke).not.toHaveBeenCalled()
  })

  it('creates isolated-profile child WebViews through the Rust host boundary', async () => {
    ;(window as unknown as { api: unknown }).api = {
      keybindings: {
        get: vi.fn(async () => ({
          path: '/tmp/keybindings.json',
          platform: 'darwin' as const,
          exists: true,
          overrides: { 'browser.grabElement': ['Mod+Shift+G'] },
          commonOverrides: {},
          platformOverrides: {},
          diagnostics: []
        }))
      }
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'profile-page',
      container,
      inputLocked: false,
      webviewPartition: 'persist:pebble-browser-session-profile-1'
    })
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => ({ left: 10, top: 20, width: 800, height: 600 })
    })

    webview.src = 'https://www.nebutra.com/pebble'

    await vi.waitFor(() => {
      expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_child_webview_create', {
        input: expect.objectContaining({
          url: 'https://www.nebutra.com/pebble',
          x: 10,
          y: 20,
          width: 800,
          height: 600,
          profileKey: 'pebble-browser-session-profile-1',
          userAgent: null,
          browserTabId: 'profile-page',
          permissionProfileId: 'profile-1',
          grabShortcuts: ['Mod+Shift+G']
        })
      })
    })
    expect(tauriWebviewMocks.getByLabel).toHaveBeenCalledWith(
      expect.stringMatching(/^browser-profile-page-1$/)
    )
  })

  it('finishes loading only after the matching native child WebView event', async () => {
    tauriEventMocks.autoCompletePageLoads = false
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'load-page',
      container,
      inputLocked: false,
      webviewPartition: 'persist:default'
    })
    const domReady = vi.fn()
    webview.addEventListener('dom-ready', domReady)
    webview.src = 'https://example.com/ready'

    await vi.waitFor(() => expect(tauriEventMocks.listen).toHaveBeenCalled())
    const listener = tauriEventMocks.pageLoadListener
    listener?.({
      payload: {
        browserTabId: 'load-page',
        label: 'browser-other-page-1',
        url: 'https://example.com/ready',
        event: 'finished'
      }
    })
    expect(domReady).not.toHaveBeenCalled()

    listener?.({
      payload: {
        browserTabId: 'load-page',
        label: 'browser-load-page-1',
        url: 'https://example.com/ready',
        event: 'finished'
      }
    })
    await vi.waitFor(() => expect(domReady).toHaveBeenCalledOnce())
  })

  it('routes persisted annotation markers through the native child WebView bridge', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'annotation-page',
      container,
      inputLocked: false,
      webviewPartition: 'persist:default'
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-annotation-page-1' }
    tauriCoreMocks.invoke.mockResolvedValueOnce(true)

    await expect(
      setTauriBrowserAnnotationViewportBridge({
        browserPageId: 'annotation-page',
        enabled: true,
        emitViewport: false,
        token: 'annotationtoken1234',
        markers: [
          {
            id: 'note-1',
            index: 0,
            isFixed: false,
            rectPage: { x: 10, y: 20, width: 30, height: 40 },
            rectViewport: { x: 10, y: 20, width: 30, height: 40 }
          }
        ]
      })
    ).resolves.toBe(true)

    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_annotation_overlay_set', {
      input: expect.objectContaining({
        label: 'browser-annotation-page-1',
        enabled: true,
        markers: [expect.objectContaining({ id: 'note-1' })]
      })
    })
  })

  it('reuses the canonical guest grab runtime through the bounded native eval bridge', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'grab-page',
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
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = {
      label: 'browser-grab-page-1'
    }

    tauriCoreMocks.invoke.mockResolvedValueOnce('true')
    await expect(
      setTauriBrowserGrabMode({ browserPageId: 'grab-page', enabled: true })
    ).resolves.toEqual({ ok: true })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_guest_evaluate', {
      input: expect.objectContaining({
        label: 'browser-grab-page-1',
        timeoutMs: 5_000,
        script: expect.stringContaining('__pebbleGrab')
      })
    })

    tauriCoreMocks.invoke.mockResolvedValueOnce(JSON.stringify(createGrabPayload()))
    await expect(
      awaitTauriBrowserGrabSelection({ browserPageId: 'grab-page', opId: 'grab-1' })
    ).resolves.toMatchObject({
      opId: 'grab-1',
      kind: 'selected',
      payload: { target: { tagName: 'button', textSnippet: 'Ship it' } }
    })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_guest_evaluate', {
      input: expect.objectContaining({
        label: 'browser-grab-page-1',
        timeoutMs: 120_000,
        script: expect.stringContaining('grab.cancelAwait')
      })
    })

    tauriCoreMocks.invoke.mockResolvedValueOnce(JSON.stringify(createGrabPayload()))
    await expect(
      extractTauriBrowserHoverPayload({ browserPageId: 'grab-page' })
    ).resolves.toMatchObject({ ok: true, payload: { target: { tagName: 'button' } } })

    tauriCoreMocks.invoke.mockResolvedValueOnce('true')
    await expect(cancelTauriBrowserGrab({ browserPageId: 'grab-page' })).resolves.toBe(true)
    expect(tauriCoreMocks.invoke).toHaveBeenLastCalledWith('browser_guest_evaluate', {
      input: expect.objectContaining({
        timeoutMs: 5_000,
        script: expect.stringContaining('grab.cancelAwait')
      })
    })
  })

  it('evaluates runtime expressions with a fixed error-capturing wrapper', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'eval-page',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-eval-page-1' }
    tauriCoreMocks.invoke.mockResolvedValueOnce(
      JSON.stringify({ ok: true, result: '1280', origin: 'https://example.test' })
    )

    await expect(
      evaluateTauriBrowserPageExpression('eval-page', 'window.innerWidth')
    ).resolves.toEqual({ result: '1280', origin: 'https://example.test' })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_guest_evaluate', {
      input: expect.objectContaining({
        label: 'browser-eval-page-1',
        timeoutMs: 15_000,
        script: expect.stringContaining('await (0, eval)("window.innerWidth")')
      })
    })
  })

  it('applies document device identity and keeps it in page state for navigation replay', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    ensureTauriBrowserPageWebview({
      browserTabId: 'device-page',
      container,
      inputLocked: false,
      webviewPartition: 'persist:default'
    })
    const webview = webviewRegistry.get('device-page') as BrowserPageWebview & {
      __pebbleTauriBrowserWebviewState?: {
        nativeWebview: { label: string } | null
        deviceEmulation: unknown
      }
    }
    webview.__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-device-1' }
    tauriCoreMocks.invoke.mockResolvedValueOnce(JSON.stringify({ ok: true }))

    await expect(
      setTauriBrowserPageDeviceEmulation('device-page', {
        name: 'Pixel 7',
        width: 425,
        height: 812,
        deviceScaleFactor: 2,
        mobile: true
      })
    ).resolves.toEqual({ applied: true, scope: 'native-request-and-document-device' })

    expect(webview.__pebbleTauriBrowserWebviewState!.deviceEmulation).toMatchObject({
      name: 'Pixel 7',
      mobile: true
    })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_guest_evaluate', {
      input: expect.objectContaining({
        label: 'browser-device-1',
        script: expect.stringContaining("define(navigator, 'maxTouchPoints'"),
        timeoutMs: 5000
      })
    })
    const script = String(
      (tauriCoreMocks.invoke.mock.calls.at(-1)?.[1] as { input?: { script?: string } })?.input
        ?.script
    )
    expect(script).toContain('Pixel 7')
    expect(script).toContain('(pointer:coarse)')
    expect(script).toContain("replace(/\\s+/g, '')")
    expect(script).toContain('Android 13')
  })

})

function createGrabPayload(): Record<string, unknown> {
  return {
    page: {
      sanitizedUrl: 'https://example.test/page?secret=removed',
      title: 'Example',
      viewportWidth: 1280,
      viewportHeight: 720,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 2,
      capturedAt: '2026-07-10T00:00:00.000Z'
    },
    target: {
      tagName: 'button',
      selector: '#ship',
      textSnippet: 'Ship it',
      htmlSnippet: '<button id="ship">Ship it</button>',
      attributes: { id: 'ship' },
      accessibility: { role: 'button', accessibleName: 'Ship it' },
      rectViewport: { x: 10, y: 20, width: 100, height: 32 },
      rectPage: { x: 10, y: 20, width: 100, height: 32 },
      computedStyles: {}
    },
    nearbyText: [],
    ancestorPath: [],
    screenshot: null
  }
}
