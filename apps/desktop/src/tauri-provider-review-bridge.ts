// Bridges the renderer's provider RPC methods (including GitHub check actions)
// to the local Go runtime's /v1/providers routes, so PR/MR + review flows work
// without pairing a remote environment. Only methods whose full response shape
// the local gh/glab CLI paths can produce faithfully are routed here; anything
// else stays remote-gated in the dispatcher.
import type {
  ClassifiedError,
  GitHubRerunPRChecksResult,
  PRInfo,
  PRCheckDetail,
  PRCheckRunDetails
} from '../../../packages/product-core/shared/types'
import type {
  GitLabIssueInfo,
  GitLabJobTraceResult,
  GitLabPagedResult,
  GitLabProjectRef,
  GitLabRetryJobResult,
  GitLabWorkItem
} from '../../../packages/product-core/shared/gitlab-types'
import type {
  CreateHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewInfo,
  HostedReviewProvider
} from '../../../packages/product-core/shared/hosted-review'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../../packages/product-core/shared/hosted-review-refs'
import { readRepos, readWorktrees } from './pebble-tauri-workspace-runtime-api'

type RuntimeGetJson = <T>(path: string) => Promise<T>
type RuntimePostJson = <T>(
  path: string,
  options: { method: 'POST'; body?: unknown; timeoutMs?: number }
) => Promise<T>

// ── Provider review update (post-creation mutations) ─────────────────
// Owns github.updatePR / updatePRState /
// requestPRReviewers / removePRReviewers and gitlab.updateMR / updateMRState
// through the Go runtime's gh/glab CLI-backed update route.

export type UpdateHostedReviewResult =
  | { ok: true; reviewers?: GitLabReviewer[] }
  | { ok: false; error: string }

type GitLabReviewer = {
  id?: number
  username: string
  name?: string | null
  avatarUrl: string
  state?: string
}

type UpdateHostedReviewParams = ProviderSelectorParams & {
  provider?: unknown
  number?: unknown
  title?: unknown
  body?: unknown
  base?: unknown
  baseRefName?: unknown
  targetBranch?: unknown
  draft?: unknown
  prRepo?: unknown
  state?: unknown
  addReviewers?: unknown
  removeReviewers?: unknown
  reviewerIds?: unknown
}

export async function updateHostedReview(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<UpdateHostedReviewResult> {
  const input = params as UpdateHostedReviewParams
  const projectId = readProjectId(input)
  const provider = readNonEmptyString(input.provider) ?? 'unsupported'
  const number = coercePositiveInt(input.number)
  if (!projectId || !number) {
    return {
      ok: false,
      error: 'Update review failed: repository and review number are required.'
    }
  }
  const worktreeId = await resolveWorktreeId(projectId, readWorktreeSelector(input))
  const state = readReviewStateInput(input.state)
  const base = readProviderReviewBase(provider, input)
  const prRepo =
    input.prRepo && typeof input.prRepo === 'object'
      ? (input.prRepo as Record<string, unknown>)
      : null
  const owner = readNonEmptyString(prRepo?.owner)
  const repo = readNonEmptyString(prRepo?.repo)
  const result = await requestJson<{ ok: boolean; error?: string }>(
    '/v1/providers/reviews/update',
    {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        projectId,
        ...(worktreeId ? { worktreeId } : {}),
        provider,
        number,
        ...(provider === 'github' && owner && repo ? { owner, repo } : {}),
        ...(readStringValue(input.title) !== null ? { title: readStringValue(input.title) } : {}),
        ...(readStringValue(input.body) !== null ? { body: readStringValue(input.body) } : {}),
        ...(base !== null ? { base } : {}),
        ...(typeof input.draft === 'boolean' ? { draft: input.draft } : {}),
        ...(state ? { state } : {}),
        ...(readStringArray(input.addReviewers).length > 0
          ? { addReviewers: readStringArray(input.addReviewers) }
          : {}),
        ...(readStringArray(input.removeReviewers).length > 0
          ? { removeReviewers: readStringArray(input.removeReviewers) }
          : {}),
        ...(readReviewerIds(input.reviewerIds) !== null
          ? { reviewerIds: readReviewerIds(input.reviewerIds) }
          : {})
      }
    }
  )
  return result.ok
    ? {
        ok: true,
        ...('reviewers' in result ? { reviewers: result.reviewers as GitLabReviewer[] } : {})
      }
    : { ok: false, error: result.error ?? 'Update review failed.' }
}

function readProviderReviewBase(provider: string, input: UpdateHostedReviewParams): string | null {
  if (provider === 'github') {
    return readStringValue(input.base ?? input.baseRefName)
  }
  if (provider === 'gitlab') {
    return readStringValue(input.base ?? input.targetBranch)
  }
  return readStringValue(input.base)
}

export async function mergeHostedReview(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<UpdateHostedReviewResult> {
  const input = params as UpdateHostedReviewParams & { method?: unknown }
  const projectId = readProjectId(input)
  const provider = readNonEmptyString(input.provider) ?? 'unsupported'
  const number = coercePositiveInt(input.number)
  const method = readNonEmptyString(input.method)
  if (!projectId || !number || !method) {
    return {
      ok: false,
      error: 'Merge review failed: repository, review number, and method are required.'
    }
  }
  const worktreeId = await resolveWorktreeId(projectId, readWorktreeSelector(input))
  return requestJson<UpdateHostedReviewResult>('/v1/providers/reviews/merge', {
    method: 'POST',
    timeoutMs: 60_000,
    body: { projectId, ...(worktreeId ? { worktreeId } : {}), provider, number, method }
  })
}

export async function setHostedReviewAutoMerge(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<UpdateHostedReviewResult> {
  const input = params as ProviderSelectorParams & {
    number?: unknown
    enabled?: unknown
    method?: unknown
  }
  const projectId = readProjectId(input)
  const number = coercePositiveInt(input.number)
  const method = readNonEmptyString(input.method)
  if (!projectId || !number || typeof input.enabled !== 'boolean' || !method) {
    return {
      ok: false,
      error: 'Set auto-merge failed: repository, review number, state, and method are required.'
    }
  }
  const worktreeId = await resolveWorktreeId(projectId, readWorktreeSelector(input))
  return requestJson<UpdateHostedReviewResult>('/v1/providers/reviews/auto-merge', {
    method: 'POST',
    timeoutMs: 60_000,
    body: {
      projectId,
      ...(worktreeId ? { worktreeId } : {}),
      number,
      enabled: input.enabled,
      method
    }
  })
}

type AddReviewCommentResult =
  | { ok: true; comment: GitLabReviewerComment }
  | { ok: false; error: string }

type GitLabReviewerComment = {
  id: number
  author: string
  authorAvatarUrl: string
  body: string
  createdAt: string
  url: string
  isBot?: boolean
}

export async function addHostedReviewComment(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<AddReviewCommentResult> {
  const input = params as ProviderSelectorParams & {
    provider?: unknown
    number?: unknown
    body?: unknown
    prRepo?: unknown
  }
  const projectId = readProjectId(input)
  const provider = readNonEmptyString(input.provider) ?? 'unsupported'
  const number = coercePositiveInt(input.number)
  const body = readStringValue(input.body)
  if (!projectId || !number || body === null || !body.trim()) {
    return {
      ok: false,
      error: 'Add review comment failed: repository, review number, and body are required.'
    }
  }
  const worktreeId = await resolveWorktreeId(projectId, readWorktreeSelector(input))
  const prRepo =
    input.prRepo && typeof input.prRepo === 'object'
      ? (input.prRepo as Record<string, unknown>)
      : null
  const owner = readNonEmptyString(prRepo?.owner)
  const repo = readNonEmptyString(prRepo?.repo)
  return requestJson<AddReviewCommentResult>('/v1/providers/reviews/comments', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      projectId,
      ...(worktreeId ? { worktreeId } : {}),
      provider,
      number,
      body,
      ...(owner && repo ? { owner, repo } : {})
    }
  })
}

export async function addHostedInlineReviewComment(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<AddReviewCommentResult> {
  const input = params as ProviderSelectorParams & Record<string, unknown>
  const projectId = readProjectId(input)
  const provider = readNonEmptyString(input.provider) ?? 'unsupported'
  const number = coercePositiveInt(input.number)
  if (!projectId || !number) {
    return {
      ok: false,
      error: 'Add inline comment failed: repository and review number are required.'
    }
  }
  const worktreeId = await resolveWorktreeId(projectId, readWorktreeSelector(input))
  return requestJson<AddReviewCommentResult>('/v1/providers/reviews/inline-comments', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      projectId,
      ...(worktreeId ? { worktreeId } : {}),
      provider,
      number,
      body: input.body,
      path: input.path,
      oldPath: input.oldPath,
      line: input.line,
      startLine: input.startLine,
      commitId: input.commitId,
      baseSha: input.baseSha,
      startSha: input.startSha,
      headSha: input.headSha
    }
  })
}

export async function replyHostedReviewComment(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<AddReviewCommentResult> {
  const input = params as ProviderSelectorParams & Record<string, unknown>
  const projectId = readProjectId(input)
  const number = coercePositiveInt(input.number)
  if (!projectId || !number) {
    return { ok: false, error: 'Reply failed: repository and PR number are required.' }
  }
  const worktreeId = await resolveWorktreeId(projectId, readWorktreeSelector(input))
  const prRepo =
    input.prRepo && typeof input.prRepo === 'object'
      ? (input.prRepo as Record<string, unknown>)
      : null
  const owner = readNonEmptyString(prRepo?.owner)
  const repo = readNonEmptyString(prRepo?.repo)
  return requestJson<AddReviewCommentResult>('/v1/providers/reviews/comment-replies', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      projectId,
      ...(worktreeId ? { worktreeId } : {}),
      number,
      commentId: input.commentId,
      body: input.body,
      threadId: input.threadId,
      path: input.path,
      line: input.line,
      ...(owner && repo ? { owner, repo } : {})
    }
  })
}

export async function resolveHostedReviewThread(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<UpdateHostedReviewResult> {
  const input = params as ProviderSelectorParams & Record<string, unknown>
  const projectId = readProjectId(input)
  const provider = readNonEmptyString(input.provider)
  const number = coercePositiveInt(input.number)
  if (!projectId || !provider || (provider === 'gitlab' && !number)) {
    return {
      ok: false,
      error:
        'Resolve discussion failed: repository, provider, and required review identity are missing.'
    }
  }
  const worktreeId = await resolveWorktreeId(projectId, readWorktreeSelector(input))
  return requestJson<UpdateHostedReviewResult>('/v1/providers/reviews/threads/resolve', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      projectId,
      ...(worktreeId ? { worktreeId } : {}),
      provider,
      ...(number ? { number } : {}),
      threadId: input.threadId,
      resolved: input.resolved
    }
  })
}

export async function setHostedReviewFileViewed(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<boolean> {
  const input = params as ProviderSelectorParams & Record<string, unknown>
  const projectId = readProjectId(input)
  if (!projectId) {
    return false
  }
  const worktreeId = await resolveWorktreeId(projectId, readWorktreeSelector(input))
  const result = await requestJson<UpdateHostedReviewResult>('/v1/providers/reviews/files/viewed', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      projectId,
      ...(worktreeId ? { worktreeId } : {}),
      pullRequestId: input.pullRequestId,
      path: input.path,
      viewed: input.viewed
    }
  })
  return result.ok
}

// GitLab's "opened" state name differs from GitHub's "open"; normalize both
// to the Go route's provider-neutral "open"/"closed" pair.
function readReviewStateInput(value: unknown): 'open' | 'closed' | null {
  if (value === 'open' || value === 'opened') {
    return 'open'
  }
  if (value === 'closed') {
    return 'closed'
  }
  return null
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function readReviewerIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  return value.filter(
    (entry): entry is number => typeof entry === 'number' && Number.isInteger(entry) && entry >= 0
  )
}

// The renderer sends `repo` as the Pebble Repo.id, which is the runtime's
// projectId. Worktree-scoped callers may also pass worktreeId.
export type ProviderSelectorParams = {
  repo?: unknown
  repoId?: unknown
  projectId?: unknown
  repoPath?: unknown
  worktree?: unknown
  worktreeId?: unknown
  worktreePath?: unknown
}

type GitHubWorkItem = {
  number: number
  title: string
  state: string
  url: string
  updatedAt: string
  branchName?: string
  baseRefName?: string
  headSha?: string
}

type HostedReviewForBranchParams = ProviderSelectorParams & {
  branch?: unknown
  linkedGitHubPR?: unknown
  fallbackGitHubPR?: unknown
  linkedGitLabMR?: unknown
  linkedBitbucketPR?: unknown
  linkedAzureDevOpsPR?: unknown
  linkedGiteaPR?: unknown
}

type CreateHostedReviewParams = ProviderSelectorParams & {
  provider?: unknown
  base?: unknown
  head?: unknown
  title?: unknown
  body?: unknown
  draft?: unknown
  useTemplate?: unknown
}

type HostedReviewCapabilities = {
  provider?: unknown
  authenticated?: unknown
  currentBranch?: unknown
  defaultBaseRef?: unknown
}

// ── GitHub PR checks ────────────────────────────────────────────────
// github.prChecks resolves to PRCheckDetail[]. The Go route returns the same
// rows as the `gh pr checks` fallback.

type GitHubPRChecksParams = ProviderSelectorParams & {
  prNumber?: unknown
}

export async function fetchGitHubPRChecks(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<PRCheckDetail[]> {
  const input = params as GitHubPRChecksParams
  const { worktreeId, prNumber } = input
  const number = coercePositiveInt(prNumber)
  if (number === null) {
    throw new Error('Missing pull request number')
  }
  const query = await providerQuery(input, input.worktree ?? worktreeId, {
    number: String(number)
  })
  const result = await requestJson<{ checks: PRCheckDetail[] }>(
    `/v1/providers/github/pulls/checks?${query}`
  )
  return result.checks ?? []
}

type GitHubPRCheckDetailsParams = ProviderSelectorParams & {
  checkRunId?: unknown
  workflowRunId?: unknown
  checkName?: unknown
  url?: unknown
  prRepo?: unknown
}

export async function fetchGitHubPRCheckDetails(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<PRCheckRunDetails | null> {
  const input = params as GitHubPRCheckDetailsParams
  const extra: Record<string, string> = {}
  const checkRunId = coercePositiveInt(input.checkRunId)
  const workflowRunId = coercePositiveInt(input.workflowRunId)
  if (checkRunId !== null) {
    extra.checkRunId = String(checkRunId)
  }
  if (workflowRunId !== null) {
    extra.workflowRunId = String(workflowRunId)
  }
  const checkName = readNonEmptyString(input.checkName)
  const url = readNonEmptyString(input.url)
  if (checkName) {
    extra.checkName = checkName
  }
  if (url) {
    extra.url = url
  }
  const prRepo =
    input.prRepo && typeof input.prRepo === 'object'
      ? (input.prRepo as Record<string, unknown>)
      : null
  const owner = readNonEmptyString(prRepo?.owner)
  const repo = readNonEmptyString(prRepo?.repo)
  if (owner) {
    extra.owner = owner
  }
  if (repo) {
    extra.repo = repo
  }
  const query = await providerQuery(input, readWorktreeSelector(input), extra)
  const result = await requestJson<{ details: PRCheckRunDetails | null }>(
    `/v1/providers/github/pulls/check-details?${query}`
  )
  return result.details ?? null
}

type GitHubRerunPRChecksParams = ProviderSelectorParams & {
  prNumber?: unknown
  headSha?: unknown
  failedOnly?: unknown
}

export async function rerunGitHubPRChecks(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GitHubRerunPRChecksResult> {
  const input = params as GitHubRerunPRChecksParams
  const projectId = readProjectId(input)
  const prNumber = coercePositiveInt(input.prNumber)
  if (!projectId || prNumber === null) {
    return { ok: false, error: 'Invalid pull request number' }
  }
  const worktreeId = await resolveWorktreeId(projectId, readWorktreeSelector(input))
  const headSha = readNonEmptyString(input.headSha)
  return requestJson<GitHubRerunPRChecksResult>('/v1/providers/github/pulls/checks/rerun', {
    method: 'POST',
    timeoutMs: 60_000,
    body: {
      projectId,
      ...(worktreeId ? { worktreeId } : {}),
      prNumber,
      ...(headSha ? { headSha } : {}),
      failedOnly: input.failedOnly === true
    }
  })
}

// ── GitLab MR list ──────────────────────────────────────────────────
// gitlab.listMRs resolves to GitLabPagedResult<GitLabWorkItem> (listGitLabRepoMRs
// → listMergeRequests). The Go route returns the mapped MR rows; totals mirror
// the CLI cwd fallback, which the renderer already treats as approximate.

type GitLabListMRsParams = ProviderSelectorParams & {
  state?: unknown
  page?: unknown
  perPage?: unknown
  query?: unknown
}

export async function fetchGitLabMRs(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<GitLabPagedResult<GitLabWorkItem>> {
  const input = params as GitLabListMRsParams
  const { worktree, worktreeId, state, page, perPage, query } = input
  const resolvedPage = coercePositiveInt(page) ?? 1
  const resolvedPerPage = coercePositiveInt(perPage) ?? 20
  const extra: Record<string, string> = {
    perPage: String(resolvedPerPage)
  }
  if (typeof state === 'string' && state.trim()) {
    extra.state = state.trim()
  }
  if (typeof query === 'string' && query.trim()) {
    extra.query = query.trim()
  }
  const queryString = await providerQuery(input, worktree ?? worktreeId, extra)
  const result = await requestJson<{ items: GitLabWorkItem[] }>(
    `/v1/providers/gitlab/merge-requests?${queryString}`
  )
  const items = result.items ?? []
  return {
    items,
    page: resolvedPage,
    perPage: resolvedPerPage,
    // The CLI path doesn't return X-Total headers; mirror the cwd-fallback's
    // approximate totals so pagination controls behave the same.
    totalCount: items.length,
    totalPages: items.length < resolvedPerPage ? resolvedPage : resolvedPage + 1
  }
}

type GitLabListIssuesParams = ProviderSelectorParams & {
  state?: unknown
  assignee?: unknown
  limit?: unknown
}

export async function fetchGitLabIssues(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<{ items: GitLabIssueInfo[]; error?: ClassifiedError }> {
  const input = params as GitLabListIssuesParams
  const extra: Record<string, string> = {
    limit: String(coercePositiveInt(input.limit) ?? 20)
  }
  if (typeof input.state === 'string' && input.state.trim()) {
    extra.state = input.state.trim()
  }
  if (typeof input.assignee === 'string' && input.assignee.trim()) {
    extra.assignee = input.assignee.trim()
  }
  const queryString = await providerQuery(input, readWorktreeSelector(input), extra)
  return requestJson<{ items: GitLabIssueInfo[]; error?: ClassifiedError }>(
    `/v1/providers/gitlab/issues?${queryString}`
  )
}

export async function fetchGitLabWorkItems(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<GitLabPagedResult<GitLabWorkItem>> {
  const input = params as GitLabListMRsParams
  const resolvedPage = coercePositiveInt(input.page) ?? 1
  const resolvedPerPage = coercePositiveInt(input.perPage) ?? 20
  const extra: Record<string, string> = {
    page: String(resolvedPage),
    perPage: String(resolvedPerPage)
  }
  if (typeof input.state === 'string' && input.state.trim()) {
    extra.state = input.state.trim()
  }
  if (typeof input.query === 'string' && input.query.trim()) {
    extra.query = input.query.trim()
  }
  const queryString = await providerQuery(input, readWorktreeSelector(input), extra)
  const result = await requestJson<{
    items: Omit<GitLabWorkItem, 'repoId'>[]
    error?: ClassifiedError
  }>(`/v1/providers/gitlab/work-items?${queryString}`)
  const repoId = readProjectId(input) ?? ''
  const items = (result.items ?? []).map((item) => ({ ...item, repoId }))
  return {
    items,
    page: resolvedPage,
    perPage: resolvedPerPage,
    totalCount: items.length,
    totalPages: items.length < resolvedPerPage ? resolvedPage : resolvedPage + 1,
    ...(result.error ? { error: result.error } : {})
  }
}

type GitLabJobParams = ProviderSelectorParams & {
  jobId?: unknown
  projectRef?: unknown
}

function readGitLabProjectRef(value: unknown): GitLabProjectRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const input = value as Record<string, unknown>
  const host = readNonEmptyString(input.host)
  const path = readNonEmptyString(input.path)
  return host && path ? { host, path } : null
}

async function gitLabJobRequestBody(params: unknown): Promise<{
  projectId: string
  worktreeId?: string
  jobId: number
  projectRef?: GitLabProjectRef
}> {
  const input = params as GitLabJobParams
  const projectId = readProjectId(input)
  const jobId = coercePositiveInt(input.jobId)
  if (!projectId || jobId === null) {
    throw new Error('GitLab job request requires a repository and positive jobId.')
  }
  const worktreeId = await resolveWorktreeId(projectId, readWorktreeSelector(input))
  const projectRef = readGitLabProjectRef(input.projectRef)
  return {
    projectId,
    ...(worktreeId ? { worktreeId } : {}),
    jobId,
    ...(projectRef ? { projectRef } : {})
  }
}

export async function fetchGitLabJobTrace(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GitLabJobTraceResult> {
  return requestJson<GitLabJobTraceResult>('/v1/providers/gitlab/jobs/trace', {
    method: 'POST',
    timeoutMs: 30_000,
    body: await gitLabJobRequestBody(params)
  })
}

export async function retryGitLabJob(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GitLabRetryJobResult> {
  return requestJson<GitLabRetryJobResult>('/v1/providers/gitlab/jobs/retry', {
    method: 'POST',
    timeoutMs: 30_000,
    body: await gitLabJobRequestBody(params)
  })
}

// ── REST-backed provider PR lists (Bitbucket / Azure DevOps / Gitea) ─
// These providers have no bundled CLI; the Go runtime calls their REST APIs
// with the same PEBBLE_* env-var credentials Electron's clients read, and maps
// rows to the provider-neutral shape below (mirrors GitHubWorkItem /
// GitLabWorkItem field-for-field).

export type ReviewWorkItem = {
  id: string
  type: 'pr'
  number: number
  title: string
  state: string
  url: string
  labels: string[]
  updatedAt: string
  author: string | null
  branchName?: string
  baseRefName?: string
  headSha?: string
  isCrossRepository?: boolean
}

const REVIEW_WORK_ITEM_ROUTES: Record<string, string> = {
  bitbucket: '/v1/providers/bitbucket/pulls',
  'azure-devops': '/v1/providers/azure-devops/pulls',
  gitea: '/v1/providers/gitea/pulls'
}

type ReviewWorkItemsParams = ProviderSelectorParams & {
  provider?: unknown
  state?: unknown
  limit?: unknown
}

export async function fetchReviewWorkItems(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<ReviewWorkItem[]> {
  const input = params as ReviewWorkItemsParams
  const { worktree, worktreeId, provider, state, limit } = input
  const route = typeof provider === 'string' ? REVIEW_WORK_ITEM_ROUTES[provider.trim()] : undefined
  if (!route) {
    throw new Error(`Unsupported review provider: ${String(provider)}`)
  }
  const extra: Record<string, string> = {}
  const resolvedLimit = coercePositiveInt(limit)
  if (resolvedLimit !== null) {
    extra.limit = String(resolvedLimit)
  }
  if (typeof state === 'string' && state.trim()) {
    extra.state = state.trim()
  }
  const query = await providerQuery(input, worktree ?? worktreeId, extra)
  const result = await requestJson<{ items: ReviewWorkItem[] }>(`${route}?${query}`)
  return result.items ?? []
}

// ── Hosted review lookup ─────────────────────────────────────────────
// Existing-review lookup and GitHub/GitLab creation use the Go provider routes,
// keeping Tauri on the same visible PR/MR flows without Electron IPC.

export async function fetchHostedReviewForBranch(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<HostedReviewInfo | null> {
  return (await resolveHostedReviewForBranch(requestJson, params)).review
}

type HostedReviewLookupResult = {
  review: HostedReviewInfo | null
  capabilities: HostedReviewCapabilities | null
}

async function resolveHostedReviewForBranch(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<HostedReviewLookupResult> {
  const input = params as HostedReviewForBranchParams
  const branch = readNonEmptyString(input.branch)
  if (!branch) {
    return { review: null, capabilities: null }
  }
  const linkedRestProvider = readLinkedRestReviewProvider(input)
  if (linkedRestProvider) {
    return {
      review: await findRestHostedReviewForBranch(
        requestJson,
        input,
        branch,
        linkedRestProvider.provider,
        linkedRestProvider.number
      ),
      capabilities: null
    }
  }
  const linkedGitHub = coercePositiveInt(input.linkedGitHubPR)
  const linkedGitLab = coercePositiveInt(input.linkedGitLabMR)
  if (linkedGitLab !== null && linkedGitHub === null) {
    // Why: an explicit MR link is authoritative when both providers happen to
    // have a review for the same branch.
    const linkedReview = await findGitLabReviewForBranch(requestJson, input, branch)
    if (linkedReview) {
      return { review: linkedReview, capabilities: null }
    }
  }
  let capabilities: HostedReviewCapabilities | null = null
  if (linkedGitHub === null && linkedGitLab === null) {
    capabilities = await fetchHostedReviewCapabilities(requestJson, input).catch(() => null)
    const detectedProvider = readSupportedCreationProvider(capabilities?.provider)
    if (isRestHostedReviewProvider(detectedProvider)) {
      return {
        review: await findRestHostedReviewForBranch(
          requestJson,
          input,
          branch,
          detectedProvider,
          null
        ),
        capabilities
      }
    }
  }
  const gitHubReview = await findGitHubReviewForBranch(requestJson, input, branch)
  if (gitHubReview) {
    return { review: gitHubReview, capabilities }
  }
  return {
    review: await findGitLabReviewForBranch(requestJson, input, branch),
    capabilities
  }
}

export async function fetchGitHubPRForBranch(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<PRInfo | null> {
  const input = params as ProviderSelectorParams & {
    branch?: unknown
    linkedPRNumber?: unknown
    fallbackPRNumber?: unknown
    acceptMergedFallbackPR?: unknown
    currentHeadOid?: unknown
  }
  const projectId = readProjectId(input)
  if (!projectId) {
    return null
  }
  const worktreeId = await resolveWorktreeId(projectId, readWorktreeSelector(input))
  const linkedPRNumber = coercePositiveInt(input.linkedPRNumber)
  const fallbackPRNumber =
    linkedPRNumber === null ? coercePositiveInt(input.fallbackPRNumber) : null
  const result = await requestJson<{ pr: PRInfo | null }>('/v1/providers/github/pulls/for-branch', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      projectId,
      ...(worktreeId ? { worktreeId } : {}),
      branch: typeof input.branch === 'string' ? input.branch : '',
      ...(linkedPRNumber ? { linkedPRNumber } : {}),
      ...(fallbackPRNumber ? { fallbackPRNumber } : {}),
      acceptMergedFallbackPR: input.acceptMergedFallbackPR === true,
      ...(typeof input.currentHeadOid === 'string' ? { currentHeadOid: input.currentHeadOid } : {})
    }
  })
  return result.pr
}

export async function fetchHostedReviewCreationEligibility(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<HostedReviewCreationEligibility> {
  const lookup = await resolveHostedReviewForBranch(requestJson, params)
  if (lookup.review) {
    return {
      provider: lookup.review.provider,
      review: { number: lookup.review.number, url: lookup.review.url },
      canCreate: false,
      blockedReason: 'existing_review',
      nextAction: 'open_existing_review'
    }
  }
  const input = params as HostedReviewForBranchParams
  const capabilities =
    lookup.capabilities ?? (await fetchHostedReviewCapabilities(requestJson, input))
  return buildHostedReviewCreationEligibility(input, capabilities)
}

async function fetchHostedReviewCapabilities(
  requestJson: RuntimeGetJson,
  input: ProviderSelectorParams
): Promise<HostedReviewCapabilities> {
  const query = await providerQuery(input, readWorktreeSelector(input), {})
  return requestJson<HostedReviewCapabilities>(`/v1/providers/review-capabilities?${query}`)
}

function buildHostedReviewCreationEligibility(
  input: HostedReviewForBranchParams,
  capabilities: HostedReviewCapabilities
): HostedReviewCreationEligibility {
  const provider = readSupportedCreationProvider(capabilities.provider)
  const branch =
    normalizeOptionalHeadRef(input.branch) ?? normalizeOptionalHeadRef(capabilities.currentBranch)
  const defaultBaseRef =
    normalizeOptionalBaseRef((input as { base?: unknown }).base) ??
    normalizeOptionalBaseRef(capabilities.defaultBaseRef)
  const baseResult = {
    provider,
    review: null,
    defaultBaseRef,
    head: branch
  }
  if (!branch || branch === 'HEAD') {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'detached_head',
      nextAction: null
    }
  }
  if (provider === 'unsupported') {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'unsupported_provider',
      nextAction: null
    }
  }
  if (defaultBaseRef && branch.toLowerCase() === defaultBaseRef.toLowerCase()) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'default_branch',
      nextAction: null
    }
  }
  if ((input as { hasUncommittedChanges?: unknown }).hasUncommittedChanges === true) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'dirty',
      nextAction: 'commit'
    }
  }
  if ((input as { hasUpstream?: unknown }).hasUpstream === false) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'no_upstream',
      nextAction: 'publish'
    }
  }
  if ((input as { hasUpstream?: unknown }).hasUpstream !== true) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: null,
      nextAction: null
    }
  }
  if (readNumber((input as { behind?: unknown }).behind) > 0) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'needs_sync',
      nextAction: 'sync'
    }
  }
  if (capabilities.authenticated !== true) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'auth_required',
      nextAction: 'authenticate'
    }
  }
  if (readNumber((input as { ahead?: unknown }).ahead) > 0) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'needs_push',
      nextAction: 'push'
    }
  }
  return {
    ...baseResult,
    canCreate: Boolean(defaultBaseRef),
    blockedReason: null,
    nextAction: null
  }
}

function readSupportedCreationProvider(value: unknown): HostedReviewProvider {
  return value === 'github' ||
    value === 'gitlab' ||
    value === 'bitbucket' ||
    value === 'azure-devops' ||
    value === 'gitea'
    ? value
    : 'unsupported'
}

type RestHostedReviewProvider = 'bitbucket' | 'azure-devops' | 'gitea'

function isRestHostedReviewProvider(
  provider: HostedReviewProvider
): provider is RestHostedReviewProvider {
  return provider === 'bitbucket' || provider === 'azure-devops' || provider === 'gitea'
}

function readLinkedRestReviewProvider(
  input: HostedReviewForBranchParams
): { provider: RestHostedReviewProvider; number: number } | null {
  const candidates: [RestHostedReviewProvider, unknown][] = [
    ['bitbucket', input.linkedBitbucketPR],
    ['azure-devops', input.linkedAzureDevOpsPR],
    ['gitea', input.linkedGiteaPR]
  ]
  for (const [provider, value] of candidates) {
    const number = coercePositiveInt(value)
    if (number !== null) {
      return { provider, number }
    }
  }
  return null
}

async function findRestHostedReviewForBranch(
  requestJson: RuntimeGetJson,
  input: HostedReviewForBranchParams,
  branch: string,
  provider: RestHostedReviewProvider,
  linkedNumber: number | null
): Promise<HostedReviewInfo | null> {
  const items = await fetchReviewWorkItems(requestJson, {
    ...input,
    provider,
    state: 'open',
    limit: 24
  }).catch(() => [])
  const item = items.find((candidate) =>
    linkedNumber !== null
      ? candidate.number === linkedNumber
      : normalizeBranchName(candidate.branchName) === branch
  )
  return item ? mapRestWorkItemToHostedReview(provider, item) : null
}

function normalizeOptionalHeadRef(value: unknown): string | null {
  const ref = readNonEmptyString(value)
  return ref ? normalizeHostedReviewHeadRef(ref) : null
}

function normalizeOptionalBaseRef(value: unknown): string | null {
  const ref = readNonEmptyString(value)
  return ref ? normalizeHostedReviewBaseRef(ref) : null
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

async function findGitHubReviewForBranch(
  requestJson: RuntimeGetJson,
  input: HostedReviewForBranchParams,
  branch: string
): Promise<HostedReviewInfo | null> {
  const linkedNumber =
    coercePositiveInt(input.linkedGitHubPR) ?? coercePositiveInt(input.fallbackGitHubPR)
  const query = await providerQuery(input, input.worktree ?? input.worktreeId, {
    limit: '24'
  })
  const list = await requestJson<{ items: GitHubWorkItem[] }>(
    `/v1/providers/github/pulls?${query}`
  ).catch(() => null)
  const item = list?.items?.find((candidate) =>
    linkedNumber
      ? candidate.number === linkedNumber
      : normalizeBranchName(candidate.branchName) === branch
  )
  return item ? mapGitHubWorkItemToHostedReview(item) : null
}

export async function createHostedReview(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<CreateHostedReviewResult> {
  const input = params as CreateHostedReviewParams
  const projectId = readProjectId(input)
  const provider = readNonEmptyString(input.provider) ?? 'unsupported'
  const base = readNonEmptyString(input.base) ?? ''
  const title = readNonEmptyString(input.title) ?? ''
  if (!projectId || !base || !title) {
    return {
      ok: false,
      code: 'validation',
      error: 'Create review failed: repository, base branch, and title are required.'
    }
  }
  const worktreeId = await resolveWorktreeId(projectId, readWorktreeSelector(input))
  return requestJson<CreateHostedReviewResult>('/v1/providers/reviews', {
    method: 'POST',
    timeoutMs: 60_000,
    body: {
      projectId,
      ...(worktreeId ? { worktreeId } : {}),
      provider,
      base,
      head: readNonEmptyString(input.head) ?? '',
      title,
      body: readStringValue(input.body) ?? '',
      draft: input.draft === true,
      useTemplate: input.useTemplate === true
    }
  })
}

async function findGitLabReviewForBranch(
  requestJson: RuntimeGetJson,
  input: HostedReviewForBranchParams,
  branch: string
): Promise<HostedReviewInfo | null> {
  const linkedNumber = coercePositiveInt(input.linkedGitLabMR)
  const result = await fetchGitLabMRs(requestJson, {
    ...input,
    state: 'opened',
    perPage: 24,
    query: linkedNumber ? String(linkedNumber) : branch
  }).catch(() => null)
  const item = result?.items.find((candidate) =>
    linkedNumber
      ? candidate.number === linkedNumber
      : normalizeBranchName(candidate.branchName) === branch
  )
  return item ? mapGitLabWorkItemToHostedReview(item) : null
}

function mapGitHubWorkItemToHostedReview(item: GitHubWorkItem): HostedReviewInfo {
  return {
    provider: 'github',
    number: item.number,
    title: item.title,
    state: readHostedReviewState(item.state),
    url: item.url,
    status: 'neutral',
    updatedAt: item.updatedAt,
    mergeable: 'UNKNOWN',
    ...(item.headSha ? { headSha: item.headSha } : {}),
    ...(item.baseRefName ? { baseRefName: item.baseRefName } : {})
  }
}

function mapGitLabWorkItemToHostedReview(item: GitLabWorkItem): HostedReviewInfo {
  return {
    provider: 'gitlab',
    number: item.number,
    title: item.title,
    state: readHostedReviewState(item.state),
    url: item.url,
    status: 'neutral',
    updatedAt: item.updatedAt,
    mergeable: 'UNKNOWN',
    ...(item.baseRefName ? { baseRefName: item.baseRefName } : {})
  }
}

function mapRestWorkItemToHostedReview(
  provider: RestHostedReviewProvider,
  item: ReviewWorkItem
): HostedReviewInfo {
  return {
    provider,
    number: item.number,
    title: item.title,
    state: readHostedReviewState(item.state),
    url: item.url,
    status: 'neutral',
    updatedAt: item.updatedAt,
    mergeable: 'UNKNOWN',
    ...(item.headSha ? { headSha: item.headSha } : {}),
    ...(item.baseRefName ? { baseRefName: item.baseRefName } : {})
  }
}

function readHostedReviewState(value: string): HostedReviewInfo['state'] {
  if (value === 'closed' || value === 'merged' || value === 'draft') {
    return value
  }
  return 'open'
}

function normalizeBranchName(value: unknown): string | null {
  const branch = readNonEmptyString(value)
  return branch?.replace(/^refs\/heads\//, '') ?? null
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function providerQuery(
  selector: ProviderSelectorParams,
  worktreeSelector: unknown,
  extra: Record<string, string>
): Promise<string> {
  const search = new URLSearchParams()
  const projectId = await resolveProviderProjectId(selector)
  if (projectId) {
    search.set('projectId', projectId)
  }
  const worktreeId = await resolveWorktreeId(projectId, worktreeSelector)
  if (worktreeId) {
    search.set('worktreeId', worktreeId)
  }
  for (const [key, value] of Object.entries(extra)) {
    search.set(key, value)
  }
  return search.toString()
}

export function readProjectId(
  input: Pick<ProviderSelectorParams, 'repo' | 'repoId' | 'projectId'>
): string | null {
  const raw =
    readNonEmptyString(input.repo) ??
    readNonEmptyString(input.repoId) ??
    readNonEmptyString(input.projectId)
  if (!raw) {
    return null
  }
  return raw.startsWith('id:') ? raw.slice('id:'.length) : raw
}

async function resolveProviderProjectId(selector: ProviderSelectorParams): Promise<string | null> {
  const direct = readProjectId(selector)
  if (direct) {
    return direct
  }
  const repoPath = readNonEmptyString(selector.repoPath)
  if (!repoPath) {
    return null
  }
  const repos = await readRepos()
  return repos.find((repo) => repo.path === repoPath)?.id ?? null
}

export function readWorktreeSelector(input: ProviderSelectorParams): unknown {
  const worktreePath = readNonEmptyString(input.worktreePath)
  return input.worktree ?? input.worktreeId ?? (worktreePath ? `path:${worktreePath}` : null)
}

async function resolveWorktreeId(
  projectId: string | null,
  selector: unknown
): Promise<string | null> {
  const raw = readNonEmptyString(selector)
  if (!raw) {
    return null
  }
  const direct = readRuntimeWorktreeSelectorId(raw)
  if (direct) {
    return direct
  }
  if (!projectId) {
    return null
  }
  const worktrees = await readWorktrees(projectId)
  const match = findWorktreeBySelector(worktrees, raw)
  return match?.id ?? null
}

function readRuntimeWorktreeSelectorId(raw: string): string | null {
  if (raw.startsWith('id:worktree:')) {
    return raw.slice('id:worktree:'.length)
  }
  if (raw.startsWith('worktree:')) {
    return raw.slice('worktree:'.length)
  }
  if (raw.startsWith('id:')) {
    return raw.slice('id:'.length)
  }
  return raw.includes(':') ? null : raw
}

function findWorktreeBySelector(
  worktrees: {
    id: string
    path?: string
    branch?: string
    displayName?: string
  }[],
  selector: string
): { id: string } | null {
  if (selector.startsWith('path:')) {
    const path = selector.slice('path:'.length)
    return worktrees.find((entry) => entry.path === path) ?? null
  }
  if (selector.startsWith('branch:')) {
    const branch = selector.slice('branch:'.length)
    return worktrees.find((entry) => entry.branch === branch) ?? null
  }
  if (selector.startsWith('name:')) {
    const name = selector.slice('name:'.length)
    return (
      worktrees.find((entry) => entry.displayName === name || basename(entry.path) === name) ?? null
    )
  }
  return null
}

function basename(path: string | undefined): string | null {
  if (!path) {
    return null
  }
  return path.split(/[\\/]/).filter(Boolean).pop() ?? null
}

function readStringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function coercePositiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}
