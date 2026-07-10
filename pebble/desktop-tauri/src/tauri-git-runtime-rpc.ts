import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitConflictKind,
  GitConflictOperation,
  GitConflictResolutionStatus,
  GitDiffResult,
  GitFileStatus,
  GitHubRepositoryIdentity,
  GitStatusEntry,
  GitStatusResult,
  GitUpstreamStatus
} from '../../../src/shared/types'
import type { GitHistoryResult } from '../../../src/shared/git-history'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { getRuntimeRepoId } from './pebble-tauri-workspace-runtime-api'

type SourceControlProjection = {
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

type SourceControlChange = {
  path: string
  status: string
  area?: string
  oldPath?: string
  additions?: number
  deletions?: number
  conflictKind?: string
  conflictStatus?: string
}

type RuntimeGitRpcResult = {
  handled: boolean
  result?: unknown
}

type RuntimeRemoteUrlResult = {
  url: string | null
}

type RuntimeRepositoryIdentityResult = {
  slug: GitHubRepositoryIdentity | null
  upstream: GitHubRepositoryIdentity | null
}

export async function callTauriGitRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeGitRpcResult> {
  switch (method) {
    case 'github.repoSlug':
      return handled((await readRepositoryIdentity(params)).slug)
    case 'github.repoUpstream':
      return handled((await readRepositoryIdentity(params)).upstream)
    case 'git.status':
      return handled(await readGitStatus(params))
    case 'git.checkIgnored':
      return handled(await checkIgnored(params))
    case 'git.submoduleStatus':
      return handled(await readSubmoduleStatus(params))
    case 'git.diff':
      return handled(await readGitDiff(params))
    case 'git.branchCompare':
      return handled(await readBranchCompare(params))
    case 'git.commitCompare':
      return handled(await readCommitCompare(params))
    case 'git.history':
      return handled(await readGitHistory(params))
    case 'git.branchDiff':
      return handled(await readBranchDiff(params))
    case 'git.commitDiff':
      return handled(await readCommitDiff(params))
    case 'git.upstreamStatus':
      return handled(await readGitUpstreamStatus(params))
    case 'git.conflictOperation':
      return handled(await readGitConflictOperation(params))
    case 'git.abortMerge':
      return handled(await mutateGit('abortMerge', params))
    case 'git.abortRebase':
      return handled(await mutateGit('abortRebase', params))
    case 'git.checkout':
      return handled(await checkoutBranch(params))
    case 'git.localBranches':
      return handled(await readLocalBranches(params))
    case 'git.stage':
      return handled(await mutateGit('stage', params))
    case 'git.bulkStage':
      return handled(await mutateGit('bulkStage', params))
    case 'git.unstage':
      return handled(await mutateGit('unstage', params))
    case 'git.bulkUnstage':
      return handled(await mutateGit('bulkUnstage', params))
    case 'git.discard':
      return handled(await mutateGit('discard', params))
    case 'git.bulkDiscard':
      return handled(await mutateGit('bulkDiscard', params))
    case 'git.commit':
      return handled(await mutateGit('commit', params))
    case 'git.generateCommitMessage':
      return handled({
        success: false,
        error:
          'Commit message generation for remote worktrees is not yet wired through the Tauri SSH relay.'
      })
    case 'git.discoverCommitMessageModels':
      return handled({
        success: false,
        error:
          'Commit message model discovery for remote worktrees is not yet wired through the Tauri SSH relay.'
      })
    case 'git.cancelGenerateCommitMessage':
      return handled({ ok: true })
    case 'git.generatePullRequestFields':
      return handled({
        success: false,
        error:
          'Pull request detail generation for remote worktrees is not yet wired through the Tauri SSH relay.'
      })
    case 'git.cancelGeneratePullRequestFields':
      return handled({ ok: true })
    case 'git.fetch':
      return handled(await mutateGit('fetch', params))
    case 'git.forkSync':
      return handled(await syncFork(params))
    case 'git.pull':
      return handled(await mutateGit('pull', params))
    case 'git.push':
      return handled(await mutateGit('push', params))
    case 'git.fastForward':
      return handled(await mutateGit('fastForward', params))
    case 'git.rebaseFromBase':
      return handled(await mutateGit('rebaseFromBase', params))
    case 'git.remoteFileUrl':
      return handled(await readRemoteFileUrl(params))
    case 'git.remoteCommitUrl':
      return handled(await readRemoteCommitUrl(params))
    default:
      return { handled: false }
  }
}

async function readGitStatus(params: unknown): Promise<GitStatusResult> {
  const projection = await readSourceControlProjection(params)
  const upstreamStatus = mapSourceControlProjectionToUpstreamStatus(projection, params)
  return {
    entries: projection.changes.map(mapSourceControlChangeToStatusEntry),
    conflictOperation: mapGitConflictOperation(projection.conflictOperation),
    branch: readGitBranch(projection.branch),
    upstreamStatus
  }
}

async function readGitConflictOperation(params: unknown): Promise<GitConflictOperation> {
  const projection = await readSourceControlProjection(params)
  return mapGitConflictOperation(projection.conflictOperation)
}

async function readGitUpstreamStatus(params: unknown): Promise<GitUpstreamStatus> {
  return mapSourceControlProjectionToUpstreamStatus(
    await readSourceControlProjection(params),
    params
  )
}

async function checkIgnored(params: unknown): Promise<string[]> {
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

async function readSubmoduleStatus(params: unknown): Promise<GitStatusResult> {
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

async function readGitDiff(params: unknown): Promise<GitDiffResult> {
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

async function mutateGit(operation: string, params: unknown): Promise<unknown> {
  const input = readObject(params)
  const pushTarget = readObject(input.pushTarget)
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson('/v1/source-control/mutate', {
    method: 'POST',
    timeoutMs: operation === 'commit' ? 30_000 : 10_000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {}),
      operation,
      filePath: readString(input.filePath) ?? '',
      filePaths: readStringList(input.filePaths),
      message: readString(input.message) ?? '',
      remoteName: readString(pushTarget.remoteName) ?? '',
      branchName: readString(pushTarget.branchName) ?? '',
      publish: input.publish === true,
      forceWithLease: input.forceWithLease === true,
      baseRef: readString(input.baseRef) ?? ''
    }
  })
}

async function checkoutBranch(params: unknown): Promise<unknown> {
  const input = readObject(params)
  const branch = readRequiredString(input.branch, 'checkout branch')
  if (branch.startsWith('-')) {
    throw new Error('invalid_branch_name')
  }
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson('/v1/source-control/checkout', {
    method: 'POST',
    timeoutMs: 10_000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {}),
      branch
    }
  })
}

async function readLocalBranches(params: unknown): Promise<unknown> {
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson('/v1/source-control/local-branches', {
    method: 'POST',
    timeoutMs: 5000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {})
    }
  })
}

async function readBranchCompare(params: unknown): Promise<GitBranchCompareResult> {
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

async function readCommitCompare(params: unknown): Promise<GitCommitCompareResult> {
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

async function readGitHistory(params: unknown): Promise<GitHistoryResult> {
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

async function readBranchDiff(params: unknown): Promise<GitDiffResult> {
  const input = readObject(params)
  const compare = readObject(input.compare)
  return readRefFileDiff(params, {
    leftRef: readRequiredString(compare.mergeBase, 'branch diff merge base'),
    rightRef: readRequiredString(compare.headOid, 'branch diff head oid'),
    filePath: readRequiredString(input.filePath, 'branch diff file path'),
    oldPath: readString(input.oldPath) ?? undefined
  })
}

async function readCommitDiff(params: unknown): Promise<GitDiffResult> {
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

async function readRemoteFileUrl(params: unknown): Promise<string | null> {
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

async function readRemoteCommitUrl(params: unknown): Promise<string | null> {
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

async function syncFork(params: unknown): Promise<unknown> {
  const input = readObject(params)
  const expectedUpstream = readObject(input.expectedUpstream)
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson('/v1/source-control/fork-sync', {
    method: 'POST',
    timeoutMs: 60_000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {}),
      expectedUpstream: {
        owner: readRequiredString(expectedUpstream.owner, 'expected upstream owner'),
        repo: readRequiredString(expectedUpstream.repo, 'expected upstream repo')
      }
    }
  })
}

async function readRepositoryIdentity(params: unknown): Promise<RuntimeRepositoryIdentityResult> {
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

async function readSourceControlProjection(params: unknown): Promise<SourceControlProjection> {
  const worktreeId = normalizeRuntimeWorktreeId(readString(readObject(params).worktree))
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

function mapSourceControlChangeToStatusEntry(change: SourceControlChange): GitStatusEntry {
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

function mapGitConflictOperation(operation: string | undefined): GitConflictOperation {
  switch (operation) {
    case 'merge':
    case 'rebase':
    case 'cherry-pick':
      return operation
    default:
      return 'unknown'
  }
}

function mapSourceControlProjectionToUpstreamStatus(
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

function mapGitStatusArea(area: string | undefined, status: GitFileStatus): GitStatusEntry['area'] {
  if (area === 'staged' || area === 'unstaged' || area === 'untracked') {
    return area
  }
  return status === 'untracked' ? 'untracked' : 'unstaged'
}

function readGitBranch(value: string): string | undefined {
  const branch = value.trim()
  return branch && branch !== 'unknown' ? branch : undefined
}

function normalizeRuntimeWorktreeId(value: string | null): string | undefined {
  if (!value) {
    return undefined
  }
  return value.startsWith('id:') ? value.slice(3) : value
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readRequiredString(value: unknown, label: string): string {
  const text = readString(value)
  if (!text) {
    throw new Error(`${label} is required`)
  }
  return text
}

function handled(result: unknown): RuntimeGitRpcResult {
  return { handled: true, result }
}
