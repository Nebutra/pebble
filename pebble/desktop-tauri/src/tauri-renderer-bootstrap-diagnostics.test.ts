// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetTauriRendererBootstrapDiagnosticsForTests,
  installTauriRendererBootstrapDiagnostics,
  markTauriRendererBootstrapComplete,
  renderTauriRendererBootstrapFailure,
  runTauriRendererBootstrapStage,
  setTauriRendererBootstrapStage
} from './tauri-renderer-bootstrap-diagnostics'

type TauriRendererBootstrapTestWindow = Window & {
  __pebbleTauriBootstrapFailure?: {
    stage: string
    name: string
    message: string
    stack?: string
  }
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  delete (window as TauriRendererBootstrapTestWindow).__pebbleTauriBootstrapFailure
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  _resetTauriRendererBootstrapDiagnosticsForTests()
  vi.restoreAllMocks()
})

describe('Tauri renderer bootstrap diagnostics', () => {
  it('renders a visible bootstrap failure for guarded synchronous startup stages', () => {
    const completed = runTauriRendererBootstrapStage('install-window-api', () => {
      throw new Error('native bridge exploded')
    })

    expect(completed).toBe(false)
    expect(document.querySelector('[data-pebble-tauri-bootstrap-failure="install-window-api"]'))
      .not.toBeNull()
    expect(document.body.textContent).toContain('Pebble could not finish starting.')
    expect(document.body.textContent).toContain('native bridge exploded')
    expect((window as TauriRendererBootstrapTestWindow).__pebbleTauriBootstrapFailure).toMatchObject(
      {
        stage: 'install-window-api',
        name: 'Error',
        message: 'native bridge exploded'
      }
    )
  })

  it('keeps runtime errors from replacing the app after bootstrap completes', () => {
    installTauriRendererBootstrapDiagnostics()
    setTauriRendererBootstrapStage('render-react-root')
    markTauriRendererBootstrapComplete()

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('late runtime error') }))

    expect(document.querySelector('[data-pebble-tauri-bootstrap-failure]')).toBeNull()
    expect((window as TauriRendererBootstrapTestWindow).__pebbleTauriBootstrapFailure).toBeUndefined()
  })

  it('renders import-time failures before the React app is loaded', () => {
    renderTauriRendererBootstrapFailure('load-renderer-entry', 'missing export')

    expect(document.querySelector('[data-pebble-tauri-bootstrap-failure="load-renderer-entry"]'))
      .not.toBeNull()
    expect(document.body.textContent).toContain('missing export')
  })
})
