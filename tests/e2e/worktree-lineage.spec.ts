import type { Page } from '@playwright/test'
import { test, expect } from './helpers/pebble-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  markWorkspaceTerminalSlept,
  seedLineageScenario,
  seedWorkspaceAgentStatus,
  seedWorkspaceLiveTerminal
} from './worktree-lineage-state'
import { worktreeRow } from './worktree-row-locators'

function worktreeOption(page: Page, worktreeId: string) {
  return worktreeRow(page, worktreeId)
}

test.describe('Worktree Lineage', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ pebblePage }) => {
    await waitForSessionReady(pebblePage)
    await waitForActiveWorktree(pebblePage)
  })

  test('renders existing child lineage in the sidebar', async ({ pebblePage }) => {
    const { parentId, childId } = await seedLineageScenario(pebblePage)
    const parentRow = worktreeOption(pebblePage, parentId)
    const childRow = worktreeOption(pebblePage, childId)

    await expect(parentRow).toBeVisible()
    await parentRow.click()
    await expect(parentRow).toHaveAttribute('aria-current', 'page')

    await expect(childRow).toBeVisible()
    const childToggle = parentRow.getByRole('button', { name: 'Hide 1 child workspace' })
    await expect(childToggle).toBeVisible({ timeout: 10_000 })
    await expect(childRow).toBeVisible()

    const positions = await pebblePage.evaluate(
      ({ parentId, childId }) => {
        const rowFor = (worktreeId: string) =>
          [...document.querySelectorAll<HTMLElement>('[data-worktree-id]')].find(
            (element) => element.dataset.worktreeId === worktreeId
          )
        const parent = rowFor(parentId)
        const child = rowFor(childId)
        if (!parent || !child) {
          return null
        }
        return {
          parentTop: parent.getBoundingClientRect().top,
          childTop: child.getBoundingClientRect().top
        }
      },
      { parentId, childId }
    )
    expect(positions).not.toBeNull()
    expect(positions!.childTop).toBeGreaterThan(positions!.parentTop)

    await childToggle.click()
    await expect(parentRow.getByRole('button', { name: 'Show 1 child workspace' })).toBeVisible()
    await expect(childRow).toBeHidden()

    await parentRow.getByRole('button', { name: 'Show 1 child workspace' }).click()
    await pebblePage.evaluate(async (childId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      // Why: this test covers lineage row rendering. Clearing through the
      // store keeps it focused on the render contract instead of nested
      // context-menu hit testing.
      await store.getState().updateWorktreeLineage(childId, { noParent: true })
    }, childId)
    await expect
      .poll(
        () =>
          pebblePage.evaluate((childId) => {
            const store = window.__store
            return Boolean(store?.getState().worktreeLineageById[childId])
          }, childId),
        {
          timeout: 10_000,
          message: 'Child lineage entry did not clear from the store'
        }
      )
      .toBe(false)
    await expect(childRow).toBeVisible()
  })

  test('injects filtered parents structurally without showing a parent badge', async ({
    pebblePage
  }) => {
    const { parentId, childId } = await seedLineageScenario(pebblePage)

    await pebblePage.evaluate(
      ({ parentId, childId }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        store.setState((current) => ({
          worktreesByRepo: Object.fromEntries(
            Object.entries(current.worktreesByRepo).map(([repoId, repoWorktrees]) => [
              repoId,
              repoWorktrees.map((worktree) =>
                worktree.id === parentId
                  ? {
                      ...worktree,
                      branch: worktree.branch || 'refs/heads/main',
                      isMainWorktree: true
                    }
                  : worktree
              )
            ])
          )
        }))
        const state = store.getState()
        state.setHideDefaultBranchWorkspace(true)
        state.setShowActiveOnly(true)
        state.setActiveWorktree(childId)
      },
      { parentId, childId }
    )

    const parentRow = worktreeOption(pebblePage, parentId)
    const childRow = worktreeOption(pebblePage, childId)

    await expect(parentRow).toBeVisible()
    await expect(childRow).toBeVisible()
    await expect(childRow).not.toContainText(/\bfrom\b/)

    const positions = await pebblePage.evaluate(
      ({ parentId, childId }) => {
        const rowFor = (worktreeId: string) =>
          [...document.querySelectorAll<HTMLElement>('[data-worktree-id]')].find(
            (element) => element.dataset.worktreeId === worktreeId
          )
        const parent = rowFor(parentId)
        const child = rowFor(childId)
        if (!parent || !child) {
          return null
        }
        return {
          parentTop: parent.getBoundingClientRect().top,
          childTop: child.getBoundingClientRect().top
        }
      },
      { parentId, childId }
    )
    expect(positions).not.toBeNull()
    expect(positions!.childTop).toBeGreaterThan(positions!.parentTop)
  })

  test('updates nested child preview status when the child terminal sleeps', async ({
    pebblePage
  }) => {
    const { parentId, childId } = await seedLineageScenario(pebblePage)
    const parentRow = worktreeOption(pebblePage, parentId)
    const childRow = worktreeOption(pebblePage, childId)

    await expect(parentRow).toBeVisible()
    await expect(childRow).toBeVisible()

    const childTabId = await seedWorkspaceLiveTerminal(pebblePage, childId)
    await expect(childRow).toContainText('Active')

    await markWorkspaceTerminalSlept(pebblePage, { worktreeId: childId, tabId: childTabId })
    await expect(childRow).toContainText('Inactive')
  })

  test('shows parent and child agent rows while the parent workspace is active', async ({
    pebblePage
  }) => {
    const { parentId, childId } = await seedLineageScenario(pebblePage)
    const parentRow = worktreeOption(pebblePage, parentId)
    const childRow = worktreeOption(pebblePage, childId)

    await parentRow.click()
    await expect(parentRow).toHaveAttribute('aria-current', 'page')
    await expect(childRow).toBeVisible()

    const parentAgentPrompt = await seedWorkspaceAgentStatus(pebblePage, parentId, 'PARENT')
    const childAgentPrompt = await seedWorkspaceAgentStatus(pebblePage, childId, 'CHILD')

    await expect(
      parentRow.getByRole('treeitem').filter({ hasText: parentAgentPrompt })
    ).toBeVisible()
    await expect(childRow.getByRole('treeitem').filter({ hasText: childAgentPrompt })).toBeVisible()
  })
})
