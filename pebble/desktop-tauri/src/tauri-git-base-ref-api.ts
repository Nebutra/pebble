import { invoke } from '@tauri-apps/api/core'

import type { BaseRefDefaultResult, BaseRefSearchResult, Repo } from '../../../src/shared/types'

type GitBaseRefSearchInput = {
  repoPath: string
  query: string
  limit?: number
}

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

async function resolveLocalGitRepo(repos: Promise<Repo[]>, repoId: string): Promise<Repo | null> {
  const repo = (await repos).find((entry) => entry.id === repoId)
  if (!repo || repo.kind === 'folder' || repo.connectionId) {
    return null
  }
  return repo
}
