import { test, expect } from './helpers/pebble-app'
import { getStoreState, waitForSessionReady } from './helpers/store'

test.describe('usage overview', () => {
  test.beforeEach(async ({ pebblePage }) => {
    await waitForSessionReady(pebblePage)
  })

  test('Stats & Usage opens on the combined overview with provider controls', async ({
    pebblePage
  }) => {
    await pebblePage.evaluate(() => {
      const state = window.__store!.getState()
      state.openSettingsPage()
    })

    await expect
      .poll(async () => getStoreState<string>(pebblePage, 'activeView'), { timeout: 5_000 })
      .toBe('settings')
    await pebblePage.getByRole('button', { name: 'Stats & Usage' }).click()
    await expect(pebblePage.getByRole('heading', { name: 'Usage Analytics' })).toBeVisible()
    const providerDropdown = pebblePage.getByTestId('usage-provider-select')
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: Overview'
    )
    await expect(pebblePage.getByTestId('usage-overview-pane')).toBeVisible()
    await expect(pebblePage.getByRole('heading', { name: 'Usage Overview' })).toBeVisible()
    await expect(pebblePage.getByRole('heading', { name: 'Providers' })).toBeVisible()
    await expect(pebblePage.getByRole('button', { name: 'Enable Claude' })).toBeVisible()
    await expect(pebblePage.getByRole('button', { name: 'Enable Codex' })).toBeVisible()
    await expect(pebblePage.getByRole('button', { name: 'Enable OpenCode' })).toBeVisible()

    await providerDropdown.click()
    await pebblePage.getByRole('menuitem', { name: 'Codex', exact: true }).click()
    await expect(pebblePage.getByRole('heading', { name: 'Codex Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute('aria-label', 'Usage analytics provider: Codex')

    await providerDropdown.click()
    await pebblePage.getByRole('menuitem', { name: 'OpenCode', exact: true }).click()
    await expect(pebblePage.getByRole('heading', { name: 'OpenCode Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: OpenCode'
    )
  })
})
