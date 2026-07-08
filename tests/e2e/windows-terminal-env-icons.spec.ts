import { test, expect } from './helpers/pebble-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

test.describe('Windows terminal env and shell identity', () => {
  test.beforeEach(async ({ pebblePage }) => {
    await waitForSessionReady(pebblePage)
    await waitForActiveWorktree(pebblePage)
    await ensureTerminalVisible(pebblePage)
  })

  test('dev terminal preserves parent PATH so PATH commands resolve', async ({ pebblePage }) => {
    await waitForActiveTerminalManager(pebblePage)

    const ptyId = await waitForActivePanePtyId(pebblePage)
    const marker = `__PEBBLE_E2E_NODE_PATH_${Date.now()}__`

    // Why: before the dev PATH fallback, daemon-spawned PTYs could get PATH set
    // to only Pebble's dev CLI bin. A real terminal command catches that failure.
    await execInTerminal(pebblePage, ptyId, `node -e "console.log('${marker}')"`)

    await waitForTerminalOutput(pebblePage, marker, 15_000)
  })

  test('Windows tab icons stay pinned to the shell used at tab creation', async ({ pebblePage }) => {
    test.skip(process.platform !== 'win32', 'Windows shell icons only render on Windows')

    const tabIds = await pebblePage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const state = store.getState()
      const worktreeId = state.activeWorktreeId
      if (!worktreeId) {
        throw new Error('No active worktree')
      }

      store.setState({
        settings: { ...state.settings!, terminalWindowsShell: 'wsl.exe' }
      })
      const wslTab = store.getState().createTab(worktreeId, undefined, undefined, {
        activate: false
      })

      store.setState({
        settings: { ...store.getState().settings!, terminalWindowsShell: 'cmd.exe' }
      })
      const cmdTab = store.getState().createTab(worktreeId, undefined, undefined, {
        activate: false
      })

      return { wslTabId: wslTab.id, cmdTabId: cmdTab.id }
    })

    const tabSnapshot = await pebblePage.evaluate(({ wslTabId, cmdTabId }) => {
      const state = window.__store!.getState()
      const tabs = Object.values(state.tabsByWorktree).flat()
      return {
        wslShell: tabs.find((tab) => tab.id === wslTabId)?.shellOverride,
        cmdShell: tabs.find((tab) => tab.id === cmdTabId)?.shellOverride
      }
    }, tabIds)

    expect(tabSnapshot).toEqual({
      wslShell: 'wsl.exe',
      cmdShell: 'cmd.exe'
    })

    const wslTab = pebblePage.locator(
      `[data-testid="sortable-tab"][data-tab-id="${tabIds.wslTabId}"]`
    )
    const cmdTab = pebblePage.locator(
      `[data-testid="sortable-tab"][data-tab-id="${tabIds.cmdTabId}"]`
    )
    await expect(wslTab).toBeVisible()
    await expect(cmdTab).toBeVisible()

    await expect(wslTab.locator('[data-shell-icon]')).toHaveAttribute('data-shell-icon', 'wsl.exe')
    await expect(cmdTab.locator('[data-shell-icon]')).toHaveAttribute('data-shell-icon', 'cmd.exe')
  })
})
