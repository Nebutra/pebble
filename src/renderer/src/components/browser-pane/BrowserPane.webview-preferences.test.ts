// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PEBBLE_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'

const registryMocks = vi.hoisted(() => ({
  destroyPersistentWebview: vi.fn(),
  registerPersistentWebview: vi.fn(),
  webviewRegistry: new Map<string, Electron.WebviewTag>()
}))

const tauriMocks = vi.hoisted(() => {
  const instances: Array<{
    label: string
    options: Record<string, unknown>
    close: ReturnType<typeof vi.fn>
    setZoom: ReturnType<typeof vi.fn>
    show: ReturnType<typeof vi.fn>
    hide: ReturnType<typeof vi.fn>
    setPosition: ReturnType<typeof vi.fn>
    setSize: ReturnType<typeof vi.fn>
    setFocus: ReturnType<typeof vi.fn>
    once: ReturnType<typeof vi.fn>
  }> = []
  const Webview = vi.fn(function Webview(
    this: (typeof instances)[number],
    _window: unknown,
    label: string,
    options: Record<string, unknown>
  ) {
    this.label = label
    this.options = options
    this.close = vi.fn(() => Promise.resolve())
    this.setZoom = vi.fn(() => Promise.resolve())
    this.show = vi.fn(() => Promise.resolve())
    this.hide = vi.fn(() => Promise.resolve())
    this.setPosition = vi.fn(() => Promise.resolve())
    this.setSize = vi.fn(() => Promise.resolve())
    this.setFocus = vi.fn(() => Promise.resolve())
    this.once = vi.fn((event: string, callback: (payload: unknown) => void) => {
      if (event === 'tauri://created') {
        window.setTimeout(() => callback({ payload: null }), 0)
      }
      return Promise.resolve(() => {})
    })
    instances.push(this)
  })
  return {
    Webview,
    getCurrentWindow: vi.fn(() => ({ label: 'main' })),
    instances
  }
})

vi.mock('./webview-registry', () => ({
  destroyPersistentWebview: registryMocks.destroyPersistentWebview,
  registerPersistentWebview: registryMocks.registerPersistentWebview,
  webviewRegistry: registryMocks.webviewRegistry
}))

vi.mock('@tauri-apps/api/webview', () => ({
  Webview: tauriMocks.Webview
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: tauriMocks.getCurrentWindow
}))

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalPosition: class LogicalPosition {
    constructor(
      public x: number,
      public y: number
    ) {}
  },
  LogicalSize: class LogicalSize {
    constructor(
      public width: number,
      public height: number
    ) {}
  }
}))

import { ensureBrowserPageWebview } from './browser-page-webview'

function createContainer(id: string): HTMLDivElement {
  const container = document.createElement('div')
  container.dataset.testid = id
  document.body.appendChild(container)
  return container
}

describe('BrowserPane webview preferences', () => {
  beforeEach(() => {
    registryMocks.destroyPersistentWebview.mockReset()
    registryMocks.registerPersistentWebview.mockReset()
    registryMocks.registerPersistentWebview.mockImplementation((id, webview) => {
      registryMocks.webviewRegistry.set(id, webview)
    })
    registryMocks.webviewRegistry.clear()
    tauriMocks.Webview.mockClear()
    tauriMocks.getCurrentWindow.mockClear()
    tauriMocks.instances.length = 0
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    document.body.innerHTML = ''
  })

  it('creates a webview with the resolved partition and shared guest webpreferences', () => {
    const container = createContainer('initial')

    const ensuredWebview = ensureBrowserPageWebview({
      browserTabId: 'browser-page-1',
      container,
      inputLocked: false,
      webviewPartition: 'persist:pebble-browser-session-profile-1',
      resolveContainer: () => container
    })

    expect(ensuredWebview).not.toBeNull()
    expect(ensuredWebview?.created).toBe(true)
    expect(ensuredWebview?.container).toBe(container)
    expect(ensuredWebview?.webview.getAttribute('partition')).toBe(
      'persist:pebble-browser-session-profile-1'
    )
    expect(ensuredWebview?.webview.getAttribute('webpreferences')).toBe(
      PEBBLE_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE
    )
    expect(registryMocks.registerPersistentWebview).toHaveBeenCalledWith(
      'browser-page-1',
      ensuredWebview?.webview
    )
    expect(container.lastElementChild).toBe(ensuredWebview?.webview as unknown as Element)
  })

  it('remounts the webview in a refreshed container when the stored resolved partition changes', () => {
    const staleContainer = createContainer('stale')
    const staleWebview = document.createElement('webview') as Electron.WebviewTag
    staleWebview.setAttribute('partition', 'persist:pebble-browser')
    staleContainer.appendChild(staleWebview)
    registryMocks.webviewRegistry.set('browser-page-1', staleWebview)

    const refreshedContainer = document.createElement('div')
    refreshedContainer.dataset.testid = 'refreshed'
    const resolveContainer = vi.fn(() => {
      if (!refreshedContainer.isConnected) {
        document.body.appendChild(refreshedContainer)
      }
      return refreshedContainer
    })
    registryMocks.destroyPersistentWebview.mockImplementation(() => {
      staleWebview.remove()
      staleContainer.remove()
      registryMocks.webviewRegistry.delete('browser-page-1')
    })

    const ensuredWebview = ensureBrowserPageWebview({
      browserTabId: 'browser-page-1',
      container: staleContainer,
      inputLocked: true,
      webviewPartition: 'persist:pebble-browser-session-profile-1',
      resolveContainer
    })

    expect(registryMocks.destroyPersistentWebview).toHaveBeenCalledWith('browser-page-1')
    expect(resolveContainer).toHaveBeenCalledTimes(1)
    expect(ensuredWebview).not.toBeNull()
    expect(ensuredWebview?.created).toBe(true)
    expect(ensuredWebview?.container).toBe(refreshedContainer)
    expect(ensuredWebview?.webview).not.toBe(staleWebview)
    expect(ensuredWebview?.webview.getAttribute('partition')).toBe(
      'persist:pebble-browser-session-profile-1'
    )
    expect(ensuredWebview?.webview.style.pointerEvents).toBe('none')
    expect(refreshedContainer.lastElementChild).toBe(ensuredWebview?.webview as unknown as Element)
  })

  it('creates a Tauri child Webview shim instead of an Electron webview in Tauri', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
    ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    const container = createContainer('tauri')
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        width: 800,
        height: 600,
        right: 810,
        bottom: 620,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const ensuredWebview = ensureBrowserPageWebview({
      browserTabId: 'browser-page-1',
      container,
      inputLocked: false,
      webviewPartition: 'persist:pebble-browser-session-profile-1',
      resolveContainer: () => container
    })
    const webview = ensuredWebview?.webview
    const domReady = vi.fn()
    const didNavigate = vi.fn()
    webview?.addEventListener('dom-ready', domReady)
    webview?.addEventListener('did-navigate', didNavigate)

    webview!.src = 'https://example.com/docs'

    await vi.waitFor(() => expect(tauriMocks.Webview).toHaveBeenCalledTimes(1))
    expect(webview?.tagName).toBe('DIV')
    expect(webview?.getAttribute('partition')).toBe('persist:pebble-browser-session-profile-1')
    expect(tauriMocks.Webview.mock.calls[0][2]).toMatchObject({
      url: 'https://example.com/docs',
      x: 10,
      y: 20,
      width: 800,
      height: 600
    })
    await vi.waitFor(() => expect(domReady).toHaveBeenCalledTimes(1))
    expect(didNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/docs', isMainFrame: true })
    )
    expect(webview?.getURL()).toBe('https://example.com/docs')
    expect(webview?.getTitle()).toBe('example.com')
  })
})
