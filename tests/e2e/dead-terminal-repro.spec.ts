/**
 * Stress test for dead-terminal reproduction (setup-split flow).
 *
 * This renderer regression targets WebGL canvas staleness after
 * wrapInSplit() reparents the existing pane's container, the WebGL canvas can
 * fail to repaint. The browser project records supporting renderer evidence;
 * native window evidence remains owned by the Tauri runtime gate.
 *
 * See helpers/dead-terminal.ts for the shared worktree-creation helper that
 * replicates the exact activateAndRevealWorktree + ensureWorktreeHasInitialTerminal
 * production flow.
 */

import { test, expect } from './helpers/pebble-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  switchToWorktree,
  ensureTerminalVisible
} from './helpers/store'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import {
  createAndActivateWorktreeWithSetup,
  removeWorktreeViaStore,
  waitForAllPanesToHaveContent,
  checkWebglState
} from './helpers/dead-terminal'

const STRESS_ITERATIONS = 5

test.describe('Dead Terminal Reproduction renderer evidence', () => {
  const createdWorktreeIds: string[] = []

  test.beforeEach(async ({ pebblePage }) => {
    await waitForSessionReady(pebblePage)
    await waitForActiveWorktree(pebblePage)
    await ensureTerminalVisible(pebblePage)

    await pebblePage.evaluate(async () => {
      const state = window.__store?.getState()
      if (!state) {
        return
      }
      state.updateSettings({ setupScriptLaunchMode: 'split-vertical' })
    })
  })

  test.afterEach(async ({ pebblePage }) => {
    for (const id of createdWorktreeIds) {
      await removeWorktreeViaStore(pebblePage, id)
    }
    createdWorktreeIds.length = 0
  })

  test('setup-split flow does not produce dead terminals', async ({ pebblePage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(pebblePage)
    await waitForActiveTerminalManager(pebblePage, 30_000)
    await checkWebglState(pebblePage, 'home-initial')

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const direction = i % 2 === 0 ? 'vertical' : 'horizontal'
      const newId = await createAndActivateWorktreeWithSetup(pebblePage, `setup-${i}`, direction)
      createdWorktreeIds.push(newId)

      await expect
        .poll(async () => getActiveWorktreeId(pebblePage), { timeout: 10_000 })
        .toBe(newId)
      await ensureTerminalVisible(pebblePage)
      await waitForActiveTerminalManager(pebblePage, 30_000)
      await waitForPaneCount(pebblePage, 2, 15_000)
      await checkWebglState(pebblePage, `setup-${i}`)
      await waitForAllPanesToHaveContent(pebblePage, `setup-${i} both panes`)

      await switchToWorktree(pebblePage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(pebblePage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(pebblePage, newId)
      createdWorktreeIds.pop()
    }
  })

  test('setup-split then switch-back does not leave panes dead', async ({ pebblePage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(pebblePage)
    await waitForActiveTerminalManager(pebblePage, 30_000)

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const newId = await createAndActivateWorktreeWithSetup(
        pebblePage,
        `switchback-${i}`,
        'vertical'
      )
      createdWorktreeIds.push(newId)

      await expect
        .poll(async () => getActiveWorktreeId(pebblePage), { timeout: 10_000 })
        .toBe(newId)
      await ensureTerminalVisible(pebblePage)
      await waitForActiveTerminalManager(pebblePage, 30_000)
      await waitForPaneCount(pebblePage, 2, 15_000)
      await waitForAllPanesToHaveContent(pebblePage, `switchback-${i} initial`)

      await switchToWorktree(pebblePage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(pebblePage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await ensureTerminalVisible(pebblePage)
      await waitForActiveTerminalManager(pebblePage, 15_000)

      await switchToWorktree(pebblePage, newId)
      await expect
        .poll(async () => getActiveWorktreeId(pebblePage), { timeout: 10_000 })
        .toBe(newId)
      await ensureTerminalVisible(pebblePage)
      await waitForActiveTerminalManager(pebblePage, 15_000)
      await waitForAllPanesToHaveContent(pebblePage, `switchback-${i} after return`)

      await switchToWorktree(pebblePage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(pebblePage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(pebblePage, newId)
      createdWorktreeIds.pop()
    }
  })

  test('rapid switching between many setup-split worktrees', async ({ pebblePage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(pebblePage)
    await waitForActiveTerminalManager(pebblePage, 30_000)

    const worktreeIds = [homeWorktreeId]
    for (let i = 0; i < 4; i++) {
      const newId = await createAndActivateWorktreeWithSetup(pebblePage, `multi-${i}`, 'vertical')
      createdWorktreeIds.push(newId)
      worktreeIds.push(newId)

      await expect
        .poll(async () => getActiveWorktreeId(pebblePage), { timeout: 10_000 })
        .toBe(newId)
      await ensureTerminalVisible(pebblePage)
      await waitForActiveTerminalManager(pebblePage, 30_000)
      await waitForPaneCount(pebblePage, 2, 15_000)
      await waitForAllPanesToHaveContent(pebblePage, `multi-create-${i}`)
    }

    for (let round = 0; round < 3; round++) {
      for (const wId of worktreeIds) {
        await switchToWorktree(pebblePage, wId)
        await expect
          .poll(async () => getActiveWorktreeId(pebblePage), { timeout: 10_000 })
          .toBe(wId)
        await ensureTerminalVisible(pebblePage)
        await waitForActiveTerminalManager(pebblePage, 15_000)
        await waitForAllPanesToHaveContent(pebblePage, `multi-r${round}-${wId.slice(0, 8)}`)
      }
    }
  })
})
