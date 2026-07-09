import './pebble-renderer.css'

import {
  installTauriRendererBootstrapDiagnostics,
  markTauriRendererBootstrapComplete,
  renderTauriRendererBootstrapFailure,
  setTauriRendererBootstrapStage
} from './tauri-renderer-bootstrap-diagnostics'

installTauriRendererBootstrapDiagnostics()

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
