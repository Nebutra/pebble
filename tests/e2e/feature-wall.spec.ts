import { test, expect } from './helpers/pebble-app'
import { getStoreState, waitForSessionReady } from './helpers/store'
import type { ElectronApplication } from '@nebutra/playwright-test'

async function openFeatureTourFromMenu(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow, Menu }) => {
    const featureTourItem = Menu.getApplicationMenu()
      ?.items.find((item) => item.label === 'Help')
      ?.submenu?.items.find((item) => item.label === 'Explore Pebble')

    if (!featureTourItem) {
      throw new Error('Explore Pebble menu item was not registered')
    }

    const window = BrowserWindow.getAllWindows()[0]
    featureTourItem.click(featureTourItem, window, {
      triggeredByAccelerator: false,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false
    } as Electron.KeyboardEvent)
  })
}

test.describe('Feature tour modal', () => {
  test.beforeEach(async ({ pebblePage }) => {
    await waitForSessionReady(pebblePage)
  })

  test('opens from the Help menu and renders the workflow rail', async ({
    electronApp,
    pebblePage
  }) => {
    await openFeatureTourFromMenu(electronApp)

    await expect(pebblePage.getByRole('dialog', { name: 'Get to know Pebble' })).toBeVisible({
      timeout: 10_000
    })
    await expect(pebblePage.getByText('Reopen any time from Help > Explore Pebble.')).toBeVisible()

    // Five workflow rows in the rail.
    const rail = pebblePage.getByRole('navigation', { name: 'Workflows' })
    await expect(rail.getByRole('tab')).toHaveCount(5)
    await expect(rail.getByRole('tab', { name: /Workspaces/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await expect(pebblePage.locator('[data-ws-id]')).toHaveCount(3)

    // ArrowDown moves selection through the rail.
    await rail.getByRole('tab', { name: /Workspaces/i }).focus()
    await pebblePage.keyboard.press('ArrowDown')
    await expect(rail.getByRole('tab', { name: /Tasks/i })).toHaveAttribute('aria-selected', 'true')
    await pebblePage.keyboard.press('ArrowDown')
    await expect(rail.getByRole('tab', { name: /Agents/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await rail.getByRole('tab', { name: /Workbench/i }).click()
    await rail.getByRole('button', { name: /Browser/i }).click()
    await expect(
      pebblePage.getByText(
        "Run your app in Pebble's browser, send selected UI elements to agents, and let your agents interact with your webpage."
      )
    ).toBeVisible()
    await expect(pebblePage.getByRole('heading', { name: 'Browser Use skill' })).toBeVisible()
    await expect(
      pebblePage.getByText("Enables agents to navigate and verify pages in Pebble's browser.")
    ).toBeVisible()
    await expect(pebblePage.getByRole('heading', { name: 'CLI skill' })).toHaveCount(0)
    await expect(pebblePage.getByText('With the Pebble CLI skill', { exact: false })).toHaveCount(0)
  })

  test('shows unified task copy without leaving the walkthrough', async ({ pebblePage }) => {
    await pebblePage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.setState({
        preflightStatus: {
          git: { installed: true },
          gh: { installed: true, authenticated: false },
          glab: { installed: false, authenticated: false },
          bitbucket: { configured: false, authenticated: false, account: null },
          azureDevOps: {
            configured: false,
            authenticated: false,
            account: null,
            baseUrl: null,
            tokenConfigured: false
          },
          gitea: {
            configured: false,
            authenticated: false,
            account: null,
            baseUrl: null,
            tokenConfigured: false
          }
        },
        preflightStatusChecked: true,
        preflightStatusLoading: false,
        linearStatus: { connected: false, viewer: null },
        linearStatusChecked: true
      })
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    await expect(pebblePage.getByRole('dialog', { name: 'Get to know Pebble' })).toBeVisible({
      timeout: 10_000
    })
    await pebblePage
      .getByRole('navigation', { name: 'Workflows' })
      .getByRole('tab', { name: /Tasks/i })
      .click()
    await expect(pebblePage.getByText('Start work directly from GitHub or Linear.')).toBeVisible()
    await expect(pebblePage.getByText('Connect GitHub or Linear once')).toHaveCount(0)
    await expect(pebblePage.getByRole('dialog', { name: 'Get to know Pebble' })).toBeVisible()
    await expect
      .poll(async () => getStoreState<string>(pebblePage, 'activeView'))
      .not.toBe('settings')
  })

  test('continue advances through workflow substeps before the next workflow', async ({
    pebblePage
  }) => {
    await pebblePage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    const rail = pebblePage.getByRole('navigation', { name: 'Workflows' })
    const continueButton = pebblePage.getByRole('button', { name: /^Continue/ })

    await continueButton.click()
    await expect(rail.getByRole('tab', { name: /Tasks/i })).toHaveAttribute('aria-selected', 'true')

    await continueButton.click()
    await expect(rail.getByRole('tab', { name: /Agents/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(rail.getByRole('button', { name: /Visibility/i })).toHaveAttribute(
      'aria-current',
      'step'
    )

    await continueButton.click()
    await expect(rail.getByRole('button', { name: /Orchestration/i })).toHaveAttribute(
      'aria-current',
      'step'
    )
    await expect(rail.getByRole('tab', { name: /Workbench/i })).toHaveAttribute(
      'aria-selected',
      'false'
    )

    await continueButton.click()
    await expect(rail.getByRole('button', { name: /Usage/i })).toHaveAttribute(
      'aria-current',
      'step'
    )

    await continueButton.click()
    await expect(rail.getByRole('tab', { name: /Workbench/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(rail.getByRole('button', { name: /Terminal/i })).toHaveAttribute(
      'aria-current',
      'step'
    )
  })

  test('does not pre-check configured workflows until the user visits them', async ({
    pebblePage
  }) => {
    await pebblePage.evaluate(() => {
      for (const key of [
        'pebble.featureWall.visitedWorkflows.v1',
        'pebble.featureWall.visitedAgentSteps.v1',
        'pebble.featureWall.visitedWorkbenchSteps.v1',
        'pebble.featureWall.visitedReviewSteps.v1',
        'pebble.featureWall.completedWorkflows.v1',
        'pebble.featureWall.completedAgentSteps.v1',
        'pebble.featureWall.completedWorkbenchSteps.v1',
        'pebble.featureWall.completedReviewSteps.v1'
      ]) {
        localStorage.removeItem(key)
      }
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.setState({
        preflightStatus: {
          git: { installed: true },
          gh: { installed: true, authenticated: true },
          glab: { installed: false, authenticated: false },
          bitbucket: { configured: false, authenticated: false, account: null },
          azureDevOps: {
            configured: false,
            authenticated: false,
            account: null,
            baseUrl: null,
            tokenConfigured: false
          },
          gitea: {
            configured: false,
            authenticated: false,
            account: null,
            baseUrl: null,
            tokenConfigured: false
          }
        },
        preflightStatusChecked: true,
        preflightStatusLoading: false,
        linearStatus: { connected: false, viewer: null },
        linearStatusChecked: true
      })
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    const rail = pebblePage.getByRole('navigation', { name: 'Workflows' })
    const workspacesTab = rail.locator('[data-feature-wall-workflow-id="workspaces"]')
    const tasksTab = rail.locator('[data-feature-wall-workflow-id="tasks"]')
    await expect(workspacesTab.locator('[aria-label="Completed"]')).toHaveCount(1)
    await expect(tasksTab.locator('[aria-label="Completed"]')).toHaveCount(0)
    await tasksTab.click()
    await expect(tasksTab.locator('[aria-label="Completed"]')).toHaveCount(1)
    await expect(workspacesTab.locator('[aria-label="Completed"]')).toHaveCount(1)
  })

  test('keeps persisted completed setup-backed substeps checked when reopened', async ({
    pebblePage
  }) => {
    await pebblePage.evaluate(() => {
      localStorage.setItem(
        'pebble.featureWall.completedAgentSteps.v1',
        JSON.stringify(['orchestration'])
      )
      localStorage.setItem(
        'pebble.featureWall.completedWorkbenchSteps.v1',
        JSON.stringify(['browser'])
      )
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    const rail = pebblePage.getByRole('navigation', { name: 'Workflows' })

    await rail.getByRole('tab', { name: /Agents/i }).click()
    await expect(
      rail.getByRole('button', { name: /Orchestration/i }).locator('[aria-label="Completed"]')
    ).toHaveCount(1)

    await rail.getByRole('tab', { name: /Workbench/i }).click()
    await expect(
      rail.getByRole('button', { name: /Browser/i }).locator('[aria-label="Completed"]')
    ).toHaveCount(1)
  })
})
