import type {
  GitLabAssignableUser,
  GitLabIssueInfo,
  GitLabProjectRef,
  MRInfo
} from '../../../packages/product-core/shared/types'
import {
  providerQuery,
  readWorktreeSelector,
  type ProviderSelectorParams
} from './tauri-provider-review-bridge'

type RuntimeGetJson = <T>(path: string) => Promise<T>

type GitLabMetadataParams = ProviderSelectorParams & {
  branch?: unknown
  linkedMRIid?: unknown
  iid?: unknown
  number?: unknown
}

export async function fetchGitLabProjectRef(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<GitLabProjectRef | null> {
  return requestJson(`/v1/providers/gitlab/project-ref?${await metadataQuery(params, {})}`)
}

export async function fetchGitLabMergeRequestForBranch(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<MRInfo | null> {
  const input = params as GitLabMetadataParams
  return requestJson(
    `/v1/providers/gitlab/merge-request-for-branch?${await metadataQuery(input, {
      branch: readString(input.branch),
      linkedMRIid: String(readPositiveInt(input.linkedMRIid))
    })}`
  )
}

export async function fetchGitLabMergeRequest(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<MRInfo | null> {
  const input = params as GitLabMetadataParams
  return requestJson(
    `/v1/providers/gitlab/merge-request?${await metadataQuery(input, {
      iid: String(readPositiveInt(input.iid))
    })}`
  )
}

export async function fetchGitLabIssue(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<GitLabIssueInfo | null> {
  const input = params as GitLabMetadataParams
  return requestJson(
    `/v1/providers/gitlab/issue?${await metadataQuery(input, {
      iid: String(readPositiveInt(input.number))
    })}`
  )
}

export async function fetchGitLabAssignableUsers(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<GitLabAssignableUser[]> {
  const result = await requestJson<{ users: GitLabAssignableUser[] }>(
    `/v1/providers/gitlab/assignable-users?${await metadataQuery(params, {})}`
  )
  return result.users ?? []
}

async function metadataQuery(params: unknown, extra: Record<string, string>): Promise<string> {
  const input = params as ProviderSelectorParams
  return providerQuery(input, readWorktreeSelector(input), extra)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readPositiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}
