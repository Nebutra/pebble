// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PEBBLE_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'
import type { BrowserPageWebview } from '../../../../shared/browser-page-webview-types'

const registryMocks = vi.hoisted(() => ({
  destroyPersistentWebview: vi.fn(),
  registerPersistentWebview: vi.fn(),
  webviewRegistry: new Map<string, BrowserPageWebview>()
}))

const tauriApiMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  pageLoadListeners: [] as ((event: { payload: Record<string, unknown> }) => void)[]
}))

const tauriMocks = vi.hoisted(() => {
  const instances: {
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
  }[] = []
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
  const getByLabel = vi.fn(async (label: string) => {
    const instance = Object.create(Webview.prototype) as (typeof instances)[number]
    Webview.call(instance, null, label, {})
    return instance
  })
  Object.assign(Webview, { getByLabel })
  return {
    Webview,
    getByLabel,
    getCurrentWindow: vi.fn(() => ({ label: 'main' })),
    instances
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriApiMocks.invoke
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriApiMocks.listen
}))

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

type RuntimeComputerAction = {
  id: string
  kind: string
  target?: string
  payload?: Record<string, unknown>
}

type TauriBrowserTestWindow = Window & {
  __TAURI_INTERNALS__?: unknown
  __pebbleTauriBrowserActionExecutors?: {
    register: (
      browserPageId: string,
      executor: (action: RuntimeComputerAction) => Promise<Record<string, unknown> | void>
    ) => () => void
  }
}

function createContainer(id: string): HTMLDivElement {
  const container = document.createElement('div')
  container.dataset.testid = id
  document.body.appendChild(container)
  return container
}

function installTauriRendererTestGlobals(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.stubGlobal(
    'MutationObserver',
    class MutationObserver {
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  ;(window as TauriBrowserTestWindow).__TAURI_INTERNALS__ = {}
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
    tauriMocks.getByLabel.mockClear()
    tauriApiMocks.pageLoadListeners.length = 0
    tauriApiMocks.listen.mockReset()
    tauriApiMocks.listen.mockImplementation((_event, listener) => {
      tauriApiMocks.pageLoadListeners.push(listener)
      return Promise.resolve(vi.fn())
    })
    tauriApiMocks.invoke.mockReset()
    tauriApiMocks.invoke.mockImplementation((method, args) => {
      if (method === 'browser_child_webview_create') {
        const input = (args as { input: { browserTabId: string; label: string } }).input
        window.setTimeout(() => {
          for (const listener of tauriApiMocks.pageLoadListeners) {
            listener({
              payload: {
                browserTabId: input.browserTabId,
                event: 'finished',
                label: input.label
              }
            })
          }
        }, 0)
      }
      return Promise.resolve(null)
    })
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as TauriBrowserTestWindow).__TAURI_INTERNALS__
    delete (window as TauriBrowserTestWindow).__pebbleTauriBrowserActionExecutors
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
    const staleWebview = document.createElement('webview') as BrowserPageWebview
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
    installTauriRendererTestGlobals()
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
    expect(tauriApiMocks.invoke).toHaveBeenCalledWith(
      'browser_child_webview_create',
      expect.objectContaining({
        input: expect.objectContaining({
          url: 'https://example.com/docs',
          x: 10,
          y: 20,
          width: 800,
          height: 600
        })
      })
    )
    expect(tauriApiMocks.listen.mock.invocationCallOrder[0]).toBeLessThan(
      tauriMocks.instances[0]!.setZoom.mock.invocationCallOrder[0]!
    )
    await vi.waitFor(() => expect(domReady).toHaveBeenCalledTimes(1))
    expect(didNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/docs', isMainFrame: true })
    )
    expect(webview?.getURL()).toBe('https://example.com/docs')
    expect(webview?.getTitle()).toBe('example.com')
  })

  it('registers a Tauri browser action executor for runtime queued navigation', async () => {
    installTauriRendererTestGlobals()
    const unregister = vi.fn()
    const register = vi.fn(
      (
        _tabId: string,
        _executor: (action: RuntimeComputerAction) => Promise<Record<string, unknown> | void>
      ) => {
        return unregister
      }
    )
    ;(window as TauriBrowserTestWindow).__pebbleTauriBrowserActionExecutors = { register }
    const container = createContainer('tauri-actions')

    const ensuredWebview = ensureBrowserPageWebview({
      browserTabId: 'browser.page-1',
      container,
      inputLocked: false,
      webviewPartition: 'persist:pebble-browser-session-profile-1',
      resolveContainer: () => container
    })

    expect(register).toHaveBeenCalledWith('browser.page-1', expect.any(Function))
    const registeredExecutor = register.mock.calls[0]![1]
    await expect(
      registeredExecutor({
        id: 'action-1',
        kind: 'browser.goto',
        target: 'browser.page-1',
        payload: { url: 'https://example.com/next' }
      })
    ).resolves.toMatchObject({
      url: 'https://example.com/next',
      title: 'example.com'
    })
    await vi.waitFor(() => expect(tauriMocks.Webview).toHaveBeenCalledTimes(1))
    expect(tauriMocks.instances[0]!.label).toBe('browser-browser-page-1-1')

    ;(
      ensuredWebview?.webview as
        | (BrowserPageWebview & { __pebbleDestroyNativeWebview?: () => void })
        | undefined
    )?.__pebbleDestroyNativeWebview?.()
    expect(unregister).toHaveBeenCalledTimes(1)
  })
})
