// @vitest-environment happy-dom

import { act, lazy } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveSettingsSectionProvider, SettingsSection } from './SettingsSection'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

describe('SettingsSection', () => {
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

  it('keeps the selected section chrome visible while a cold pane loads', async () => {
    let resolvePane: ((module: { default: () => React.JSX.Element }) => void) | null = null
    const ColdPane = lazy(
      () =>
        new Promise<{ default: () => React.JSX.Element }>((resolve) => {
          resolvePane = resolve
        })
    )

    act(() => {
      root.render(
        <ActiveSettingsSectionProvider value="terminal">
          <SettingsSection id="terminal" title="Terminal" description="Terminal settings">
            <ColdPane />
          </SettingsSection>
        </ActiveSettingsSectionProvider>
      )
    })

    expect(container.textContent).toContain('Terminal')
    expect(container.textContent).toContain('Terminal settings')
    expect(container.querySelector('[data-settings-section-loading]')).not.toBeNull()

    await act(async () => {
      resolvePane?.({ default: () => <div data-loaded-pane>Ready</div> })
      await Promise.resolve()
    })

    expect(container.querySelector('[data-loaded-pane]')?.textContent).toBe('Ready')
    expect(container.querySelector('[data-settings-section-loading]')).toBeNull()
  })
})
