import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const TEST_REPO_PATH_ENV = 'PEBBLE_E2E_TEST_REPO_PATH'

export default function globalSetup(): void {
  const testRepoDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pebble-e2e-repo-')))

  execFileSync('git', ['init'], { cwd: testRepoDir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], {
    cwd: testRepoDir,
    stdio: 'pipe'
  })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], {
    cwd: testRepoDir,
    stdio: 'pipe'
  })

  writeFileSync(
    path.join(testRepoDir, 'README.md'),
    '# Pebble E2E Test Repo\n\nCreated for renderer and Tauri functional tests.\n'
  )
  writeFileSync(path.join(testRepoDir, 'CLAUDE.md'), '# CLAUDE.md\n\nTest instructions.\n')
  writeFileSync(
    path.join(testRepoDir, 'package.json'),
    `${JSON.stringify({ name: 'pebble-e2e-test', version: '0.0.0', private: true }, null, 2)}\n`
  )
  writeFileSync(path.join(testRepoDir, '.gitignore'), 'node_modules/\n')
  mkdirSync(path.join(testRepoDir, 'src'), { recursive: true })
  writeFileSync(path.join(testRepoDir, 'src', 'index.ts'), 'export const hello = "world"\n')

  execFileSync('git', ['add', '-A'], { cwd: testRepoDir, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit for E2E tests'], {
    cwd: testRepoDir,
    stdio: 'pipe'
  })

  const worktreeDir = path.join(testRepoDir, '..', `pebble-e2e-worktree-${randomUUID()}`)
  execFileSync('git', ['worktree', 'add', worktreeDir, '-b', 'e2e-secondary'], {
    cwd: testRepoDir,
    stdio: 'pipe'
  })
  // Why: Playwright propagates global-setup environment changes to workers,
  // avoiding a fixed temp-file race when overlapping runs tear down.
  process.env[TEST_REPO_PATH_ENV] = testRepoDir
}
