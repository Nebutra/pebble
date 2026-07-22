import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { expect as playwrightExpect, test as base, type Page } from '@playwright/test'

import { TEST_REPO_PATH_ENV } from '../global-setup'
import { installTauriBrowserInternals } from './tauri-browser-internals'

type PebbleTestFixtures = {
  sharedPage: Page
  pebblePage: Page
  dismissOnboarding: boolean
  seedTestRepo: boolean
  launchEnv: NodeJS.ProcessEnv
}

type PebbleWorkerFixtures = {
  testRepoPath: string
}

function isValidGitRepo(repoPath: string): boolean {
  if (!repoPath || !existsSync(repoPath)) {
    return false
  }
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: repoPath,
        stdio: 'pipe',
        encoding: 'utf8'
      }).trim() === 'true'
    )
  } catch {
    return false
  }
}

async function seedRendererWorkspace(page: Page, repoPath: string): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
  await page.evaluate((seedPath) => {
    const store = window.__store
    if (!store) {
      return
    }

    const repoId = 'e2e-repo'
    const worktreeId = 'e2e-worktree'
    const secondaryWorktreeId = 'e2e-worktree-secondary'
    const separator = seedPath.includes('\\') ? '\\' : '/'
    const displayName = seedPath.split(/[\\/]/).filter(Boolean).pop() ?? 'pebble-e2e'
    const secondaryPath = `${seedPath}${separator}..${separator}pebble-e2e-worktree-secondary`
    const state = store.getState()

    store.setState({
      repos: [
        {
          id: repoId,
          path: seedPath,
          displayName,
          projectGroupId: null,
          connectionId: null,
          executionHostId: null,
          kind: 'git'
        }
      ],
      worktreesByRepo: {
        [repoId]: [
          {
            id: worktreeId,
            repoId,
            path: seedPath,
            name: 'main',
            branch: 'main',
            isMain: true,
            ownership: 'external'
          },
          {
            id: secondaryWorktreeId,
            repoId,
            path: secondaryPath,
            name: 'e2e-secondary',
            branch: 'e2e-secondary',
            isMain: false,
            ownership: 'external'
          }
        ]
      },
      activeWorktreeId: worktreeId,
      workspaceSessionReady: true
    })

    if ((state.tabsByWorktree[worktreeId] ?? []).length === 0) {
      store.getState().createTab(worktreeId)
    }
  }, repoPath)
}

export const test = base.extend<PebbleTestFixtures, PebbleWorkerFixtures>({
  testRepoPath: [
    // oxlint-disable-next-line no-empty-pattern -- worker fixtures require destructuring.
    async ({}, provideFixture) => {
      const repoPath = process.env[TEST_REPO_PATH_ENV]?.trim() ?? ''
      if (!isValidGitRepo(repoPath)) {
        throw new Error(`Browser E2E repo fixture is unavailable: ${repoPath}`)
      }
      await provideFixture(path.resolve(repoPath))
    },
    { scope: 'worker' }
  ],
  dismissOnboarding: [true, { option: true }],
  seedTestRepo: [true, { option: true }],
  launchEnv: [{}, { option: true }],
  sharedPage: async ({ page, dismissOnboarding, seedTestRepo, testRepoPath }, provideFixture) => {
    await installTauriBrowserInternals(page)
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    if (seedTestRepo) {
      await seedRendererWorkspace(page, testRepoPath)
    }
    if (!dismissOnboarding) {
      await page.evaluate(async () => {
        // Why: dev builds suppress first-run education before tests can attach;
        // reopen through the same persisted API/event path used by Settings.
        const onboarding = await window.api.onboarding.update({
          closedAt: null,
          outcome: null,
          lastCompletedStep: -1,
          checklist: { dismissed: false }
        })
        window.dispatchEvent(new CustomEvent('pebble:onboarding-reopened', { detail: onboarding }))
      })
    }
    await provideFixture(page)
  },
  pebblePage: async ({ sharedPage }, provideFixture) => {
    await provideFixture(sharedPage)
  }
})

export { playwrightExpect as expect }
