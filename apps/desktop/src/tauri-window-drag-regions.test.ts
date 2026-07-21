import { describe, expect, it } from 'vitest'
import {
  resolveTauriTitlebarPointerAction,
  resolveTauriWindowDragIntent
} from './tauri-window-drag-regions'

describe('resolveTauriWindowDragIntent', () => {
  it('starts native dragging inside a canonical Electron drag region', () => {
    expect(resolveTauriWindowDragIntent(['', 'drag', ''])).toBe(true)
  })

  it('keeps controls interactive when a nearer no-drag region overrides the titlebar', () => {
    expect(resolveTauriWindowDragIntent(['no-drag', 'drag'])).toBe(false)
  })

  it('does not turn ordinary renderer content into window chrome', () => {
    expect(resolveTauriWindowDragIntent(['', 'auto', ''])).toBeNull()
  })
})

describe('resolveTauriTitlebarPointerAction', () => {
  it('does not turn an unrelated empty top-band pixel into a drag region', () => {
    expect(
      resolveTauriTitlebarPointerAction({
        clientX: 500,
        clientY: 20,
        isMac: true,
        isInteractive: false,
        isDragTarget: false
      })
    ).toBeNull()
  })

  it('keeps an explicit overlay titlebar draggable', () => {
    expect(
      resolveTauriTitlebarPointerAction({
        clientX: 500,
        clientY: 20,
        isMac: true,
        isInteractive: false,
        isDragTarget: true
      })
    ).toBe('drag')
  })

  it.each([
    [20, 'close'],
    [40, 'minimize'],
    [60, 'toggle-maximize']
  ] as const)('falls back to the native %s traffic-light action', (clientX, action) => {
    expect(
      resolveTauriTitlebarPointerAction({
        clientX,
        clientY: 18,
        isMac: true,
        isInteractive: false,
        isDragTarget: true
      })
    ).toBe(action)
  })

  it('does not steal titlebar pointer events from renderer controls', () => {
    expect(
      resolveTauriTitlebarPointerAction({
        clientX: 200,
        clientY: 18,
        isMac: true,
        isInteractive: true,
        isDragTarget: true
      })
    ).toBeNull()
  })

  it('still honors canonical drag regions below the overlay titlebar', () => {
    expect(
      resolveTauriTitlebarPointerAction({
        clientX: 200,
        clientY: 50,
        isMac: false,
        isInteractive: false,
        isDragTarget: true
      })
    ).toBe('drag')
  })
})
