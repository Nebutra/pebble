import type {
  GitHubAssignableUser,
  GitHubIssueUpdate
} from '../../../packages/product-core/shared/types'
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

type GitHubIssueMetadataParams = ProviderSelectorParams & {
  number?: unknown
  title?: unknown
  body?: unknown
  labels?: unknown
  assignees?: unknown
  query?: unknown
  updates?: unknown
}

type GitHubIssueCreateResult =
  | { ok: true; number: number; url: string }
  | { ok: false; error: string }

export async function createGitHubIssue(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GitHubIssueCreateResult> {
  const input = params as GitHubIssueMetadataParams
  return requestJson<GitHubIssueCreateResult>('/v1/providers/github/issues/create', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      ...(await mutationSelector(input)),
      title: readString(input.title),
      body: readString(input.body),
      labels: readStringArray(input.labels),
      assignees: readStringArray(input.assignees)
    }
  })
}

export async function updateGitHubIssue(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const input = params as GitHubIssueMetadataParams
  return requestJson('/v1/providers/github/issues/update', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      ...(await mutationSelector(input)),
      number: readPositiveInt(input.number),
      updates: readGitHubIssueUpdate(input.updates)
    }
  })
}

export async function countGitHubWorkItems(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<number> {
  const input = params as GitHubIssueMetadataParams
  const query = await providerQuery(
    input,
    readWorktreeSelector(input),
    readString(input.query) ? { query: readString(input.query) } : {}
  )
  const result = await requestJson<{ count: number }>(
    `/v1/providers/github/work-items/count?${query}`
  )
  return result.count
}

export async function fetchGitHubLabels(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<string[]> {
  const input = params as GitHubIssueMetadataParams
  const query = await providerQuery(input, readWorktreeSelector(input), {})
  const result = await requestJson<{ labels: string[] }>(`/v1/providers/github/labels?${query}`)
  return result.labels ?? []
}

export async function fetchGitHubAssignableUsers(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<GitHubAssignableUser[]> {
  const input = params as GitHubIssueMetadataParams
  const query = await providerQuery(input, readWorktreeSelector(input), {})
  const result = await requestJson<{ users: GitHubAssignableUser[] }>(
    `/v1/providers/github/assignable-users?${query}`
  )
  return result.users ?? []
}

async function mutationSelector(input: GitHubIssueMetadataParams): Promise<{
  projectId: string
  worktreeId?: string
}> {
  const query = new URLSearchParams(await providerQuery(input, readWorktreeSelector(input), {}))
  const projectId = query.get('projectId') ?? readProjectId(input)
  if (!projectId) {
    throw new Error('GitHub issue action requires a registered project')
  }
  const worktreeId = query.get('worktreeId')
  return { projectId, ...(worktreeId ? { worktreeId } : {}) }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function readPositiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

function readGitHubIssueUpdate(value: unknown): GitHubIssueUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const input = value as Record<string, unknown>
  return {
    ...(input.state === 'open' || input.state === 'closed' ? { state: input.state } : {}),
    ...(input.stateReason === 'completed' ||
    input.stateReason === 'not_planned' ||
    input.stateReason === 'duplicate'
      ? { stateReason: input.stateReason }
      : {}),
    ...(typeof input.duplicateOf === 'number' ? { duplicateOf: input.duplicateOf } : {}),
    ...(typeof input.title === 'string' ? { title: input.title } : {}),
    ...(typeof input.body === 'string' ? { body: input.body } : {}),
    ...readIssueStringArrays(input)
  }
}

function readIssueStringArrays(input: Record<string, unknown>): Partial<GitHubIssueUpdate> {
  const output: Partial<GitHubIssueUpdate> = {}
  for (const key of ['addLabels', 'removeLabels', 'addAssignees', 'removeAssignees'] as const) {
    if (Array.isArray(input[key])) {
      output[key] = input[key].filter((entry): entry is string => typeof entry === 'string')
    }
  }
  return output
}
