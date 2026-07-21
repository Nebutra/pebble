import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitConflictOperation,
  GitDiffResult,
  GitHubRepositoryIdentity,
  GitStatusResult,
  GitUpstreamStatus
} from '../../../packages/product-core/shared/types'
import type { GitHistoryResult } from '../../../packages/product-core/shared/git-history'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { getRuntimeRepoId } from './pebble-tauri-workspace-runtime-api'
import {
  readNumber,
  readObject,
  readRequiredString,
  readString,
  readStringList
} from './tauri-git-rpc-value-readers'
import {
  mapGitConflictOperation,
  mapSourceControlChangeToStatusEntry,
  mapSourceControlProjectionToUpstreamStatus,
  readGitBranch,
  readSourceControlProjection
} from './tauri-git-source-control-projection'

type RuntimeRemoteUrlResult = {
  url: string | null
}

type RuntimeRepositoryIdentityResult = {
  slug: GitHubRepositoryIdentity | null
  upstream: GitHubRepositoryIdentity | null
}

export async function readGitStatus(params: unknown): Promise<GitStatusResult> {
  const projection = await readSourceControlProjection(params)
  const upstreamStatus = mapSourceControlProjectionToUpstreamStatus(projection, params)
  return {
    entries: projection.changes.map(mapSourceControlChangeToStatusEntry),
    conflictOperation: mapGitConflictOperation(projection.conflictOperation),
    branch: readGitBranch(projection.branch),
    upstreamStatus
  }
}

export async function readGitConflictOperation(params: unknown): Promise<GitConflictOperation> {
  const projection = await readSourceControlProjection(params)
  return mapGitConflictOperation(projection.conflictOperation)
}

export async function readGitUpstreamStatus(params: unknown): Promise<GitUpstreamStatus> {
  return mapSourceControlProjectionToUpstreamStatus(
    await readSourceControlProjection(params),
    params
  )
}

export async function checkIgnored(params: unknown): Promise<string[]> {
  const input = readObject(params)
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson<string[]>('/v1/source-control/check-ignored', {
    method: 'POST',
    timeoutMs: 5000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {}),
      paths: readStringList(input.paths)
    }
  })
}

export async function readSubmoduleStatus(params: unknown): Promise<GitStatusResult> {
  const input = readObject(params)
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson<GitStatusResult>('/v1/source-control/submodule-status', {
    method: 'POST',
    timeoutMs: 5000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {}),
      submodulePath: readRequiredString(input.submodulePath, 'submodule path'),
      area: readString(input.area) ?? ''
    }
  })
}

export async function readGitDiff(params: unknown): Promise<GitDiffResult> {
  const input = readObject(params)
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson<GitDiffResult>('/v1/source-control/file-diff', {
    method: 'POST',
    timeoutMs: 5000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {}),
      filePath: readRequiredString(input.filePath, 'git diff file path'),
      staged: input.staged === true,
      compareAgainstHead: input.compareAgainstHead === true
    }
  })
}

export async function readBranchCompare(params: unknown): Promise<GitBranchCompareResult> {
  const input = readObject(params)
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson<GitBranchCompareResult>('/v1/source-control/branch-compare', {
    method: 'POST',
    timeoutMs: 10_000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {}),
      baseRef: readRequiredString(input.baseRef, 'base ref')
    }
  })
}

export async function readCommitCompare(params: unknown): Promise<GitCommitCompareResult> {
  const input = readObject(params)
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson<GitCommitCompareResult>('/v1/source-control/commit-compare', {
    method: 'POST',
    timeoutMs: 10_000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {}),
      commitId: readRequiredString(input.commitId, 'commit id')
    }
  })
}

export async function readGitHistory(params: unknown): Promise<GitHistoryResult> {
  const input = readObject(params)
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson<GitHistoryResult>('/v1/source-control/history', {
    method: 'POST',
    timeoutMs: 10_000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {}),
      limit: readNumber(input.limit),
      baseRef: readString(input.baseRef) ?? ''
    }
  })
}

export async function readBranchDiff(params: unknown): Promise<GitDiffResult> {
  const input = readObject(params)
  const compare = readObject(input.compare)
  return readRefFileDiff(params, {
    leftRef: readRequiredString(compare.mergeBase, 'branch diff merge base'),
    rightRef: readRequiredString(compare.headOid, 'branch diff head oid'),
    filePath: readRequiredString(input.filePath, 'branch diff file path'),
    oldPath: readString(input.oldPath) ?? undefined
  })
}

export async function readCommitDiff(params: unknown): Promise<GitDiffResult> {
  const input = readObject(params)
  const commitOid = readRequiredString(input.commitOid, 'commit oid')
  return readRefFileDiff(params, {
    leftRef: readString(input.parentOid) ?? `${commitOid}^`,
    rightRef: commitOid,
    filePath: readRequiredString(input.filePath, 'commit diff file path'),
    oldPath: readString(input.oldPath) ?? undefined
  })
}

async function readRefFileDiff(
  params: unknown,
  refs: { leftRef: string; rightRef: string; filePath: string; oldPath?: string }
): Promise<GitDiffResult> {
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson<GitDiffResult>('/v1/source-control/ref-file-diff', {
    method: 'POST',
    timeoutMs: 5000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {}),
      ...refs
    }
  })
}

export async function readRemoteFileUrl(params: unknown): Promise<string | null> {
  const input = readObject(params)
  const projection = await readSourceControlProjection(params)
  const result = await requestRuntimeJson<RuntimeRemoteUrlResult>(
    '/v1/source-control/remote-file-url',
    {
      method: 'POST',
      timeoutMs: 5000,
      body: {
        projectId: projection.repositoryId,
        ...(projection.workspaceId !== projection.repositoryId
          ? { worktreeId: projection.workspaceId }
          : {}),
        relativePath: readRequiredString(input.relativePath, 'remote file path'),
        line: readNumber(input.line) ?? 1
      }
    }
  )
  return result.url ?? null
}

export async function readRemoteCommitUrl(params: unknown): Promise<string | null> {
  const input = readObject(params)
  const sha = readRequiredString(input.sha, 'commit sha')
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error('sha must be a full git object id')
  }
  const projection = await readSourceControlProjection(params)
  const result = await requestRuntimeJson<RuntimeRemoteUrlResult>(
    '/v1/source-control/remote-commit-url',
    {
      method: 'POST',
      timeoutMs: 5000,
      body: {
        projectId: projection.repositoryId,
        ...(projection.workspaceId !== projection.repositoryId
          ? { worktreeId: projection.workspaceId }
          : {}),
        sha
      }
    }
  )
  return result.url ?? null
}

export async function readRepositoryIdentity(
  params: unknown
): Promise<RuntimeRepositoryIdentityResult> {
  const body = await readRepositoryIdentityRequest(params)
  return requestRuntimeJson<RuntimeRepositoryIdentityResult>(
    '/v1/source-control/repository-identity',
    {
      method: 'POST',
      timeoutMs: 5000,
      body
    }
  )
}

async function readRepositoryIdentityRequest(
  params: unknown
): Promise<{ projectId: string; worktreeId?: string }> {
  const repoId = getRuntimeRepoId(params)
  if (repoId) {
    return { projectId: repoId }
  }
  const projection = await readSourceControlProjection(params)
  return {
    projectId: projection.repositoryId,
    ...(projection.workspaceId !== projection.repositoryId
      ? { worktreeId: projection.workspaceId }
      : {})
  }
}
