import type {
  GitLabProjectRef,
  GitLabTodo,
  GitLabWorkItem,
  GitLabWorkItemDetails
} from '../../../packages/product-core/shared/gitlab-types'
import {
  providerQuery,
  readWorktreeSelector,
  type ProviderSelectorParams
} from './tauri-provider-review-bridge'

type RuntimeGetJson = <T>(path: string) => Promise<T>

type GitLabWorkItemParams = ProviderSelectorParams & {
  iid?: unknown
  type?: unknown
  host?: unknown
  path?: unknown
  projectRef?: unknown
}

export async function fetchGitLabTodos(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<GitLabTodo[]> {
  const input = params as ProviderSelectorParams
  const query = await providerQuery(input, readWorktreeSelector(input), {})
  return requestJson<GitLabTodo[]>(`/v1/providers/gitlab/todos?${query}`)
}

export async function fetchGitLabWorkItemDetails(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<GitLabWorkItemDetails | null> {
  const input = params as GitLabWorkItemParams
  const projectRef = readProjectRef(input.projectRef)
  const query = await providerQuery(input, readWorktreeSelector(input), {
    iid: String(readPositiveInt(input.iid)),
    type: readItemType(input.type),
    ...(projectRef ? { host: projectRef.host, path: projectRef.path } : {})
  })
  return requestJson<GitLabWorkItemDetails | null>(
    `/v1/providers/gitlab/work-item-details?${query}`
  )
}

export async function fetchGitLabWorkItemByPath(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<Omit<GitLabWorkItem, 'repoId'> | null> {
  const input = params as GitLabWorkItemParams
  const host = readString(input.host)
  const path = readString(input.path)
  const query = await providerQuery(input, readWorktreeSelector(input), {
    host,
    path,
    iid: String(readPositiveInt(input.iid)),
    type: readItemType(input.type)
  })
  return requestJson<Omit<GitLabWorkItem, 'repoId'> | null>(
    `/v1/providers/gitlab/work-item-by-path?${query}`
  )
}

function readProjectRef(value: unknown): GitLabProjectRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const input = value as Record<string, unknown>
  const path = readString(input.path)
  return path ? { host: readString(input.host), path } : null
}

function readItemType(value: unknown): 'issue' | 'mr' | '' {
  return value === 'issue' || value === 'mr' ? value : ''
}

function readPositiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
