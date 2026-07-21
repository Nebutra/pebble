// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { getTauriUnavailableFeatureTipIds } from './tauri-unavailable-feature-tips'

type TauriFeatureTipsTestWindow = Window & {
  __PEBBLE_TAURI_SHELL__?: boolean
}

describe('Tauri unavailable feature tips', () => {
  afterEach(() => {
    delete (window as TauriFeatureTipsTestWindow).__PEBBLE_TAURI_SHELL__
  })

  it('does not suppress Electron feature tips', () => {
    expect(getTauriUnavailableFeatureTipIds()).toEqual([])
  })

  it('keeps voice dictation education available in the Tauri shell', () => {
    ;(window as TauriFeatureTipsTestWindow).__PEBBLE_TAURI_SHELL__ = true

    expect(getTauriUnavailableFeatureTipIds()).toEqual([])
  })
})
