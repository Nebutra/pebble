// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { isWebClientLocation } from './web-client-location'

type ShellWindow = Window & {
  __PEBBLE_TAURI_SHELL__?: boolean
  __PEBBLE_WEB_CLIENT__?: boolean
}

afterEach(() => {
  delete (window as ShellWindow).__PEBBLE_TAURI_SHELL__
  delete (window as ShellWindow).__PEBBLE_WEB_CLIENT__
  window.history.replaceState({}, '', '/')
})

describe('isWebClientLocation', () => {
  it('recognizes the paired web-client marker', () => {
    ;(window as ShellWindow).__PEBBLE_WEB_CLIENT__ = true

    expect(isWebClientLocation()).toBe(true)
  })

  it('keeps Tauri desktop semantics when the reused web preload sets both markers', () => {
    ;(window as ShellWindow).__PEBBLE_WEB_CLIENT__ = true
    ;(window as ShellWindow).__PEBBLE_TAURI_SHELL__ = true

    expect(isWebClientLocation()).toBe(false)
  })

  it('recognizes the dedicated web entry path outside Tauri', () => {
    window.history.replaceState({}, '', '/web-index.html')

    expect(isWebClientLocation()).toBe(true)
  })
})
