import type {
  GitHubWorkItem,
  GitHubWorkItemDetails,
  IssueInfo,
  ListWorkItemsResult,
  PRComment
} from '../../../packages/product-core/shared/types'
import {
  providerQuery,
  readWorktreeSelector,
  type ProviderSelectorParams
} from './tauri-provider-review-bridge'

type RuntimeGetJson = <T>(path: string) => Promise<T>

type GitHubWorkItemParams = ProviderSelectorParams & {
  limit?: unknown
  query?: unknown
  before?: unknown
  number?: unknown
  type?: unknown
  owner?: unknown
  ownerRepo?: unknown
}

export async function fetchGitHubIssues(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<IssueInfo[]> {
  const input = params as GitHubWorkItemParams
  const query = await providerQuery(input, readWorktreeSelector(input), {
    limit: String(readPositiveInt(input.limit) ?? 20)
  })
  const result = await requestJson<{ items: IssueInfo[] }>(`/v1/providers/github/issues?${query}`)
  return result.items ?? []
}

export async function fetchGitHubWorkItems(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<ListWorkItemsResult<Omit<GitHubWorkItem, 'repoId'>>> {
  const input = params as GitHubWorkItemParams
  const extra: Record<string, string> = {
    limit: String(readPositiveInt(input.limit) ?? 24)
  }
  if (readString(input.query)) {
    extra.query = readString(input.query)
  }
  if (readString(input.before)) {
    extra.before = readString(input.before)
  }
  const query = await providerQuery(input, readWorktreeSelector(input), extra)
  return requestJson<ListWorkItemsResult<Omit<GitHubWorkItem, 'repoId'>>>(
    `/v1/providers/github/work-items?${query}`
  )
}

export async function fetchGitHubWorkItem(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<Omit<GitHubWorkItem, 'repoId'> | null> {
  const input = params as GitHubWorkItemParams
  const extra: Record<string, string> = {
    number: String(readPositiveInt(input.number) ?? 0)
  }
  const type = readItemType(input.type)
  if (type) {
    extra.type = type
  }
  if (readString(input.owner)) {
    extra.owner = readString(input.owner)
  }
  if (readString(input.ownerRepo)) {
    extra.repo = readString(input.ownerRepo)
  }
  const query = await providerQuery(input, readWorktreeSelector(input), extra)
  return requestJson<Omit<GitHubWorkItem, 'repoId'> | null>(
    `/v1/providers/github/work-item?${query}`
  )
}

export async function fetchGitHubIssue(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<IssueInfo | null> {
  const item = await fetchGitHubWorkItem(requestJson, {
    ...(params as Record<string, unknown>),
    type: 'issue'
  })
  return item
    ? {
        number: item.number,
        title: item.title,
        state: item.state === 'open' ? 'open' : 'closed',
        url: item.url,
        labels: item.labels
      }
    : null
}

export async function fetchGitHubWorkItemDetails(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<GitHubWorkItemDetails | null> {
  const input = params as GitHubWorkItemParams
  const extra: Record<string, string> = {
    number: String(readPositiveInt(input.number) ?? 0)
  }
  const type = readItemType(input.type)
  if (type) {
    extra.type = type
  }
  const query = await providerQuery(input, readWorktreeSelector(input), extra)
  return requestJson<GitHubWorkItemDetails | null>(
    `/v1/providers/github/work-item-details?${query}`
  )
}

export async function fetchGitHubPRComments(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<PRComment[]> {
  const input = params as GitHubWorkItemParams
  const query = await providerQuery(input, readWorktreeSelector(input), {
    number: String(readPositiveInt(input.number) ?? 0)
  })
  return requestJson<PRComment[]>(`/v1/providers/github/pulls/comments?${query}`)
}

function readPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function readItemType(value: unknown): 'issue' | 'pr' | null {
  return value === 'issue' || value === 'pr' ? value : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
