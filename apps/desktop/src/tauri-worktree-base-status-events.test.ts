import { describe, expect, it } from 'vitest'

import {
  decodeRuntimeRemoteBranchConflict,
  decodeRuntimeWorktreeBaseStatus
} from './tauri-worktree-base-status-events'

describe('runtime worktree base-status events', () => {
  it('decodes the paired-runtime base reconcile contract', () => {
    expect(
      decodeRuntimeWorktreeBaseStatus({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        status: 'drift',
        base: 'origin/main',
        remote: 'origin',
        behind: 3,
        recentSubjects: ['one', 'two']
      })
    ).toEqual({
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      status: 'drift',
      base: 'origin/main',
      remote: 'origin',
      behind: 3,
      recentSubjects: ['one', 'two']
    })
  })

  it('rejects malformed and unknown statuses instead of inventing local state', () => {
    expect(decodeRuntimeWorktreeBaseStatus({ status: 'drift', base: 'origin/main' })).toBeNull()
    expect(
      decodeRuntimeWorktreeBaseStatus({
        repoId: 'repo',
        worktreeId: 'wt',
        status: 'fresh',
        base: 'origin/main'
      })
    ).toBeNull()
  })

  it('decodes remote publish-branch conflicts', () => {
    expect(
      decodeRuntimeRemoteBranchConflict({
        repoId: 'repo',
        worktreeId: 'wt',
        remote: 'fork',
        branchName: 'feature'
      })
    ).toEqual({ repoId: 'repo', worktreeId: 'wt', remote: 'fork', branchName: 'feature' })
  })
})
