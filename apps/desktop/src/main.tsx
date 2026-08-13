import './pebble-renderer.css'

import {
  installTauriRendererBootstrapDiagnostics,
  markTauriRendererBootstrapComplete,
  renderTauriRendererBootstrapFailure,
  setTauriRendererBootstrapStage
} from './tauri-renderer-bootstrap-diagnostics'

installTauriRendererBootstrapDiagnostics()

// Why: renderer modules select shell-owned affordances before the Tauri
// internals global is guaranteed to be observable in every WebView mode.
;(window as Window & { __PEBBLE_TAURI_SHELL__?: boolean }).__PEBBLE_TAURI_SHELL__ = true

// Why: the runtime is a separate process, and nothing asked for it until the
// first feature happened to need one — after React had booted. Measured on a
// loaded machine, the Go process only spawned 4s after the window appeared, and
// no terminal can open before it is listening. Start it alongside the renderer
// rather than behind it. The per-call path stays the authority: it probes first
// and shares this same in-flight promise, so this cannot spawn a second runtime.
void import('./pebble-tauri-runtime-transport')
  .then(({ ensurePebbleRuntimeProcess }) => ensurePebbleRuntimeProcess())
  .catch(() => {
    // Swallowed on purpose — the renderer must boot even if the runtime does
    // not, and every runtime call retries this for itself.
  })

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
