import type { Webview as NativeTauriBrowserWebview } from '@tauri-apps/api/webview'
import { PEBBLE_BROWSER_BLANK_URL } from '../../../../shared/constants'
import { registerPersistentWebview } from './webview-registry'

type TauriBrowserWebviewState = {
  browserTabId: string
  container: HTMLDivElement
  currentUrl: string
  title: string
  history: string[]
  historyIndex: number
  generation: number
  loading: boolean
  destroyed: boolean
  inputLocked: boolean
  zoomLevel: number
  nativeWebview: NativeTauriBrowserWebview | null
  resizeObserver: ResizeObserver | null
  removeWindowListeners: (() => void) | null
}

type TauriBrowserWebview = Electron.WebviewTag & {
  __pebbleTauriBrowserWebviewState?: TauriBrowserWebviewState
  __pebbleDestroyNativeWebview?: () => void
  __pebbleSetNativeBrowserInputLocked?: (locked: boolean) => void
}

export function ensureTauriBrowserPageWebview({
  browserTabId,
  container,
  inputLocked,
  webviewPartition
}: {
  browserTabId: string
  container: HTMLDivElement
  inputLocked: boolean
  webviewPartition: string
}): { container: HTMLDivElement; created: boolean; webview: Electron.WebviewTag } {
  const element = document.createElement('div') as unknown as TauriBrowserWebview
  element.dataset.tauriBrowserPageWebview = browserTabId
  element.setAttribute('partition', webviewPartition)
  element.tabIndex = -1
  element.style.display = 'flex'
  element.style.flex = '1'
  element.style.width = '100%'
  element.style.height = '100%'
  element.style.border = 'none'
  element.style.pointerEvents = inputLocked ? 'none' : 'auto'
  element.style.background = '#ffffff'

  const state: TauriBrowserWebviewState = {
    browserTabId,
    container,
    currentUrl: PEBBLE_BROWSER_BLANK_URL,
    title: 'New Tab',
    history: [],
    historyIndex: -1,
    generation: 0,
    loading: false,
    destroyed: false,
    inputLocked,
    zoomLevel: 0,
    nativeWebview: null,
    resizeObserver: null,
    removeWindowListeners: null
  }
  element.__pebbleTauriBrowserWebviewState = state
  installTauriBrowserWebviewShape(element, state)

  registerPersistentWebview(browserTabId, element)
  container.appendChild(element)
  startTauriBrowserWebviewLayoutSync(element, state)
  return { container, created: true, webview: element }
}

export function isTauriBrowserHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function installTauriBrowserWebviewShape(
  element: TauriBrowserWebview,
  state: TauriBrowserWebviewState
): void {
  const nativeFocus = element.focus.bind(element)
  Object.defineProperty(element, 'src', {
    get: () => state.currentUrl,
    set: (value: string) => {
      void navigateTauriBrowserWebview(element, state, normalizeTauriBrowserUrl(value), {
        pushHistory: true
      })
    }
  })
  Object.assign(element, {
    getWebContentsId: () => stableNegativeId(state.browserTabId),
    getURL: () => state.currentUrl,
    getTitle: () => state.title,
    canGoBack: () => state.historyIndex > 0,
    canGoForward: () => state.historyIndex >= 0 && state.historyIndex < state.history.length - 1,
    isLoading: () => state.loading,
    isDestroyed: () => state.destroyed,
    getZoomLevel: () => state.zoomLevel,
    setZoomLevel: (level: number) => {
      state.zoomLevel = level
      void state.nativeWebview?.setZoom(Math.pow(1.2, level))
    },
    goBack: () => {
      if (state.historyIndex <= 0) {
        return
      }
      state.historyIndex -= 1
      void navigateTauriBrowserWebview(element, state, state.history[state.historyIndex], {
        pushHistory: false
      })
    },
    goForward: () => {
      if (state.historyIndex < 0 || state.historyIndex >= state.history.length - 1) {
        return
      }
      state.historyIndex += 1
      void navigateTauriBrowserWebview(element, state, state.history[state.historyIndex], {
        pushHistory: false
      })
    },
    reload: () => {
      void navigateTauriBrowserWebview(element, state, state.currentUrl, { pushHistory: false })
    },
    reloadIgnoringCache: () => {
      void navigateTauriBrowserWebview(element, state, state.currentUrl, { pushHistory: false })
    },
    stop: () => {
      state.loading = false
      dispatchTauriBrowserWebviewEvent(element, 'did-stop-loading')
    },
    focus: () => {
      nativeFocus()
      void focusTauriNativeWebview(state)
    }
  })
  element.__pebbleDestroyNativeWebview = () => destroyTauriBrowserWebview(state)
  element.__pebbleSetNativeBrowserInputLocked = (locked) => {
    state.inputLocked = locked
    syncTauriBrowserWebviewLayout(state)
  }
}

async function navigateTauriBrowserWebview(
  element: TauriBrowserWebview,
  state: TauriBrowserWebviewState,
  url: string,
  options: { pushHistory: boolean }
): Promise<void> {
  if (state.destroyed) {
    return
  }
  if (options.pushHistory) {
    pushTauriBrowserHistory(state, url)
  }
  element.setAttribute('src', url)
  state.currentUrl = url
  state.title = titleForTauriBrowserUrl(url)
  state.loading = url !== PEBBLE_BROWSER_BLANK_URL
  dispatchTauriBrowserWebviewEvent(element, 'did-start-loading')

  const generation = ++state.generation
  await state.nativeWebview?.close().catch(() => undefined)
  state.nativeWebview = null

  const bounds = readTauriBrowserWebviewBounds(state)
  try {
    const [{ Webview }, { getCurrentWindow }] = await Promise.all([
      import('@tauri-apps/api/webview'),
      import('@tauri-apps/api/window')
    ])
    if (state.destroyed || generation !== state.generation) {
      return
    }
    const nativeWebview = new Webview(getCurrentWindow(), `${tauriWebviewLabel(state)}-${generation}`, {
      url,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    })
    state.nativeWebview = nativeWebview
    await nativeWebview.setZoom(Math.pow(1.2, state.zoomLevel)).catch(() => undefined)
    let completed = false
    const complete = (): void => {
      if (completed || state.destroyed || generation !== state.generation) {
        return
      }
      completed = true
      state.loading = false
      syncTauriBrowserWebviewLayout(state)
      dispatchTauriBrowserWebviewEvent(element, 'dom-ready')
      dispatchTauriBrowserWebviewEvent(element, 'did-navigate', { url, isMainFrame: true })
      dispatchTauriBrowserWebviewEvent(element, 'page-title-updated', { title: state.title })
      dispatchTauriBrowserWebviewEvent(element, 'did-stop-loading')
    }
    await nativeWebview.once('tauri://created', complete)
    await nativeWebview.once('tauri://error', (event) => {
      if (state.destroyed || generation !== state.generation) {
        return
      }
      state.loading = false
      dispatchTauriBrowserWebviewEvent(element, 'did-fail-load', {
        errorCode: -1,
        errorDescription: String(event.payload ?? 'Tauri webview failed to load.'),
        validatedURL: url,
        isMainFrame: true
      })
    })
    window.setTimeout(complete, 750)
  } catch (error) {
    state.loading = false
    dispatchTauriBrowserWebviewEvent(element, 'did-fail-load', {
      errorCode: -1,
      errorDescription: error instanceof Error ? error.message : String(error),
      validatedURL: url,
      isMainFrame: true
    })
  }
}

function pushTauriBrowserHistory(state: TauriBrowserWebviewState, url: string): void {
  if (state.history[state.historyIndex] === url) {
    return
  }
  state.history = state.history.slice(0, state.historyIndex + 1)
  state.history.push(url)
  state.historyIndex = state.history.length - 1
}

function startTauriBrowserWebviewLayoutSync(
  element: TauriBrowserWebview,
  state: TauriBrowserWebviewState
): void {
  const sync = (): void => syncTauriBrowserWebviewLayout(state)
  state.resizeObserver = new ResizeObserver(sync)
  state.resizeObserver.observe(state.container)
  state.resizeObserver.observe(element)
  window.addEventListener('resize', sync)
  window.addEventListener('scroll', sync, true)
  state.removeWindowListeners = () => {
    window.removeEventListener('resize', sync)
    window.removeEventListener('scroll', sync, true)
  }
  window.requestAnimationFrame(sync)
}

function syncTauriBrowserWebviewLayout(state: TauriBrowserWebviewState): void {
  const nativeWebview = state.nativeWebview
  if (!nativeWebview || state.destroyed) {
    return
  }
  const bounds = readTauriBrowserWebviewBounds(state)
  const visible = !state.inputLocked && bounds.width > 1 && bounds.height > 1
  void (visible ? nativeWebview.show?.() : nativeWebview.hide?.())
  if (!visible) {
    return
  }
  void setTauriNativeWebviewBounds(nativeWebview, bounds)
}

function readTauriBrowserWebviewBounds(state: TauriBrowserWebviewState): {
  x: number
  y: number
  width: number
  height: number
} {
  if (!state.container.isConnected) {
    return { x: 0, y: 0, width: 1, height: 1 }
  }
  const rect = state.container.getBoundingClientRect()
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  }
}

async function focusTauriNativeWebview(state: TauriBrowserWebviewState): Promise<void> {
  await state.nativeWebview?.setFocus?.().catch(() => undefined)
}

async function setTauriNativeWebviewBounds(
  nativeWebview: NativeTauriBrowserWebview,
  bounds: { x: number; y: number; width: number; height: number }
): Promise<void> {
  const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi')
  await Promise.all([
    nativeWebview.setPosition(new LogicalPosition(bounds.x, bounds.y)),
    nativeWebview.setSize(new LogicalSize(bounds.width, bounds.height))
  ]).catch(() => undefined)
}

function destroyTauriBrowserWebview(state: TauriBrowserWebviewState): void {
  if (state.destroyed) {
    return
  }
  state.destroyed = true
  state.resizeObserver?.disconnect()
  state.removeWindowListeners?.()
  void state.nativeWebview?.close().catch(() => undefined)
  state.nativeWebview = null
}

function dispatchTauriBrowserWebviewEvent(
  element: EventTarget,
  type: string,
  detail: Record<string, unknown> = {}
): void {
  const event = new Event(type)
  Object.assign(event, detail)
  element.dispatchEvent(event)
}

function normalizeTauriBrowserUrl(url: string): string {
  const trimmed = url.trim()
  return trimmed.length > 0 ? trimmed : PEBBLE_BROWSER_BLANK_URL
}

function titleForTauriBrowserUrl(url: string): string {
  if (url === PEBBLE_BROWSER_BLANK_URL || url === 'about:blank') {
    return 'New Tab'
  }
  try {
    const parsed = new URL(url)
    return parsed.hostname || url
  } catch {
    return url
  }
}

function tauriWebviewLabel(state: TauriBrowserWebviewState): string {
  return `browser-${state.browserTabId.replace(/[^a-zA-Z0-9_/:.-]/g, '-')}`
}

function stableNegativeId(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return -Math.max(1, Math.abs(hash))
}
