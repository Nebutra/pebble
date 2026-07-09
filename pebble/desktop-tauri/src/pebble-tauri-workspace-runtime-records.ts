import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host'
import type {
  Repo,
  Worktree,
  WorktreeLineage,
  WorkspaceLineage,
  WorktreeMeta
} from '../../../src/shared/types'

export type PebbleRuntimeProject = {
  id: string
  name: string
  path: string
  locationKind: string
  hostId?: string
  provider?: string
  sortOrder?: number
  createdAt: string
  updatedAt: string
}

export type PebbleRuntimeWorktree = {
  id: string
  instanceId?: string
  projectId: string
  path: string
  branch?: string
  base?: string
  reviewKind?: string
  reviewId?: string
  displayName?: string
  comment?: string
  linkedIssue?: number | null
  linkedPR?: number | null
  linkedLinearIssue?: string | null
  isArchived?: boolean
  isUnread?: boolean
  isPinned?: boolean
  sortOrder?: number
  manualOrder?: number
  lastActivityAt?: number
  workspaceStatus?: string
  lineage?: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
  createdAt: string
  updatedAt: string
}

const DEFAULT_REPO_BADGE_COLOR = '#737373'

export function mapRuntimeProjectToRepo(
  project: PebbleRuntimeProject,
  kind: Repo['kind'] = 'git'
): Repo {
  const addedAt = dateMs(project.createdAt)
  const executionHostId =
    project.locationKind === 'ssh' && project.hostId
      ? (`ssh:${project.hostId}` as const)
      : LOCAL_EXECUTION_HOST_ID
  return {
    id: project.id,
    path: project.path,
    displayName: project.name || pathBasename(project.path),
    badgeColor: DEFAULT_REPO_BADGE_COLOR,
    addedAt,
    kind,
    connectionId: project.locationKind === 'ssh' ? (project.hostId ?? null) : null,
    executionHostId,
    projectHostSetupMethod: 'imported-existing-folder'
  }
}

export function mapRuntimeWorktreeToWorktree(worktree: PebbleRuntimeWorktree): Worktree {
  const createdAt = dateMs(worktree.createdAt)
  return {
    id: worktree.id,
    instanceId: worktree.instanceId ?? worktree.id,
    repoId: worktree.projectId,
    projectId: worktree.projectId,
    hostId: LOCAL_EXECUTION_HOST_ID,
    projectHostSetupId: worktree.projectId,
    path: worktree.path,
    head: '',
    branch: worktree.branch ?? '',
    isBare: false,
    isSparse: false,
    isMainWorktree: false,
    displayName: worktree.displayName || pathBasename(worktree.path),
    comment: worktree.comment ?? '',
    linkedIssue: worktree.linkedIssue ?? null,
    linkedPR: worktree.linkedPR ?? null,
    linkedLinearIssue: worktree.linkedLinearIssue ?? null,
    isArchived: worktree.isArchived ?? false,
    isUnread: worktree.isUnread ?? false,
    isPinned: worktree.isPinned ?? false,
    sortOrder: worktree.sortOrder ?? createdAt,
    ...(worktree.manualOrder !== undefined ? { manualOrder: worktree.manualOrder } : {}),
    lastActivityAt: worktree.lastActivityAt ?? dateMs(worktree.updatedAt),
    createdAt,
    ...(worktree.workspaceStatus ? { workspaceStatus: worktree.workspaceStatus } : {}),
    ...(worktree.base ? { baseRef: worktree.base } : {}),
    ...(worktree.lineage !== undefined ? { lineage: worktree.lineage } : {})
  }
}

export function applyWorktreeMeta(worktree: Worktree, updates: Partial<WorktreeMeta>): Worktree {
  return {
    ...worktree,
    // Why: linked* use null to mean "unlink"; a ??-fallback to the old value
    // would silently swallow the clear, so the plain spread must win.
    ...updates,
    lastActivityAt: Date.now()
  }
}

export function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function pathBasename(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]+/).pop() || normalized || 'Project'
}

export function joinRuntimePath(parentPath: string, name: string): string {
  const separator = parentPath.includes('\\') && !parentPath.includes('/') ? '\\' : '/'
  return parentPath.endsWith('/') || parentPath.endsWith('\\')
    ? `${parentPath}${name}`
    : `${parentPath}${separator}${name}`
}

function dateMs(value: string | undefined): number {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : Date.now()
}
