import type { PRInfo, Worktree } from '../../../../shared/types'

/**
 * Why: a durable linked PR stays on the worktree after the branch moves past the
 * merge. Only clear when main confirms the exact head is not on the PR line —
 * never on rate-limit/unknown, and never from a sibling worktree's head.
 */
export function shouldClearDivergedLinkedMergedPR(args: {
  pr: PRInfo | null
  linkedPRNumber: number | null
  requestHeadOid: string | null
}): boolean {
  const { pr, linkedPRNumber, requestHeadOid } = args
  return (
    linkedPRNumber != null &&
    requestHeadOid !== null &&
    pr?.number === linkedPRNumber &&
    pr.state === 'merged' &&
    pr.headDivergedFromMergedPRAtOid === requestHeadOid &&
    pr.headSha !== requestHeadOid &&
    pr.confirmedContainedHeadOid !== requestHeadOid
  )
}

export function shouldApplyDivergedLinkedPRClear(args: {
  worktree: Pick<Worktree, 'linkedPR' | 'branch' | 'head' | 'isBare' | 'isArchived'> | undefined
  linkedPRNumber: number
  branch: string
  requestHeadOid: string | null
}): boolean {
  const { worktree, linkedPRNumber, branch, requestHeadOid } = args
  return (
    Boolean(worktree) &&
    requestHeadOid !== null &&
    worktree?.linkedPR === linkedPRNumber &&
    worktree.branch.replace(/^refs\/heads\//, '') === branch &&
    worktree.head === requestHeadOid &&
    worktree.isBare !== true &&
    worktree.isArchived !== true
  )
}
