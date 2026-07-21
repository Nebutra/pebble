export function isWebClientLocation(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  const shellWindow = window as unknown as {
    __PEBBLE_TAURI_SHELL__?: boolean
    __PEBBLE_WEB_CLIENT__?: boolean
  }

  // Tauri reuses the web preload implementation as a compatibility baseline,
  // but it is still a full desktop shell. Desktop capability and navigation
  // gates must not disappear just because that baseline sets the web marker.
  if (shellWindow.__PEBBLE_TAURI_SHELL__ === true) {
    return false
  }

  return (
    Boolean(shellWindow.__PEBBLE_WEB_CLIENT__) ||
    window.location.pathname.endsWith('/web-index.html')
  )
}
