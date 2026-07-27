import { describe, expect, it } from 'vitest'
import type { PRInfo, Worktree } from '../../../../shared/types'
import {
  shouldApplyDivergedLinkedPRClear,
  shouldClearDivergedLinkedMergedPR
} from './github-diverged-linked-merged-pr'

const basePr: PRInfo = {
  number: 42,
  title: 'Done',
  state: 'merged',
  url: 'https://github.test/pr/42',
  checksStatus: 'success',
  updatedAt: '2026-07-01T00:00:00Z',
  mergeable: 'UNKNOWN',
  headSha: 'pr-head',
  headDivergedFromMergedPRAtOid: 'worktree-head'
}

const baseWorktree = {
  linkedPR: 42,
  branch: 'refs/heads/feature',
  head: 'worktree-head',
  isBare: false,
  isArchived: false
} as Pick<Worktree, 'linkedPR' | 'branch' | 'head' | 'isBare' | 'isArchived'>

describe('shouldClearDivergedLinkedMergedPR', () => {
  it('clears only when the diverged OID matches the request head', () => {
    expect(
      shouldClearDivergedLinkedMergedPR({
        pr: basePr,
        linkedPRNumber: 42,
        requestHeadOid: 'worktree-head'
      })
    ).toBe(true)
    expect(
      shouldClearDivergedLinkedMergedPR({
        pr: basePr,
        linkedPRNumber: 42,
        requestHeadOid: 'other-head'
      })
    ).toBe(false)
  })

  it('does not clear without a positive not-contained signal', () => {
    expect(
      shouldClearDivergedLinkedMergedPR({
        pr: { ...basePr, headDivergedFromMergedPRAtOid: undefined },
        linkedPRNumber: 42,
        requestHeadOid: 'worktree-head'
      })
    ).toBe(false)
  })
})

describe('shouldApplyDivergedLinkedPRClear', () => {
  it('requires branch, head, and linked PR to still match the request', () => {
    expect(
      shouldApplyDivergedLinkedPRClear({
        worktree: baseWorktree,
        linkedPRNumber: 42,
        branch: 'feature',
        requestHeadOid: 'worktree-head'
      })
    ).toBe(true)
    expect(
      shouldApplyDivergedLinkedPRClear({
        worktree: { ...baseWorktree, head: 'moved' },
        linkedPRNumber: 42,
        branch: 'feature',
        requestHeadOid: 'worktree-head'
      })
    ).toBe(false)
  })
})
