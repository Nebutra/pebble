import { describe, expect, it } from 'vitest'
import { mapRuntimeWorktreeToWorktree } from './pebble-tauri-workspace-runtime-records'

describe('runtime worktree records', () => {
  it('preserves the runtime-owned main-worktree identity', () => {
    const worktree = mapRuntimeWorktreeToWorktree({
      id: 'wt-main',
      projectId: 'repo-1',
      path: '/work/pebble',
      isMainWorktree: true,
      createdAt: '2026-07-27T00:00:00Z',
      updatedAt: '2026-07-27T00:00:00Z'
    })

    expect(worktree.isMainWorktree).toBe(true)
  })
})
