import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { readWorktrees } from './pebble-tauri-workspace-runtime-api'
import { emitTauriActivateWorktree } from './tauri-settings-event-api'
import { requireRepoId } from './pebble-runtime-repo-method-args'
import {
  readRuntimeNumber,
  readRuntimeObject,
  readRuntimeRequiredString,
  readRuntimeString
} from './pebble-runtime-param-coercion'

export function toWorktreePrefetchArgs(
  params: unknown
): Parameters<PreloadApi['worktrees']['prefetchCreateBase']>[0] {
  const input = readRuntimeObject(params)
  return {
    repoId: requireRepoId(params),
    baseBranch: readRuntimeString(input.baseBranch) ?? undefined
  }
}

export function toWorktreeResolvePrArgs(
  params: unknown
): Parameters<PreloadApi['worktrees']['resolvePrBase']>[0] {
  const input = readRuntimeObject(params)
  return {
    repoId: requireRepoId(params),
    prNumber: readRuntimeNumber(input.prNumber) ?? 0,
    headRefName: readRuntimeString(input.headRefName) ?? '',
    baseRefName: readRuntimeString(input.baseRefName) ?? '',
    isCrossRepository: input.isCrossRepository === true
  }
}

export function toWorktreeResolveMrArgs(
  params: unknown
): Parameters<PreloadApi['worktrees']['resolveMrBase']>[0] {
  const input = readRuntimeObject(params)
  return {
    repoId: requireRepoId(params),
    mrIid: readRuntimeNumber(input.mrIid) ?? 0,
    sourceBranch: readRuntimeString(input.sourceBranch) ?? '',
    targetBranch: readRuntimeString(input.targetBranch) ?? '',
    isCrossRepository: input.isCrossRepository === true
  }
}

export function toForceDeleteBranchArgs(
  params: unknown
): Parameters<PreloadApi['worktrees']['forceDeletePreservedBranch']>[0] {
  const input = readRuntimeObject(params)
  return {
    worktreeId: requireWorktreeId(params),
    branchName: readRuntimeRequiredString(input.branchName, 'branch name'),
    expectedHead: readRuntimeRequiredString(input.expectedHead, 'expected branch head')
  }
}

export async function activateTauriWorktree(params: unknown): Promise<{
  repoId: string
  worktreeId: string
  activated: true
}> {
  const worktreeId = requireWorktreeId(params)
  const worktree = (await readWorktrees()).find((entry) => entry.id === worktreeId)
  if (!worktree) {
    throw new Error(`Worktree not found: ${worktreeId}`)
  }
  emitTauriActivateWorktree({
    repoId: worktree.repoId,
    worktreeId
  })
  return {
    repoId: worktree.repoId,
    worktreeId,
    activated: true
  }
}

function requireWorktreeId(params: unknown): string {
  const input = readRuntimeObject(params)
  const nested = readRuntimeObject(input.worktree)
  const value =
    readRuntimeString(input.worktreeId) ??
    readRuntimeString(input.worktree) ??
    readRuntimeString(nested.id) ??
    readRuntimeString(nested.worktreeId)
  if (!value) {
    throw new Error('Missing worktree id')
  }
  if (value.startsWith('id:worktree:')) {
    return value.slice('id:worktree:'.length)
  }
  if (value.startsWith('worktree:')) {
    return value.slice('worktree:'.length)
  }
  return value.startsWith('id:') ? value.slice('id:'.length) : value
}
