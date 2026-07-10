import './pebble-renderer.css'

import {
  installTauriRendererBootstrapDiagnostics,
  markTauriRendererBootstrapComplete,
  renderTauriRendererBootstrapFailure,
  setTauriRendererBootstrapStage
} from './tauri-renderer-bootstrap-diagnostics'

installTauriRendererBootstrapDiagnostics()

// Why: renderer modules gate unavailable Electron-only affordances before the
// Tauri internals global is guaranteed to be observable in every WebView mode.
;(window as Window & { __PEBBLE_TAURI_SHELL__?: boolean }).__PEBBLE_TAURI_SHELL__ = true

setTauriRendererBootstrapStage('load-renderer-entry')
void import('./renderer-entry')
  .then(({ startPebbleTauriRenderer }) => {
    if (startPebbleTauriRenderer()) {
      markTauriRendererBootstrapComplete()
    }
  })
  .catch((error: unknown) => {
    renderTauriRendererBootstrapFailure('load-renderer-entry', error)
  })
