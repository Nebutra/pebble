// @vitest-environment happy-dom

import { useRef } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsKeyboardScope } from './useSettingsKeyboardScope'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { dismiss: vi.fn(), info: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

function Harness({ enabled, onClose }: { enabled: boolean; onClose: () => Promise<void> }) {
  const searchInputRef = useRef<HTMLInputElement>(null)
  useSettingsKeyboardScope({
    activeSectionId: 'general',
    closeSettingsPage: onClose,
    enabled,
    keybindings: {},
    searchInputRef
  })
  return <input ref={searchInputRef} aria-label="Search settings" />
}

function dispatchSettingsSearchShortcut(): KeyboardEvent {
  const isMac = navigator.userAgent.includes('Mac')
  const event = new KeyboardEvent('keydown', {
    key: 'f',
    code: 'KeyF',
    bubbles: true,
    cancelable: true,
    metaKey: isMac,
    ctrlKey: !isMac
  })
  document.dispatchEvent(event)
  return event
}

describe('useSettingsKeyboardScope', () => {
  let container: HTMLDivElement
  let root: Root
  const onClose = vi.fn<() => Promise<void>>()

  beforeEach(() => {
    onClose.mockReset()
    onClose.mockResolvedValue(undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('releases workbench shortcuts and Escape when retained Settings becomes hidden', () => {
    act(() => root.render(<Harness enabled onClose={onClose} />))
    const searchInput = container.querySelector('input')
    expect(dispatchSettingsSearchShortcut().defaultPrevented).toBe(true)

    act(() => root.render(<Harness enabled={false} onClose={onClose} />))
    searchInput?.blur()

    const findEvent = dispatchSettingsSearchShortcut()
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )

    expect(findEvent.defaultPrevented).toBe(false)
    expect(document.activeElement).not.toBe(searchInput)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('owns search and Escape while Settings is visible', () => {
    act(() => root.render(<Harness enabled onClose={onClose} />))
    const searchInput = container.querySelector('input')

    const findEvent = dispatchSettingsSearchShortcut()

    expect(findEvent.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(searchInput)

    act(() => {
      searchInput?.blur()
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
