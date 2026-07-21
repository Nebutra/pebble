import type {
  WorktreeBaseStatusEvent,
  WorktreeRemoteBranchConflictEvent
} from '../../../packages/product-core/shared/types'

const BASE_STATUS_VALUES = new Set(['checking', 'current', 'drift', 'base_changed', 'unknown'])

export function decodeRuntimeWorktreeBaseStatus(value: unknown): WorktreeBaseStatusEvent | null {
  const payload = readObject(value)
  const repoId = readString(payload.repoId)
  const worktreeId = readString(payload.worktreeId)
  const status = readString(payload.status)
  const base = readString(payload.base)
  if (!repoId || !worktreeId || !status || !BASE_STATUS_VALUES.has(status) || !base) {
    return null
  }
  const behind =
    typeof payload.behind === 'number' && payload.behind >= 0 ? payload.behind : undefined
  const recentSubjects = Array.isArray(payload.recentSubjects)
    ? payload.recentSubjects.filter((entry): entry is string => typeof entry === 'string')
    : undefined
  return {
    repoId,
    worktreeId,
    status: status as WorktreeBaseStatusEvent['status'],
    base,
    ...(readString(payload.remote) ? { remote: readString(payload.remote) } : {}),
    ...(behind !== undefined ? { behind } : {}),
    ...(recentSubjects?.length ? { recentSubjects } : {})
  }
}

export function decodeRuntimeRemoteBranchConflict(
  value: unknown
): WorktreeRemoteBranchConflictEvent | null {
  const payload = readObject(value)
  const repoId = readString(payload.repoId)
  const worktreeId = readString(payload.worktreeId)
  const remote = readString(payload.remote)
  const branchName = readString(payload.branchName)
  return repoId && worktreeId && remote && branchName
    ? { repoId, worktreeId, remote, branchName }
    : null
}

function readObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
