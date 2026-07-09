import { invoke } from '@tauri-apps/api/core'

import type {
  BaseRefDefaultResult,
  BaseRefSearchResult,
  GitHubPrStartPoint,
  GitPushTarget,
  Repo
} from '../../../src/shared/types'

type GitBaseRefSearchInput = {
  repoPath: string
  query: string
  limit?: number
}

type GitReviewStartPoint = {
  baseBranch: string
  compareBaseRef?: string
  pushTarget?: GitPushTarget
  headSha?: string
  branchNameOverride?: string
  maintainerCanModify?: boolean
}

type GitReviewStartPointResult = GitReviewStartPoint | { error: string }

export async function getTauriBaseRefDefault(
  repos: Promise<Repo[]>,
  repoId: string
): Promise<BaseRefDefaultResult> {
  const repo = await resolveLocalGitRepo(repos, repoId)
  if (!repo) {
    return { defaultBaseRef: null, remoteCount: 0 }
  }
  return invoke<BaseRefDefaultResult>('git_get_base_ref_default', {
    input: { repoPath: repo.path }
  })
}

export async function searchTauriBaseRefs(
  repos: Promise<Repo[]>,
  args: { repoId: string; query: string; limit?: number }
): Promise<string[]> {
  return (await searchTauriBaseRefDetails(repos, args)).map((entry) => entry.refName)
}

export async function searchTauriBaseRefDetails(
  repos: Promise<Repo[]>,
  args: { repoId: string; query: string; limit?: number }
): Promise<BaseRefSearchResult[]> {
  const repo = await resolveLocalGitRepo(repos, args.repoId)
  if (!repo) {
    return []
  }
  return invoke<BaseRefSearchResult[]>('git_search_base_ref_details', {
    input: {
      repoPath: repo.path,
      query: args.query,
      limit: args.limit
    } satisfies GitBaseRefSearchInput
  })
}

export async function resolveTauriPrBase(
  repos: Promise<Repo[]>,
  args: {
    repoId: string
    prNumber: number
    headRefName?: string
    baseRefName?: string
    isCrossRepository?: boolean
  }
): Promise<GitHubPrStartPoint | { error: string }> {
  const repo = await resolveLocalReviewRepo(repos, args.repoId)
  if ('error' in repo) {
    return repo
  }
  return invokeReviewStartPoint('git_resolve_pr_start_point', {
    repoPath: repo.path,
    prNumber: args.prNumber,
    headRefName: args.headRefName,
    baseRefName: args.baseRefName,
    isCrossRepository: args.isCrossRepository
  })
}

export async function resolveTauriMrBase(
  repos: Promise<Repo[]>,
  args: {
    repoId: string
    mrIid: number
    sourceBranch?: string
    targetBranch?: string
    isCrossRepository?: boolean
  }
): Promise<
  { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget } | { error: string }
> {
  const repo = await resolveLocalReviewRepo(repos, args.repoId)
  if ('error' in repo) {
    return repo
  }
  return invokeReviewStartPoint('git_resolve_mr_start_point', {
    repoPath: repo.path,
    mrIid: args.mrIid,
    sourceBranch: args.sourceBranch,
    targetBranch: args.targetBranch,
    isCrossRepository: args.isCrossRepository
  })
}

async function resolveLocalGitRepo(repos: Promise<Repo[]>, repoId: string): Promise<Repo | null> {
  const repo = (await repos).find((entry) => entry.id === repoId)
  if (!repo || repo.kind === 'folder' || repo.connectionId) {
    return null
  }
  return repo
}

async function resolveLocalReviewRepo(
  repos: Promise<Repo[]>,
  repoId: string
): Promise<Repo | { error: string }> {
  const repo = (await repos).find((entry) => entry.id === repoId)
  if (!repo) {
    return { error: 'Repo not found' }
  }
  if (repo.kind === 'folder') {
    return { error: 'Folder mode does not support creating worktrees.' }
  }
  if (repo.connectionId) {
    return {
      error:
        'SSH review base resolution is handled by the remote runtime host. Select that runtime environment and retry.'
    }
  }
  return repo
}

async function invokeReviewStartPoint(
  command: 'git_resolve_pr_start_point' | 'git_resolve_mr_start_point',
  input: Record<string, unknown>
): Promise<GitReviewStartPointResult> {
  try {
    return await invoke<GitReviewStartPointResult>(command, { input })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
