// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { isPebbleTauriShell } from './tauri-shell-detection'

type PebbleTauriShellTestWindow = Window & {
  __PEBBLE_TAURI_SHELL__?: boolean
  __TAURI_INTERNALS__?: unknown
  __TAURI__?: unknown
  __TAURI_IPC__?: unknown
}

function clearTauriShellMarkers(): void {
  const testWindow = window as PebbleTauriShellTestWindow
  delete testWindow.__PEBBLE_TAURI_SHELL__
  delete testWindow.__TAURI_INTERNALS__
  delete testWindow.__TAURI__
  delete testWindow.__TAURI_IPC__
}

describe('Tauri shell detection', () => {
  afterEach(() => {
    clearTauriShellMarkers()
  })

  it('keeps normal web/Electron renderer paths out of Tauri-only gates', () => {
    clearTauriShellMarkers()

    expect(isPebbleTauriShell()).toBe(false)
  })

  it('detects the Pebble-owned Tauri shell marker before renderer modules probe internals', () => {
    ;(window as PebbleTauriShellTestWindow).__PEBBLE_TAURI_SHELL__ = true

    expect(isPebbleTauriShell()).toBe(true)
  })

  it('falls back to native Tauri globals when the entry marker is absent', () => {
    ;(window as PebbleTauriShellTestWindow).__TAURI_IPC__ = () => undefined

    expect(isPebbleTauriShell()).toBe(true)
  })
})
