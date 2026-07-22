/**
 * Playwright globalTeardown: cleans up the test git repo and worktrees.
 *
 * Why: the temp repo created by globalSetup should be removed after the
 * test run so we don't litter the user's /tmp with test directories.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { TEST_REPO_PATH_ENV } from './global-setup'

export default function globalTeardown(): void {
  const testRepoDir = process.env[TEST_REPO_PATH_ENV]?.trim() ?? ''
  if (testRepoDir && existsSync(testRepoDir)) {
    // Why: enumerate only this repository's registered worktrees so overlapping
    // E2E runs cannot delete each other's sibling temp directories.
    try {
      const worktreeOutput = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: testRepoDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      for (const line of worktreeOutput.split(/\r?\n/)) {
        if (!line.startsWith('worktree ')) {
          continue
        }
        const worktreePath = path.resolve(line.slice('worktree '.length))
        if (worktreePath !== path.resolve(testRepoDir)) {
          rmSync(worktreePath, { recursive: true, force: true })
        }
      }
    } catch {
      // Best-effort cleanup of worktrees
    }

    rmSync(testRepoDir, { recursive: true, force: true })
    console.log(`[e2e] Cleaned up test repo at ${testRepoDir}`)
  }
}
