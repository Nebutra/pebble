import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { exit } from '@tauri-apps/plugin-process'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

type TauriWindowCloseRequest = { isQuitting: boolean; requestId: number }
type TauriQuitWindow = Window & { __PEBBLE_REQUEST_APP_QUIT__?: () => void }

const tauriWindowCloseListeners = new Set<(data: TauriWindowCloseRequest) => void>()
const tauriMaximizeListeners = new Set<(isMaximized: boolean) => void>()
let tauriWindowCloseInterceptorInstalled = false
let nextWindowCloseRequestId = 0
let pendingWindowCloseRequest: TauriWindowCloseRequest | null = null

export function installTauriWindowApi(): void {
  if (!hasTauriInternals()) {
    return
  }
  installTauriWindowCloseInterceptor()
  installTauriTrayQuitListener()
  installTauriNativeQuitListener()

  const base = window.api.ui
  window.api.ui = {
    ...base,
    onFullscreenChanged: subscribeTauriFullscreenChanged,
    minimize: () => {
      void getCurrentWindow().minimize()
    },
    maximize: () => {
      void getCurrentWindow()
        .toggleMaximize()
        .then(() => notifyTauriMaximizeChanged())
    },
    isMaximized: () => getCurrentWindow().isMaximized(),
    onMaximizeChanged: subscribeTauriMaximizeChanged,
    syncTrafficLights: (zoomFactor) => {
      void invoke('window_set_traffic_light_zoom', { zoomFactor }).catch((error) => {
        console.warn('[window] Failed to sync native traffic lights:', error)
      })
    },
    requestClose: requestTauriWindowClose,
    onWindowCloseRequested: subscribeTauriWindowCloseRequested,
    confirmWindowClose: (requestId) => {
      void finishTauriWindowClose(requestId)
    }
  } satisfies PreloadApi['ui']
}

function requestTauriWindowClose(): void {
  queueTauriWindowCloseRequest(false)
}

export function requestTauriAppQuit(): void {
  queueTauriWindowCloseRequest(true)
}

function queueTauriWindowCloseRequest(isQuitting: boolean): void {
  // Why: a native close event can arrive while Quit is awaiting renderer
  // guards; ordinary close must not downgrade that destructive intent.
  if (pendingWindowCloseRequest?.isQuitting && !isQuitting) {
    return
  }
  const request = { isQuitting, requestId: ++nextWindowCloseRequestId }
  pendingWindowCloseRequest = request
  if (tauriWindowCloseListeners.size > 0) {
    emitTauriWindowCloseRequested(request)
  }
}

async function finishTauriWindowClose(requestId?: number): Promise<void> {
  const request = pendingWindowCloseRequest
  if (!request || (requestId !== undefined && request.requestId !== requestId)) {
    return
  }
  // Clear before native work so duplicate confirmations cannot consume one request twice.
  pendingWindowCloseRequest = null
  const isMac = navigator.userAgent.includes('Mac')
  const isWindows = navigator.userAgent.includes('Windows')
  const minimizeToTray =
    isWindows &&
    !request.isQuitting &&
    ((await window.api.settings.get().catch(() => null))?.minimizeToTrayOnClose ?? false)
  if (minimizeToTray) {
    await getCurrentWindow().hide()
    return
  }
  const shouldQuit = request.isQuitting || !isMac
  if (shouldQuit) {
    await invoke('window_prepare_to_close').catch((error) => {
      console.warn('[window] Failed to flush native window state:', error)
    })
    await exit(0).catch(() => getCurrentWindow().destroy())
    return
  }
  // macOS keeps the application active after the last main window closes.
  await getCurrentWindow().hide()
}

let tauriTrayQuitListenerInstalled = false
let tauriNativeQuitListenerInstalled = false
let tauriNativeQuitPoll: ReturnType<typeof setInterval> | null = null

function installTauriNativeQuitListener(): void {
  if (tauriNativeQuitListenerInstalled) {
    return
  }
  tauriNativeQuitListenerInstalled = true
  ;(window as TauriQuitWindow).__PEBBLE_REQUEST_APP_QUIT__ = requestTauriAppQuit
  window.addEventListener?.('pebble:native-quit-requested', requestTauriAppQuit)
  tauriNativeQuitPoll = setInterval(() => {
    void invoke<boolean>('native_quit_take_pending').then((pending) => {
      if (pending) {
        requestTauriAppQuit()
      }
    })
  }, 500)
  void listen('pebble://native-quit-requested', requestTauriAppQuit).then(() =>
    invoke<boolean>('native_quit_take_pending').then((pending) => {
      if (pending) {
        requestTauriAppQuit()
      }
    })
  )
}

function installTauriTrayQuitListener(): void {
  if (tauriTrayQuitListenerInstalled || !navigator.userAgent.includes('Windows')) {
    return
  }
  tauriTrayQuitListenerInstalled = true
  void listen('pebble://tray-quit', requestTauriAppQuit)
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function emitTauriWindowCloseRequested(data: TauriWindowCloseRequest): void {
  for (const listener of tauriWindowCloseListeners) {
    listener(data)
  }
}

function subscribeTauriWindowCloseRequested(
  callback: (data: TauriWindowCloseRequest) => void
): () => void {
  tauriWindowCloseListeners.add(callback)
  if (pendingWindowCloseRequest) {
    callback(pendingWindowCloseRequest)
  }
  return () => {
    tauriWindowCloseListeners.delete(callback)
  }
}

function installTauriWindowCloseInterceptor(): void {
  if (tauriWindowCloseInterceptorInstalled) {
    return
  }
  tauriWindowCloseInterceptorInstalled = true
  void getCurrentWindow().onCloseRequested((event) => {
    // Keep Electron's renderer-owned pre-close guards active in Tauri too.
    event.preventDefault()
    requestTauriWindowClose()
  })
}

function subscribeTauriMaximizeChanged(callback: (isMaximized: boolean) => void): () => void {
  tauriMaximizeListeners.add(callback)
  void notifyTauriMaximizeChanged(callback)
  const unsubscribeGeometry = subscribeTauriWindowGeometryChanged(() => {
    void notifyTauriMaximizeChanged(callback)
  })
  return () => {
    tauriMaximizeListeners.delete(callback)
    unsubscribeGeometry()
  }
}

async function notifyTauriMaximizeChanged(
  callback?: (isMaximized: boolean) => void
): Promise<void> {
  const isMaximized = await getCurrentWindow().isMaximized()
  if (callback) {
    callback(isMaximized)
    return
  }
  for (const listener of tauriMaximizeListeners) {
    listener(isMaximized)
  }
}

function subscribeTauriFullscreenChanged(callback: (isFullScreen: boolean) => void): () => void {
  void notifyTauriFullscreenChanged(callback)
  return subscribeTauriWindowGeometryChanged(() => {
    void notifyTauriFullscreenChanged(callback)
  })
}

async function notifyTauriFullscreenChanged(
  callback: (isFullScreen: boolean) => void
): Promise<void> {
  callback(await getCurrentWindow().isFullscreen())
}

function subscribeTauriWindowGeometryChanged(callback: () => void): () => void {
  const appWindow = getCurrentWindow()
  let cancelled = false
  const unlisteners: (() => void)[] = []
  const register = (pending: Promise<() => void>): void => {
    void pending.then((unlisten) => {
      if (cancelled) {
        unlisten()
        return
      }
      unlisteners.push(unlisten)
    })
  }
  register(appWindow.onResized(callback))
  register(appWindow.onScaleChanged(callback))
  return () => {
    cancelled = true
    for (const unlisten of unlisteners) {
      unlisten()
    }
    unlisteners.length = 0
  }
}

export function resetTauriWindowApiForTests(): void {
  tauriWindowCloseListeners.clear()
  tauriMaximizeListeners.clear()
  tauriWindowCloseInterceptorInstalled = false
  tauriTrayQuitListenerInstalled = false
  tauriNativeQuitListenerInstalled = false
  if (tauriNativeQuitPoll) {
    clearInterval(tauriNativeQuitPoll)
  }
  tauriNativeQuitPoll = null
  nextWindowCloseRequestId = 0
  pendingWindowCloseRequest = null
}
