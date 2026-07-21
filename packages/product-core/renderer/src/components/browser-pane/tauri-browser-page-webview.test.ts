// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PEBBLE_BROWSER_BLANK_URL, PEBBLE_BROWSER_PARTITION } from '../../../../shared/constants'
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
  ensureTauriBrowserPageWebview,
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

  it('registers a page-scoped browser action executor and unregisters it on destroy', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'page-1',
      container,
      inputLocked: false,
      webviewPartition: 'persist:default'
    })

    expect(register).toHaveBeenCalledWith('page-1', expect.any(Function))
    const executor = register.mock.calls[0]?.[1]
    await expect(
      executor?.({ id: 'action-1', kind: 'browser.stop', target: 'page-1' })
    ).resolves.toMatchObject({
      url: PEBBLE_BROWSER_BLANK_URL,
      title: 'New Tab',
      canGoBack: false,
      canGoForward: false
    })

    ;(
      webview as typeof webview & { __pebbleDestroyNativeWebview?: () => void }
    ).__pebbleDestroyNativeWebview?.()

    expect(unregister).toHaveBeenCalled()
  })

  it('executes remote key, HAR, and eval actions through the native guest', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'remote-actions',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-remote-actions' }
    const executor = register.mock.calls[0]?.[1]
    tauriCoreMocks.invoke
      .mockResolvedValueOnce(JSON.stringify({ keyDown: 'Shift' }))
      .mockResolvedValueOnce(JSON.stringify({ recording: true }))
      .mockResolvedValueOnce(JSON.stringify({ result: 'Pebble', origin: 'https://example.test' }))

    await expect(
      executor?.({
        id: 'key-down',
        kind: 'browser.keyDown',
        payload: { command: 'keyDown', key: 'Shift' }
      })
    ).resolves.toEqual({ keyDown: 'Shift' })
    await expect(
      executor?.({ id: 'har-start', kind: 'browser.harStart', payload: { command: 'harStart' } })
    ).resolves.toEqual({ recording: true })
    await expect(
      executor?.({
        id: 'eval',
        kind: 'browser.eval',
        payload: { command: 'eval', expression: 'document.title' }
      })
    ).resolves.toEqual({ result: 'Pebble', origin: 'https://example.test' })
    const scripts = tauriCoreMocks.invoke.mock.calls.map(([, args]) =>
      String((args as { input?: { script?: string } })?.input?.script ?? '')
    )
    expect(scripts.some((script) => script.includes("input.command==='keyDown'"))).toBe(true)
    expect(scripts.some((script) => script.includes("input.command==='harStart'"))).toBe(true)
    expect(scripts.some((script) => script.includes('(0,eval)(input.expression)'))).toBe(true)
  })

  it('routes direct macOS mouse input through the AppKit Tauri command', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'native-mouse',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-native-mouse' }
    const executor = register.mock.calls[0]?.[1]
    tauriCoreMocks.invoke.mockResolvedValue({ accepted: true, backend: 'appkit-async-responder' })

    await executor?.({
      id: 'move',
      kind: 'browser.mouseMove',
      payload: { command: 'mouseMove', x: 20, y: 30, modifiers: ['shift'] }
    })
    await executor?.({
      id: 'click',
      kind: 'browser.mouseClick',
      payload: { command: 'mouseClick', x: 20, y: 30, button: 'left' }
    })

    expect(tauriCoreMocks.invoke).toHaveBeenNthCalledWith(1, 'browser_child_webview_input', {
      input: {
        label: 'browser-native-mouse',
        action: { kind: 'mouseMove', x: 20, y: 30, modifiers: ['shift'] }
      }
    })
    expect(tauriCoreMocks.invoke).toHaveBeenNthCalledWith(2, 'browser_child_webview_input', {
      input: {
        label: 'browser-native-mouse',
        action: expect.objectContaining({ kind: 'mouseButton', phase: 'down', x: 20, y: 30 })
      }
    })
    expect(tauriCoreMocks.invoke).toHaveBeenNthCalledWith(3, 'browser_child_webview_input', {
      input: {
        label: 'browser-native-mouse',
        action: expect.objectContaining({ kind: 'mouseButton', phase: 'up', x: 20, y: 30 })
      }
    })
    expect(
      tauriCoreMocks.invoke.mock.calls.some(([command]) => command === 'browser_guest_evaluate')
    ).toBe(false)
  })

  it('resolves selector hover and click actions through native mouse input', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'native-selector-click',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-native-selector' }
    const executor = register.mock.calls[0]?.[1]
    tauriCoreMocks.invoke.mockImplementation(async (command) =>
      command === 'browser_guest_evaluate'
        ? JSON.stringify({ element: '#submit', x: 40, y: 20 })
        : { accepted: true, backend: 'appkit-async-responder' }
    )

    await expect(
      executor?.({
        id: 'selector-hover',
        kind: 'browser.hover',
        payload: { command: 'hover', element: '#submit' }
      })
    ).resolves.toEqual({ hovered: '#submit' })
    expect(tauriCoreMocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      'browser_guest_evaluate',
      'browser_child_webview_input'
    ])
    tauriCoreMocks.invoke.mockClear()

    await expect(
      executor?.({
        id: 'selector-click',
        kind: 'browser.click',
        payload: { command: 'click', element: '#submit' }
      })
    ).resolves.toEqual({
      accepted: true,
      backend: 'appkit-async-responder',
      clicked: '#submit'
    })

    const calls = tauriCoreMocks.invoke.mock.calls
    expect(calls[0]?.[0]).toBe('browser_guest_evaluate')
    expect(String((calls[0]?.[1] as { input?: { script?: string } })?.input?.script)).toContain(
      "input.command==='resolvePoint'"
    )
    expect(calls.slice(1).map(([command]) => command)).toEqual([
      'browser_child_webview_input',
      'browser_child_webview_input'
    ])
  })

  it('focuses selectors before native macOS fill and type input', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'native-text',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-native-text' }
    const executor = register.mock.calls[0]?.[1]
    tauriCoreMocks.invoke.mockImplementation(async (command) =>
      command === 'browser_guest_evaluate'
        ? JSON.stringify({ element: '#name', x: 30, y: 20 })
        : { accepted: true, backend: 'appkit-async-responder' }
    )

    await expect(
      executor?.({
        id: 'native-fill',
        kind: 'browser.fill',
        payload: { command: 'fill', element: '#name', value: 'Pebble' }
      })
    ).resolves.toEqual({ filled: '#name' })

    const fillScript = String(
      (tauriCoreMocks.invoke.mock.calls[0]?.[1] as { input?: { script?: string } })?.input?.script
    )
    expect(fillScript).toContain('"focus":true')
    expect(tauriCoreMocks.invoke).toHaveBeenNthCalledWith(2, 'browser_child_webview_input', {
      input: {
        label: 'browser-native-text',
        action: { kind: 'textInput', text: 'Pebble', replace: true }
      }
    })
    tauriCoreMocks.invoke.mockClear()

    await expect(
      executor?.({
        id: 'native-type',
        kind: 'browser.type',
        payload: { command: 'type', element: '#name', input: ' Native' }
      })
    ).resolves.toEqual({ typed: '#name' })
    expect(tauriCoreMocks.invoke).toHaveBeenNthCalledWith(2, 'browser_child_webview_input', {
      input: {
        label: 'browser-native-text',
        action: { kind: 'textInput', text: ' Native', replace: false }
      }
    })
  })

  it('routes macOS key press, down, and up through the AppKit responder', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'native-keyboard',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-native-keyboard' }
    const executor = register.mock.calls[0]?.[1]
    tauriCoreMocks.invoke.mockResolvedValue({ accepted: true, backend: 'appkit-async-responder' })

    await expect(
      executor?.({
        id: 'native-keypress',
        kind: 'browser.keypress',
        payload: { command: 'keypress', key: 'Enter', modifiers: ['shift'] }
      })
    ).resolves.toEqual({ pressed: 'Enter' })
    await expect(
      executor?.({
        id: 'native-keydown',
        kind: 'browser.keyDown',
        payload: { command: 'keyDown', key: 'Meta' }
      })
    ).resolves.toEqual({ keyDown: 'Meta' })
    await expect(
      executor?.({
        id: 'native-keyup',
        kind: 'browser.keyUp',
        payload: { command: 'keyUp', key: 'Meta' }
      })
    ).resolves.toEqual({ keyUp: 'Meta' })

    expect(tauriCoreMocks.invoke.mock.calls).toEqual([
      [
        'browser_child_webview_input',
        {
          input: {
            label: 'browser-native-keyboard',
            action: { kind: 'key', phase: 'press', key: 'Enter', modifiers: ['shift'] }
          }
        }
      ],
      [
        'browser_child_webview_input',
        {
          input: {
            label: 'browser-native-keyboard',
            action: { kind: 'key', phase: 'down', key: 'Meta', modifiers: [] }
          }
        }
      ],
      [
        'browser_child_webview_input',
        {
          input: {
            label: 'browser-native-keyboard',
            action: { kind: 'key', phase: 'up', key: 'Meta', modifiers: [] }
          }
        }
      ]
    ])
  })

  it('routes macOS wheel deltas through the native child WebView command', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'native-wheel',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-native-wheel' }
    const executor = register.mock.calls[0]?.[1]
    tauriCoreMocks.invoke.mockResolvedValue({ accepted: true, backend: 'appkit-async-responder' })

    await expect(
      executor?.({
        id: 'native-wheel',
        kind: 'browser.mouseWheel',
        payload: { command: 'mouseWheel', dx: 12, dy: 80, modifiers: ['shift'] }
      })
    ).resolves.toEqual({ dx: 12, dy: 80 })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_child_webview_input', {
      input: {
        label: 'browser-native-wheel',
        action: {
          kind: 'mouseWheel',
          deltaX: 12,
          deltaY: 80,
          modifiers: ['shift']
        }
      }
    })
  })

  it('routes Windows browser input through the WebView2 native command boundary', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'webview2-input',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-webview2-input' }
    const executor = register.mock.calls[0]?.[1]
    tauriCoreMocks.invoke.mockResolvedValue({ accepted: true, backend: 'webview2-cdp' })

    await expect(
      executor?.({
        id: 'webview2-key',
        kind: 'browser.keypress',
        payload: { command: 'keypress', key: 'Enter' }
      })
    ).resolves.toEqual({ pressed: 'Enter' })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_child_webview_input', {
      input: {
        label: 'browser-webview2-input',
        action: { kind: 'key', phase: 'press', key: 'Enter', modifiers: [] }
      }
    })
    expect(
      tauriCoreMocks.invoke.mock.calls.some(([command]) => command === 'browser_guest_evaluate')
    ).toBe(false)
  })

  it('resolves both drag targets before one ordered native drag command', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'native-drag',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-native-drag' }
    const executor = register.mock.calls[0]?.[1]
    tauriCoreMocks.invoke
      .mockResolvedValueOnce(JSON.stringify({ element: '#source', x: 10, y: 20 }))
      .mockResolvedValueOnce(JSON.stringify({ element: '#target', x: 110, y: 120 }))
      .mockResolvedValueOnce({ accepted: true, backend: 'appkit-async-responder' })

    await expect(
      executor?.({
        id: 'native-drag',
        kind: 'browser.drag',
        payload: { command: 'drag', from: '#source', to: '#target' }
      })
    ).resolves.toEqual({ dragged: '#source', to: '#target' })
    expect(tauriCoreMocks.invoke.mock.calls.slice(0, 2).map(([command]) => command)).toEqual([
      'browser_guest_evaluate',
      'browser_guest_evaluate'
    ])
    expect(tauriCoreMocks.invoke).toHaveBeenNthCalledWith(3, 'browser_child_webview_input', {
      input: {
        label: 'browser-native-drag',
        action: {
          kind: 'mouseDrag',
          fromX: 10,
          fromY: 20,
          toX: 110,
          toY: 120,
          steps: 8,
          modifiers: []
        }
      }
    })
  })

  it('checks macOS controls with a native click and verifies their final state', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'native-check',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-native-check' }
    const executor = register.mock.calls[0]?.[1]
    tauriCoreMocks.invoke.mockImplementation(async (command, args) => {
      if (command !== 'browser_guest_evaluate') {
        return { accepted: true, backend: 'appkit-async-responder' }
      }
      const script = String((args as { input?: { script?: string } }).input?.script ?? '')
      return script.includes('"command":"resolvePoint"')
        ? JSON.stringify({ element: '#enabled', x: 20, y: 30 })
        : JSON.stringify({ origin: 'https://example.test', checked: true })
    })

    await expect(
      executor?.({
        id: 'native-check',
        kind: 'browser.check',
        payload: { command: 'check', element: '#enabled' }
      })
    ).resolves.toEqual({ checked: '#enabled', value: true })
    expect(tauriCoreMocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      'browser_guest_evaluate',
      'browser_child_webview_input',
      'browser_child_webview_input',
      'browser_guest_evaluate'
    ])
  })

  it('selects one macOS option through native navigation keys', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'native-select',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: 'browser-native-select' }
    const executor = register.mock.calls[0]?.[1]
    tauriCoreMocks.invoke.mockImplementation(async (command) =>
      command === 'browser_guest_evaluate'
        ? JSON.stringify({
            element: '#color',
            index: 2,
            multiple: false,
            text: 'Blue',
            value: 'blue'
          })
        : { accepted: true, backend: 'appkit-async-responder' }
    )

    await expect(
      executor?.({
        id: 'native-select',
        kind: 'browser.select',
        payload: { command: 'select', element: '#color', values: ['blue'] }
      })
    ).resolves.toEqual({ selected: '#color', values: ['blue'] })
    expect(tauriCoreMocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      'browser_guest_evaluate',
      'browser_child_webview_input',
      'browser_child_webview_input',
      'browser_child_webview_input',
      'browser_child_webview_input'
    ])
    const phases = tauriCoreMocks.invoke.mock.calls
      .slice(1)
      .map(([, args]) => (args as { input?: { action?: { key?: string } } }).input?.action?.key)
    expect(phases).toEqual(['B', 'l', 'u', 'e'])
  })

  it.each([
    ['Mac', 'Meta'],
    ['Windows', 'Control'],
    ['Linux x86_64', 'Control']
  ])('selects multiple options through native %s mouse input', async (userAgent, modifier) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: `native-multi-${userAgent}`,
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    ;(
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: { nativeWebview: { label: string } | null }
      }
    ).__pebbleTauriBrowserWebviewState!.nativeWebview = { label: `browser-multi-${userAgent}` }
    const executor = register.mock.calls[0]?.[1]
    const guestResults = [
      { element: '#roles', index: 0, multiple: true, value: 'alpha', x: 80, y: 40 },
      { element: '#roles', index: 2, multiple: true, value: 'gamma', x: 80, y: 100 },
      { element: '#roles', multiple: true, values: ['alpha', 'gamma'] }
    ]
    tauriCoreMocks.invoke.mockImplementation(async (command) =>
      command === 'browser_guest_evaluate'
        ? JSON.stringify(guestResults.shift())
        : { accepted: true, backend: 'native-responder' }
    )

    await expect(
      executor?.({
        id: `native-multi-${userAgent}`,
        kind: 'browser.select',
        payload: { command: 'select', element: '#roles', values: ['alpha', 'Gamma option'] }
      })
    ).resolves.toEqual({ selected: '#roles', values: ['alpha', 'gamma'] })

    const buttonDowns = tauriCoreMocks.invoke.mock.calls
      .filter(
        ([command, args]) =>
          command === 'browser_child_webview_input' &&
          (args as { input?: { action?: { kind?: string; phase?: string } } }).input?.action
            ?.kind === 'mouseButton' &&
          (args as { input?: { action?: { phase?: string } } }).input?.action?.phase === 'down'
      )
      .map(
        ([, args]) =>
          (args as { input?: { action?: { modifiers?: string[] } } }).input?.action?.modifiers
      )
    expect(buttonDowns).toEqual([[], [modifier]])
    expect(guestResults).toEqual([])
  })

  it('preserves init scripts and supplies them to replacement WebViews', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { webview } = ensureTauriBrowserPageWebview({
      browserTabId: 'init-page',
      container,
      inputLocked: false,
      webviewPartition: PEBBLE_BROWSER_PARTITION
    })
    const state = (
      webview as typeof webview & {
        __pebbleTauriBrowserWebviewState?: {
          nativeWebview: { label: string; close: () => Promise<void> } | null
        }
      }
    ).__pebbleTauriBrowserWebviewState!
    state.nativeWebview = { label: 'browser-init-page', close: vi.fn(async () => undefined) }
    const executor = register.mock.calls[0]?.[1]
    const script = '  globalThis.__pebbleEarly = true\n'
    tauriCoreMocks.invoke.mockResolvedValueOnce('true')
    await executor?.({
      id: 'add',
      kind: 'browser.initScriptAdd',
      payload: { command: 'initScriptAdd', script }
    })
    installTauriInvokeHost()
    await executor?.({
      id: 'goto',
      kind: 'browser.goto',
      payload: { command: 'goto', url: 'https://example.test' }
    })
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('browser_child_webview_create', {
      input: expect.objectContaining({ initScripts: [script] })
    })
  })

})
