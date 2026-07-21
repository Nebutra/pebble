// @vitest-environment happy-dom

import { lazy, useEffect, useState } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsOverlayLayers } from './SettingsOverlay'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('SettingsOverlayLayers', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('contains a cold route load and retains state and effects across return navigation', async () => {
    let resolveSettingsRoute: ((module: { default: () => React.JSX.Element }) => void) | null = null
    const loadSettingsRoute = vi.fn(
      () =>
        new Promise<{ default: () => React.JSX.Element }>((resolve) => {
          resolveSettingsRoute = resolve
        })
    )
    const onEffectConnected = vi.fn()
    const onEffectDisconnected = vi.fn()
    const SettingsRoute = lazy(loadSettingsRoute)

    function LoadedSettings(): React.JSX.Element {
      const [value, setValue] = useState(0)
      useEffect(() => {
        onEffectConnected()
        return onEffectDisconnected
      }, [])
      return (
        <button data-loaded-settings onClick={() => setValue((current) => current + 1)}>
          Settings ready {value}
        </button>
      )
    }

    const renderOverlay = (settingsVisible: boolean, settingsPrepared: boolean): void => {
      root.render(
        <>
          <div data-workbench>Workbench</div>
          <SettingsOverlayLayers
            settingsPrepared={settingsPrepared}
            settingsVisible={settingsVisible}
          >
            <SettingsRoute />
          </SettingsOverlayLayers>
        </>
      )
    }

    act(() => renderOverlay(true, false))

    expect(loadSettingsRoute).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-settings-loading]')?.textContent).toBe(
      'Loading settings...'
    )
    expect(container.querySelector('[data-workbench]')).not.toBeNull()

    await act(async () => {
      resolveSettingsRoute?.({ default: LoadedSettings })
      await Promise.resolve()
    })

    expect(container.querySelector('[data-loaded-settings]')).not.toBeNull()
    expect(onEffectConnected).toHaveBeenCalledTimes(1)

    act(() => {
      ;(container.querySelector('[data-loaded-settings]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[data-loaded-settings]')?.textContent).toContain('1')

    act(() => renderOverlay(false, true))

    const hiddenContentLayer = container.querySelector('[data-settings-overlay][inert]')
    expect(hiddenContentLayer).not.toBeNull()
    expect(hiddenContentLayer?.classList.contains('settings-overlay-layer--hidden')).toBe(true)
    expect(container.querySelector('[data-loaded-settings]')).not.toBeNull()
    expect(onEffectDisconnected).not.toHaveBeenCalled()

    act(() => renderOverlay(true, true))

    expect(loadSettingsRoute).toHaveBeenCalledTimes(1)
    expect(onEffectConnected).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-loaded-settings]')?.textContent).toContain('1')
    expect(container.querySelector('[data-settings-loading]')).toBeNull()
  })
})
