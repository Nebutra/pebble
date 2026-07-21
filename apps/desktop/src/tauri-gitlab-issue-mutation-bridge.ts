import type {
  GitLabCommentResult,
  GitLabIssueUpdate,
  GitLabProjectRef
} from '../../../packages/product-core/shared/gitlab-types'
import {
  providerQuery,
  readProjectId,
  readWorktreeSelector,
  type ProviderSelectorParams
} from './tauri-provider-review-bridge'

type RuntimeGetJson = <T>(path: string) => Promise<T>
type RuntimePostJson = <T>(
  path: string,
  options: { method: 'POST'; body?: unknown; timeoutMs?: number }
) => Promise<T>

type CreateGitLabIssueResult =
  | { ok: true; number: number; url: string }
  | { ok: false; error: string }

type UpdateGitLabIssueResult = { ok: true } | { ok: false; error: string }

type GitLabIssueMutationParams = ProviderSelectorParams & {
  number?: unknown
  title?: unknown
  body?: unknown
  updates?: unknown
  projectRef?: unknown
}

export async function fetchGitLabLabels(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<string[]> {
  const input = params as ProviderSelectorParams
  const query = await providerQuery(input, readWorktreeSelector(input), {})
  return requestJson<string[]>(`/v1/providers/gitlab/labels?${query}`)
}

export async function createGitLabIssue(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<CreateGitLabIssueResult> {
  const input = params as GitLabIssueMutationParams
  const selector = await mutationSelector(input)
  return requestJson<CreateGitLabIssueResult>('/v1/providers/gitlab/issues/create', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      ...selector,
      title: readString(input.title),
      body: readString(input.body)
    }
  })
}

export async function updateGitLabIssue(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<UpdateGitLabIssueResult> {
  const input = params as GitLabIssueMutationParams
  const selector = await mutationSelector(input)
  return requestJson<UpdateGitLabIssueResult>('/v1/providers/gitlab/issues/update', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      ...selector,
      number: readPositiveInt(input.number),
      updates: readGitLabIssueUpdate(input.updates),
      ...(readProjectRef(input.projectRef) ? { projectRef: readProjectRef(input.projectRef) } : {})
    }
  })
}

export async function addGitLabIssueComment(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GitLabCommentResult> {
  const input = params as GitLabIssueMutationParams
  const selector = await mutationSelector(input)
  return requestJson<GitLabCommentResult>('/v1/providers/gitlab/issues/comment', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      ...selector,
      number: readPositiveInt(input.number),
      body: readString(input.body),
      ...(readProjectRef(input.projectRef) ? { projectRef: readProjectRef(input.projectRef) } : {})
    }
  })
}

async function mutationSelector(input: GitLabIssueMutationParams): Promise<{
  projectId: string
  worktreeId?: string
}> {
  const query = new URLSearchParams(await providerQuery(input, readWorktreeSelector(input), {}))
  const projectId = query.get('projectId') ?? readProjectId(input)
  if (!projectId) {
    throw new Error('GitLab issue action requires a registered project')
  }
  const worktreeId = query.get('worktreeId')
  return { projectId, ...(worktreeId ? { worktreeId } : {}) }
}

function readGitLabIssueUpdate(value: unknown): GitLabIssueUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const input = value as Record<string, unknown>
  return {
    ...(input.state === 'opened' || input.state === 'closed' ? { state: input.state } : {}),
    ...(typeof input.title === 'string' ? { title: input.title } : {}),
    ...(typeof input.body === 'string' ? { body: input.body } : {}),
    ...readStringArrayField(input, 'addLabels'),
    ...readStringArrayField(input, 'removeLabels'),
    ...readStringArrayField(input, 'addAssignees'),
    ...readStringArrayField(input, 'removeAssignees')
  }
}

function readStringArrayField(
  input: Record<string, unknown>,
  key: 'addLabels' | 'removeLabels' | 'addAssignees' | 'removeAssignees'
): Partial<GitLabIssueUpdate> {
  const value = input[key]
  return Array.isArray(value)
    ? { [key]: value.filter((entry): entry is string => typeof entry === 'string') }
    : {}
}

function readProjectRef(value: unknown): GitLabProjectRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const input = value as Record<string, unknown>
  return typeof input.host === 'string' && typeof input.path === 'string' && input.path.trim()
    ? { host: input.host.trim(), path: input.path.trim() }
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readPositiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}
