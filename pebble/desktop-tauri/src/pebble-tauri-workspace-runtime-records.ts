import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host'
import type { Repo, Worktree, WorktreeMeta } from '../../../src/shared/types'

export type PebbleRuntimeProject = {
  id: string
  name: string
  path: string
  locationKind: string
  hostId?: string
  provider?: string
  createdAt: string
  updatedAt: string
}

export type PebbleRuntimeWorktree = {
  id: string
  projectId: string
  path: string
  branch?: string
  base?: string
  reviewKind?: string
  reviewId?: string
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
    instanceId: worktree.id,
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
    displayName: pathBasename(worktree.path),
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: createdAt,
    lastActivityAt: dateMs(worktree.updatedAt),
    createdAt,
    ...(worktree.base ? { baseRef: worktree.base } : {})
  }
}

export function applyWorktreeMeta(worktree: Worktree, updates: Partial<WorktreeMeta>): Worktree {
  return {
    ...worktree,
    ...updates,
    linkedIssue: updates.linkedIssue ?? worktree.linkedIssue,
    linkedPR: updates.linkedPR ?? worktree.linkedPR,
    linkedLinearIssue: updates.linkedLinearIssue ?? worktree.linkedLinearIssue,
    lastActivityAt: Date.now()
  }
}

export function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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
