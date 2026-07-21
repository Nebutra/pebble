type PebbleTauriWindow = Window & {
  __PEBBLE_TAURI_SHELL__?: boolean
  __TAURI__?: unknown
  __TAURI_INTERNALS__?: unknown
  __TAURI_IPC__?: unknown
}

export function isPebbleTauriShell(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  const tauriWindow = window as PebbleTauriWindow
  if (tauriWindow.__PEBBLE_TAURI_SHELL__ === true) {
    return true
  }

  return (
    '__TAURI_INTERNALS__' in tauriWindow ||
    '__TAURI__' in tauriWindow ||
    '__TAURI_IPC__' in tauriWindow ||
    window.location.protocol === 'tauri:' ||
    window.location.hostname === 'tauri.localhost'
  )
}
