import { getCurrentWindow } from '@tauri-apps/api/window'

import type { PreloadApi } from '../../../src/preload/api-types'

type TauriWindowCloseRequest = { isQuitting: boolean }

const tauriWindowCloseListeners = new Set<(data: TauriWindowCloseRequest) => void>()
const tauriMaximizeListeners = new Set<(isMaximized: boolean) => void>()
let tauriWindowCloseConfirmed = false
let tauriWindowCloseInterceptorInstalled = false

export function installTauriWindowApi(): void {
  if (!hasTauriInternals()) {
    return
  }

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
    requestClose: () => emitTauriWindowCloseRequested({ isQuitting: false }),
    onWindowCloseRequested: subscribeTauriWindowCloseRequested,
    confirmWindowClose: () => {
      tauriWindowCloseConfirmed = true
      void getCurrentWindow()
        .close()
        .catch(() => {
          tauriWindowCloseConfirmed = false
        })
    }
  } satisfies PreloadApi['ui']
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
  installTauriWindowCloseInterceptor()
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
    if (tauriWindowCloseConfirmed) {
      tauriWindowCloseConfirmed = false
      return
    }
    // Keep Electron's renderer-owned pre-close guards active in Tauri too.
    event.preventDefault()
    emitTauriWindowCloseRequested({ isQuitting: false })
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
