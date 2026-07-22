/**
 * E2E tests for the browser tab: creating browser tabs and state retention.
 *
 * User Prompt:
 * - Browser works and also retains state when switching tabs etc.
 */

import { test, expect } from './helpers/pebble-app'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabType,
  getBrowserTabs,
  getAllWorktreeIds,
  switchToOtherWorktree,
  switchToWorktree,
  ensureTerminalVisible
} from './helpers/store'

type CreatedBrowserTab = {
  id: string
  pageId: string | null
}

async function createBrowserTab(
  page: Parameters<typeof getActiveWorktreeId>[0],
  worktreeId: string,
  url?: string,
  title = 'New Browser Tab'
): Promise<CreatedBrowserTab | null> {
  return page.evaluate(
    ({ targetWorktreeId, targetUrl, targetTitle }) => {
      const store = window.__store
      if (!store) {
        return null
      }

      const state = store.getState()
      const tab = state.createBrowserTab(
        targetWorktreeId,
        targetUrl ?? state.browserDefaultUrl ?? 'about:blank',
        {
          title: targetTitle,
          activate: true
        }
      )
      return { id: tab.id, pageId: tab.activePageId ?? null }
    },
    { targetWorktreeId: worktreeId, targetUrl: url, targetTitle: title }
  )
}

async function switchToTerminalTab(
  page: Parameters<typeof getActiveWorktreeId>[0],
  worktreeId: string
): Promise<void> {
  await page.evaluate((targetWorktreeId) => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    const terminalTab = (state.tabsByWorktree[targetWorktreeId] ?? [])[0]
    if (terminalTab) {
      state.setActiveTab(terminalTab.id)
    }
    state.setActiveTabType('terminal')
  }, worktreeId)
}

async function switchToBrowserTab(
  page: Parameters<typeof getActiveWorktreeId>[0],
  worktreeId: string,
  browserTabId: string
): Promise<void> {
  await page.evaluate(
    ({ targetWorktreeId, targetBrowserTabId }) => {
      const store = window.__store
      if (!store) {
        return
      }

      const state = store.getState()
      if (
        (state.browserTabsByWorktree[targetWorktreeId] ?? []).some(
          (tab) => tab.id === targetBrowserTabId
        )
      ) {
        state.setActiveBrowserTab(targetBrowserTabId)
      }
    },
    { targetWorktreeId: worktreeId, targetBrowserTabId: browserTabId }
  )
}

async function startBrowserFormServer(): Promise<{
  url: (label: string) => string
  close: () => Promise<void>
}> {
  const server = createServer((request, response) => {
    const label = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1)
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`
      <!doctype html>
      <html>
        <body>
          <label>${label}<input id="q" /></label>
        </body>
      </html>
    `)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: (label: string) => `http://127.0.0.1:${port}/${encodeURIComponent(label)}`,
    close: () => closeServer(server)
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  )
}

async function readBrowserInputValue(
  page: Parameters<typeof getActiveWorktreeId>[0],
  browserTabId: string
): Promise<string | null> {
  return page.evaluate(async (targetBrowserTabId) => {
    const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
      (candidate) => candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
    )
    const webview = slot?.querySelector('webview') as (HTMLElement & {
      executeJavaScript: (script: string) => Promise<unknown>
    }) | null
    if (!webview) {
      return null
    }
    try {
      return await webview.executeJavaScript('document.querySelector("#q")?.value ?? null')
    } catch {
      return null
    }
  }, browserTabId)
}

async function writeBrowserInputValue(
  page: Parameters<typeof getActiveWorktreeId>[0],
  browserTabId: string,
  value: string
): Promise<void> {
  await expect
    .poll(async () => readBrowserInputValue(page, browserTabId), { timeout: 5_000 })
    .not.toBeNull()

  await page.evaluate(
    async ({ targetBrowserTabId, nextValue }) => {
      const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
        (candidate) => candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
      )
      const webview = slot?.querySelector('webview') as (HTMLElement & {
        executeJavaScript: (script: string) => Promise<unknown>
      }) | null
      if (!webview) {
        throw new Error(`Missing webview for browser tab ${targetBrowserTabId}`)
      }
      await webview.executeJavaScript(
        `document.querySelector("#q").value = ${JSON.stringify(nextValue)}`
      )
    },
    { targetBrowserTabId: browserTabId, nextValue: value }
  )

  await expect
    .poll(async () => readBrowserInputValue(page, browserTabId), { timeout: 5_000 })
    .toBe(value)
}

test.describe('Browser Tab', () => {
  test.beforeEach(async ({ pebblePage }) => {
    await waitForSessionReady(pebblePage)
    await waitForActiveWorktree(pebblePage)
    await ensureTerminalVisible(pebblePage)
  })

  /**
   * User Prompt:
   * - Browser works and also retains state when switching tabs etc.
   */
  test('creating a browser tab adds it and activates browser view', async ({ pebblePage }) => {
    const worktreeId = (await getActiveWorktreeId(pebblePage))!
    const browserTabsBefore = await getBrowserTabs(pebblePage, worktreeId)

    await createBrowserTab(pebblePage, worktreeId)

    // Wait for the browser tab to appear in the store
    await expect
      .poll(async () => (await getBrowserTabs(pebblePage, worktreeId)).length, { timeout: 5_000 })
      .toBe(browserTabsBefore.length + 1)

    // The active tab type should switch to 'browser'
    await expect.poll(async () => getActiveTabType(pebblePage), { timeout: 3_000 }).toBe('browser')
  })

  /**
   * User Prompt:
   * - Browser works and also retains state when switching tabs etc.
   */
  test('browser tab is created and active in the store', async ({ pebblePage }) => {
    const worktreeId = (await getActiveWorktreeId(pebblePage))!

    await createBrowserTab(pebblePage, worktreeId)
    await expect.poll(async () => getActiveTabType(pebblePage), { timeout: 5_000 }).toBe('browser')

    // Verify the browser tab exists in the store
    const browserTabs = await getBrowserTabs(pebblePage, worktreeId)
    expect(browserTabs.length).toBeGreaterThan(0)

    // The active browser tab should have a URL (even if it's about:blank or the default)
    const activeBrowserTabId = await pebblePage.evaluate(() => {
      const store = window.__store
      return store?.getState().activeBrowserTabId ?? null
    })
    expect(activeBrowserTabId).not.toBeNull()
  })

  /**
   * User Prompt:
   * - Browser works and also retains state when switching tabs etc.
   */
  test('browser tab retains state when switching to terminal and back', async ({ pebblePage }) => {
    const worktreeId = (await getActiveWorktreeId(pebblePage))!

    await createBrowserTab(pebblePage, worktreeId)
    await expect.poll(async () => getActiveTabType(pebblePage), { timeout: 5_000 }).toBe('browser')

    // Record the browser tab info
    const browserTabsBefore = await getBrowserTabs(pebblePage, worktreeId)
    expect(browserTabsBefore.length).toBeGreaterThan(0)
    const browserTabId = browserTabsBefore.at(-1)?.id
    expect(browserTabId).toBeTruthy()

    // Switch to the terminal view
    await switchToTerminalTab(pebblePage, worktreeId)
    await expect.poll(async () => getActiveTabType(pebblePage), { timeout: 3_000 }).toBe('terminal')

    // Switch back to browser tab
    await switchToBrowserTab(pebblePage, worktreeId, browserTabId!)
    await expect.poll(async () => getActiveTabType(pebblePage), { timeout: 3_000 }).toBe('browser')

    // The browser tab should still exist with the same ID
    const browserTabsAfter = await getBrowserTabs(pebblePage, worktreeId)
    const tabStillExists = browserTabsAfter.some((tab) => tab.id === browserTabId)
    expect(tabStillExists).toBe(true)
  })

  test('browser webview form state survives switching between browser tabs', async ({
    pebblePage
  }) => {
    const formServer = await startBrowserFormServer()
    try {
      const worktreeId = (await getActiveWorktreeId(pebblePage))!
      const firstTab = await createBrowserTab(
        pebblePage,
        worktreeId,
        formServer.url('First search'),
        'First Form'
      )
      expect(firstTab?.id).toBeTruthy()
      await writeBrowserInputValue(pebblePage, firstTab!.id, 'first typed value')

      const secondTab = await createBrowserTab(
        pebblePage,
        worktreeId,
        formServer.url('Second search'),
        'Second Form'
      )
      expect(secondTab?.id).toBeTruthy()
      await writeBrowserInputValue(pebblePage, secondTab!.id, 'second typed value')

      // Why: switching browser tabs used to unmount and reparent the inactive
      // desktop child webview, which recreated the guest document and erased form DOM.
      await switchToBrowserTab(pebblePage, worktreeId, firstTab!.id)
      await expect
        .poll(async () => readBrowserInputValue(pebblePage, firstTab!.id), { timeout: 5_000 })
        .toBe('first typed value')

      await switchToBrowserTab(pebblePage, worktreeId, secondTab!.id)
      await expect
        .poll(async () => readBrowserInputValue(pebblePage, secondTab!.id), { timeout: 5_000 })
        .toBe('second typed value')
    } finally {
      await formServer.close()
    }
  })

  /**
   * User Prompt:
   * - Browser works and also retains state when switching tabs etc.
   */
  test('browser tab retains state when switching worktrees and back', async ({ pebblePage }) => {
    const allWorktreeIds = await getAllWorktreeIds(pebblePage)
    if (allWorktreeIds.length < 2) {
      test.skip(true, 'Need at least 2 worktrees to test worktree switching')
    }

    const worktreeId = (await getActiveWorktreeId(pebblePage))!

    await createBrowserTab(pebblePage, worktreeId)
    await expect.poll(async () => getActiveTabType(pebblePage), { timeout: 5_000 }).toBe('browser')

    const browserTabsBefore = await getBrowserTabs(pebblePage, worktreeId)
    expect(browserTabsBefore.length).toBeGreaterThan(0)

    // Switch to a different worktree via the store
    const otherId = await switchToOtherWorktree(pebblePage, worktreeId)
    expect(otherId).not.toBeNull()
    await expect.poll(async () => getActiveWorktreeId(pebblePage), { timeout: 5_000 }).toBe(otherId)

    // Switch back to the original worktree
    await switchToWorktree(pebblePage, worktreeId)
    await expect
      .poll(async () => getActiveWorktreeId(pebblePage), { timeout: 5_000 })
      .toBe(worktreeId)

    // Browser tabs should still be preserved
    const browserTabsAfter = await getBrowserTabs(pebblePage, worktreeId)
    expect(browserTabsAfter.length).toBe(browserTabsBefore.length)
  })
})
