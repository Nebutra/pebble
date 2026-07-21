import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@nebutra/playwright-test'
import { expect, test } from './helpers/pebble-app'
import { waitForSessionReady } from './helpers/store'

const outputDirectory = process.env.PEBBLE_ELECTRON_RUNTIME_SURFACE_DIR
const repoPath = process.env.PEBBLE_RUNTIME_PARITY_REPO_PATH
const browserUrl = process.env.PEBBLE_RUNTIME_PARITY_BROWSER_URL

test.use({ seedTestRepo: false })

test('captures real Electron runtime surfaces', async ({ electronApp, pebblePage }) => {
  test.skip(!outputDirectory || !repoPath || !browserUrl, 'runtime parity fixture is required')
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) {
      throw new Error('Electron parity window is unavailable')
    }
    window.setContentSize(1200, 800)
  })
  await waitForSessionReady(pebblePage)
  await pinProviderPath(electronApp)
  const context = await pebblePage.evaluate(async (fixtureRepo) => {
    const store = window.__store
    if (!store) {
      throw new Error('renderer store is unavailable')
    }
    store.getState().closeSettingsPage()
    store.getState().setActiveView('terminal')
    store.setState((current) => ({
      settings: current.settings
        ? {
            ...current.settings,
            floatingTerminalEnabled: false,
            showMobileButton: false,
            terminalGpuAcceleration: 'off',
            terminalQuickCommands: [],
            theme: 'light'
          }
        : current.settings,
      setupGuideSidebarDismissed: true
    }))
    const repo = await store.getState().addRepoPath(fixtureRepo)
    if (!repo) {
      throw new Error('fixture repository import failed')
    }
    await store.getState().fetchWorktrees(repo.id, { requireAuthoritative: true })
    const worktree = store.getState().worktreesByRepo[repo.id]?.[0]
    if (!worktree) {
      throw new Error('fixture repository produced no worktree')
    }
    store.getState().setActiveWorktree(worktree.id)
    const tab =
      store.getState().tabsByWorktree[worktree.id]?.[0] ??
      store.getState().createTab(worktree.id, undefined, undefined, { recordInteraction: false })
    store.getState().setActiveTab(tab.id)
    store.getState().setActiveTabType('terminal')
    store.getState().setRightSidebarTab('explorer')
    store.getState().setRightSidebarOpen(false)
    return {
      repoId: repo.id,
      repoPath: repo.path,
      worktreeId: worktree.id,
      terminalTabId: tab.id
    }
  }, repoPath!)

  await expect(pebblePage.locator('[data-pty-id]')).toBeVisible()
  // Why: xterm mounts before the shell has painted its prompt. Capturing that
  // intermediate frame makes the cross-shell pixel gate timing-dependent.
  await expect(pebblePage.locator('.xterm-rows')).toContainText('repo', { timeout: 30_000 })
  await capture(pebblePage, 'terminal')

  await pebblePage.evaluate(
    ({ worktreeId, url }) => window.__store?.getState().createBrowserTab(worktreeId, url, {
      title: 'Native browser gate',
      activate: true
    }),
    { worktreeId: context.worktreeId, url: browserUrl! }
  )
  await expect(pebblePage.locator('webview')).toBeVisible()
  await capture(pebblePage, 'browser')

  await pebblePage.evaluate(({ terminalTabId }) => {
    const state = window.__store?.getState()
    state?.setActiveTab(terminalTabId)
    state?.setActiveTabType('terminal')
    state?.setRightSidebarTab('source-control')
    state?.setRightSidebarOpen(true)
  }, context)
  await expect(pebblePage.locator('[data-parity-surface="source-control"]')).toBeVisible()
  await expect(pebblePage.locator('[data-testid="source-control-entry"]').first()).toBeVisible()
  await capture(pebblePage, 'source-control')

  await pinProviderPath(electronApp)
  await pebblePage.evaluate(async ({ repoId, worktreeId, repoPath }) => {
    const store = window.__store
    if (!store) {
      return
    }
    store.setState((current) => ({
      worktreesByRepo: {
        ...current.worktreesByRepo,
        [repoId]: (current.worktreesByRepo[repoId] ?? []).map((worktree) =>
          worktree.id === worktreeId ? { ...worktree, linkedPR: 128 } : worktree
        )
      }
    }))
    const parsedChecks = await window.api.gh.prChecks({ repoId, repoPath, prNumber: 128 })
    if (!parsedChecks.some((check) => check.name === 'Pebble Linux')) {
      throw new Error('Electron provider checks did not survive the CLI parser')
    }
    const review = {
      number: 128,
      title: 'Provider-backed checks gate',
      state: 'open' as const,
      url: 'https://github.com/nebutra/pebble/pull/128',
      checksStatus: 'pending' as const,
      updatedAt: '2026-07-18T00:00:00Z',
      mergeable: 'MERGEABLE' as const,
      headSha: '0123456789abcdef0123456789abcdef01234567',
      baseRefName: 'main',
      prRepo: { owner: 'nebutra', repo: 'pebble' }
    }
    store.setState((current) => ({
      prCache: {
        ...current.prCache,
        [`${repoId}::main`]: { data: review, fetchedAt: Date.now() }
      }
    }))
    await store
      .getState()
      .fetchPRChecks(repoPath, 128, 'main', review.headSha, review.prRepo, { repoId, force: true })
    store.getState().setRightSidebarTab('checks')
  }, context)
  await expect(pebblePage.getByText('Pebble Linux')).toBeVisible({ timeout: 30_000 })
  await capture(pebblePage, 'checks')
})

async function pinProviderPath(electronApp: ElectronApplication) {
  const providerPath = process.env.PATH
  if (!providerPath) {
    throw new Error('runtime parity provider PATH is unavailable')
  }
  await electronApp.evaluate((_electron, pathValue) => {
    // Why: packaged Electron hydrates the login-shell PATH asynchronously;
    // parity fixtures must remain first after that production startup probe.
    process.env.PATH = pathValue
  }, providerPath)
}

async function capture(pebblePage: Parameters<typeof waitForSessionReady>[0], surface: string) {
  await pebblePage.evaluate(() => document.fonts.ready)
  await pebblePage.evaluate(() =>
    document.querySelectorAll('[data-sonner-toast]').forEach((toast) => toast.remove())
  )
  await pebblePage.evaluate(() =>
    document
      .querySelectorAll('[data-radix-popper-content-wrapper]')
      .forEach((popover) => popover.remove())
  )
  await pebblePage.evaluate(() =>
    document.querySelector('[data-contextual-tour-target="setup-guide-entry"]')?.remove()
  )
  mkdirSync(outputDirectory!, { recursive: true })
  const output = path.join(outputDirectory!, `electron-${surface}.png`)
  await pebblePage.screenshot({ path: output, animations: 'disabled' })
  writeFileSync(`${output}.ready`, 'ready\n')
}
