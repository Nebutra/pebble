import type {
  GitConflictKind,
  GitConflictOperation,
  GitConflictResolutionStatus,
  GitFileStatus,
  GitStatusEntry,
  GitUpstreamStatus
} from '../../../packages/product-core/shared/types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { readObject, readString } from './tauri-git-rpc-value-readers'

export type SourceControlProjection = {
  repositoryId: string
  workspaceId: string
  branch: string
  baseBranch?: string
  ahead: number
  behind: number
  syncStatus: string
  changes: SourceControlChange[]
  conflictOperation?: string
}

export type SourceControlChange = {
  path: string
  status: string
  area?: string
  oldPath?: string
  additions?: number
  deletions?: number
  conflictKind?: string
  conflictStatus?: string
}

export async function readSourceControlProjection(
  params: unknown
): Promise<SourceControlProjection> {
  const worktreeId = await resolveRuntimeWorktreeId(params)
  if (!worktreeId) {
    throw new Error('git_status_requires_worktree')
  }
  const projections = await requestRuntimeJson<SourceControlProjection[]>(
    `/v1/source-control?workspaceId=${encodeURIComponent(worktreeId)}`,
    { method: 'GET', timeoutMs: 3000 }
  )
  const projection = projections.find((entry) => entry.workspaceId === worktreeId) ?? projections[0]
  if (!projection) {
    throw new Error(`source_control_projection_not_found:${worktreeId}`)
  }
  return projection
}

async function resolveRuntimeWorktreeId(params: unknown): Promise<string | undefined> {
  const input = readObject(params)
  const direct = normalizeRuntimeWorktreeId(
    readString(input.worktree) ?? readString(input.worktreeId)
  )
  if (direct) {
    return direct
  }
  const worktreePath = readString(input.worktreePath)
  if (!worktreePath) {
    return undefined
  }
  const worktrees = await requestRuntimeJson<{ id: string; path: string }[]>('/v1/worktrees', {
    method: 'GET',
    timeoutMs: 3000
  })
  const expected = comparableHostPath(worktreePath)
  return worktrees.find((worktree) => comparableHostPath(worktree.path) === expected)?.id
}

function comparableHostPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '')
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

function normalizeRuntimeWorktreeId(value: string | null): string | undefined {
  if (!value) {
    return undefined
  }
  return value.startsWith('id:') ? value.slice(3) : value
}

export function mapSourceControlChangeToStatusEntry(change: SourceControlChange): GitStatusEntry {
  const status = mapGitFileStatus(change.status)
  const entry: GitStatusEntry = {
    path: change.path,
    status,
    area: mapGitStatusArea(change.area, status)
  }
  if (change.oldPath) {
    entry.oldPath = change.oldPath
  }
  if (change.additions !== undefined) {
    entry.added = change.additions
  }
  if (change.deletions !== undefined) {
    entry.removed = change.deletions
  }
  const conflictKind = mapGitConflictKind(change.conflictKind)
  if (conflictKind) {
    entry.conflictKind = conflictKind
    entry.conflictStatus = mapGitConflictStatus(change.conflictStatus)
  }
  return entry
}

function mapGitConflictKind(kind: string | undefined): GitConflictKind | undefined {
  switch (kind) {
    case 'both_modified':
    case 'both_added':
    case 'both_deleted':
    case 'added_by_us':
    case 'added_by_them':
    case 'deleted_by_us':
    case 'deleted_by_them':
      return kind
    default:
      return undefined
  }
}

// Why: the renderer stamps conflictStatusSource itself; the runtime only ever
// reports git-observed resolution state, defaulting unknown values to
// unresolved so conflict gating stays conservative.
function mapGitConflictStatus(status: string | undefined): GitConflictResolutionStatus {
  return status === 'resolved_locally' ? 'resolved_locally' : 'unresolved'
}

export function mapGitConflictOperation(operation: string | undefined): GitConflictOperation {
  switch (operation) {
    case 'merge':
    case 'rebase':
    case 'cherry-pick':
      return operation
    default:
      return 'unknown'
  }
}

export function mapSourceControlProjectionToUpstreamStatus(
  projection: SourceControlProjection,
  params: unknown
): GitUpstreamStatus {
  const pushTarget = readObject(readObject(params).pushTarget)
  const upstreamName =
    readString(pushTarget.branch) ??
    readString(pushTarget.baseBranch) ??
    readString(projection.baseBranch)
  const hasUpstream =
    Boolean(upstreamName) ||
    projection.ahead > 0 ||
    projection.behind > 0 ||
    Boolean(pushTarget.branch)
  return {
    hasUpstream,
    upstreamName: upstreamName ?? undefined,
    ahead: projection.ahead,
    behind: projection.behind,
    hasConfiguredPushTarget: Boolean(pushTarget.branch) || undefined
  }
}

function mapGitFileStatus(status: string): GitFileStatus {
  switch (status.trim().toLowerCase()) {
    case 'added':
      return 'added'
    case 'deleted':
      return 'deleted'
    case 'renamed':
      return 'renamed'
    case 'untracked':
      return 'untracked'
    case 'copied':
      return 'copied'
    default:
      return 'modified'
  }
}

function mapGitStatusArea(
  area: string | undefined,
  status: GitFileStatus
): GitStatusEntry['area'] {
  if (area === 'staged' || area === 'unstaged' || area === 'untracked') {
    return area
  }
  return status === 'untracked' ? 'untracked' : 'unstaged'
}

export function readGitBranch(value: string): string | undefined {
  const branch = value.trim()
  return branch && branch !== 'unknown' ? branch : undefined
}
