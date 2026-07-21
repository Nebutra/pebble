import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/pebble-app'
import { waitForSessionReady } from './helpers/store'

async function normalizeParityPage(pebblePage: Parameters<typeof waitForSessionReady>[0]) {
  await pebblePage.evaluate(() => document.fonts.ready)
  await pebblePage.evaluate(() => {
    // Why: parity compares renderer output, not machine-specific onboarding,
    // host, and application persistence from each isolated test profile.
    const style = document.createElement('style')
    style.textContent = '[data-parity-volatile]{display:none!important}'
    document.head.append(style)
    document.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((node) => node.remove())
    for (const input of document.querySelectorAll('input')) {
      if (input.value.includes('/pebble/workspaces')) {
        // Why: approved pixel baselines must not encode the capture machine's home directory.
        input.value = '~/pebble/workspaces'
      }
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  })
}

async function writeCapture(
  pebblePage: Parameters<typeof waitForSessionReady>[0],
  output: string
) {
  const viewport = await pebblePage.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))
  mkdirSync(path.dirname(output), { recursive: true })
  await pebblePage.screenshot({ path: output, animations: 'disabled' })
  writeFileSync(`${output}.viewport.json`, `${JSON.stringify(viewport, null, 2)}\n`)
  writeFileSync(`${output}.ready`, 'ready\n')
}

async function prepareUpdateSurface(pebblePage: Parameters<typeof waitForSessionReady>[0]) {
  await pebblePage.evaluate(() => {
    const state = {
      activeModal: 'none',
      activeView: 'terminal',
      activeWorktreeId: null,
      dismissedUpdateVersion: null,
      folderWorkspaces: [],
      projects: [],
      projectGroups: [],
      repos: [],
      rightSidebarOpen: false,
      settingsPageOpen: false,
      updateCardCollapsed: false,
      updateChangelog: null,
      updateReassuranceSeen: true,
      worktreesByRepo: {},
      updateStatus: {
        state: 'available',
        version: '1.4.128',
        releaseUrl: 'https://github.com/nebutra/pebble/releases/tag/v1.4.128',
        changelog: null
      }
    }
    window.__store?.setState(state)
    // Why: native updater and startup hydration can publish after the lazy card
    // mounts. Keep this short-lived parity page pinned until its screenshot.
    window.setInterval(() => window.__store?.setState(state), 25)
  })
}

test('captures the canonical Electron Landing reference', async ({ pebblePage }) => {
  const output = process.env.PEBBLE_ELECTRON_LANDING_PARITY_CAPTURE_PATH
  test.skip(!output, 'PEBBLE_ELECTRON_LANDING_PARITY_CAPTURE_PATH is required by the release gate')
  await waitForSessionReady(pebblePage)
  await pebblePage.evaluate(() => {
    window.__store?.setState({
      activeModal: 'none',
      activeView: 'terminal',
      activeWorktreeId: null,
      folderWorkspaces: [],
      projects: [],
      projectGroups: [],
      repos: [],
      rightSidebarOpen: false,
      settingsPageOpen: false,
      worktreesByRepo: {}
    })
  })
  await expect(pebblePage.locator('[data-parity-surface="landing"]')).toBeVisible()
  await normalizeParityPage(pebblePage)
  await writeCapture(pebblePage, output!)
})

test('captures the canonical Electron Update reference', async ({ pebblePage }) => {
  const output = process.env.PEBBLE_ELECTRON_UPDATE_PARITY_CAPTURE_PATH
  test.skip(!output, 'PEBBLE_ELECTRON_UPDATE_PARITY_CAPTURE_PATH is required by the release gate')
  await waitForSessionReady(pebblePage)
  await prepareUpdateSurface(pebblePage)
  await expect(pebblePage.locator('[data-parity-surface="update"]')).toBeVisible()
  await normalizeParityPage(pebblePage)
  await writeCapture(pebblePage, output!)
})

test('captures the canonical Electron Crash Report reference', async ({ pebblePage }) => {
  const output = process.env.PEBBLE_ELECTRON_CRASH_PARITY_CAPTURE_PATH
  test.skip(!output, 'PEBBLE_ELECTRON_CRASH_PARITY_CAPTURE_PATH is required by the release gate')
  await waitForSessionReady(pebblePage)
  await pebblePage.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('pebble:open-crash-report-dialog', { detail: { loadLatest: false } })
    )
  )
  await expect(pebblePage.locator('[data-parity-surface="crash"]')).toBeVisible()
  await normalizeParityPage(pebblePage)
  await writeCapture(pebblePage, output!)
})

test('captures the canonical Electron Settings reference', async ({ pebblePage }) => {
  const output = process.env.PEBBLE_ELECTRON_PARITY_CAPTURE_PATH
  test.skip(!output, 'PEBBLE_ELECTRON_PARITY_CAPTURE_PATH is required by the release gate')
  await waitForSessionReady(pebblePage)
  await pebblePage.evaluate(() => window.__store?.getState().openSettingsPage())
  await expect(
    pebblePage.locator('[data-settings-overlay][aria-hidden="false"]:not([data-tauri-drag-region])')
  ).toBeVisible()
  await expect(pebblePage.locator('[data-settings-loading]')).toHaveCount(0)
  await normalizeParityPage(pebblePage)
  await writeCapture(pebblePage, output!)
})
