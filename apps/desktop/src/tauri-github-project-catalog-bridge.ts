import type {
  ListAccessibleProjectsResult,
  ListAssignableUsersBySlugResult,
  ListIssueTypesBySlugResult,
  ListLabelsBySlugResult,
  GitHubProjectCommentMutationResult,
  GitHubProjectMutationResult,
  GetProjectViewTableResult,
  ProjectWorkItemDetailsBySlugResult,
  ListProjectViewsResult,
  ResolveProjectRefResult
} from '../../../packages/product-core/shared/github-project-types'

type RuntimeGetJson = <T>(path: string) => Promise<T>
type RuntimePostJson = <T>(
  path: string,
  options: { method: 'POST'; body?: unknown; timeoutMs?: number }
) => Promise<T>

type GitHubProjectCatalogParams = {
  input?: unknown
  owner?: unknown
  ownerType?: unknown
  projectNumber?: unknown
}

export function fetchAccessibleGitHubProjects(
  requestJson: RuntimeGetJson
): Promise<ListAccessibleProjectsResult> {
  return requestJson('/v1/providers/github/projects')
}

export function resolveGitHubProjectRef(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<ResolveProjectRefResult> {
  const input = params as GitHubProjectCatalogParams
  const query = new URLSearchParams({ input: readString(input.input) })
  return requestJson(`/v1/providers/github/projects/resolve?${query}`)
}

export function fetchGitHubProjectViews(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<ListProjectViewsResult> {
  const input = params as GitHubProjectCatalogParams
  const query = new URLSearchParams({
    owner: readString(input.owner),
    ownerType: readOwnerType(input.ownerType),
    projectNumber: String(readPositiveInt(input.projectNumber))
  })
  return requestJson(`/v1/providers/github/projects/views?${query}`)
}

export function fetchGitHubProjectViewTable(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GetProjectViewTableResult> {
  const input = params as GitHubProjectCatalogParams & {
    viewId?: unknown
    viewNumber?: unknown
    viewName?: unknown
    queryOverride?: unknown
  }
  return requestJson('/v1/providers/github/projects/view-table', {
    method: 'POST',
    timeoutMs: 60_000,
    body: {
      owner: readString(input.owner),
      ownerType: readOwnerType(input.ownerType),
      projectNumber: readPositiveInt(input.projectNumber),
      viewId: readString(input.viewId),
      viewNumber: readPositiveInt(input.viewNumber),
      viewName: readString(input.viewName),
      ...(typeof input.queryOverride === 'string' ? { queryOverride: input.queryOverride } : {})
    }
  })
}

export function fetchGitHubProjectLabels(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<ListLabelsBySlugResult> {
  return requestJson(`/v1/providers/github/projects/repository/labels?${repoSlugQuery(params)}`)
}

export function fetchGitHubProjectAssignableUsers(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<ListAssignableUsersBySlugResult> {
  return requestJson(`/v1/providers/github/projects/repository/assignees?${repoSlugQuery(params)}`)
}

export function fetchGitHubProjectIssueTypes(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<ListIssueTypesBySlugResult> {
  return requestJson(
    `/v1/providers/github/projects/repository/issue-types?${repoSlugQuery(params)}`
  )
}

export function fetchGitHubProjectWorkItemDetails(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<ProjectWorkItemDetailsBySlugResult> {
  const input = params as GitHubProjectCatalogParams & {
    repo?: unknown
    number?: unknown
    type?: unknown
  }
  const query = repoSlugQuery(input)
  query.set('number', String(readPositiveInt(input.number)))
  query.set('type', input.type === 'pr' ? 'pr' : input.type === 'issue' ? 'issue' : '')
  return requestJson(`/v1/providers/github/projects/repository/work-item-details?${query}`)
}

export function updateGitHubProjectIssue(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GitHubProjectMutationResult> {
  const input = params as GitHubProjectCatalogParams & {
    repo?: unknown
    number?: unknown
    updates?: unknown
  }
  return requestJson('/v1/providers/github/projects/repository/issue/update', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      owner: readString(input.owner),
      repo: readString(input.repo),
      number: readPositiveInt(input.number),
      updates: readRecord(input.updates)
    }
  })
}

export function updateGitHubProjectPullRequest(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GitHubProjectMutationResult> {
  const input = params as GitHubProjectCatalogParams & {
    repo?: unknown
    number?: unknown
    updates?: unknown
  }
  return requestJson('/v1/providers/github/projects/repository/pull/update', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      owner: readString(input.owner),
      repo: readString(input.repo),
      number: readPositiveInt(input.number),
      pullUpdates: readRecord(input.updates)
    }
  })
}

export function addGitHubProjectIssueComment(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GitHubProjectCommentMutationResult> {
  return mutateProjectComment(
    requestJson,
    'add',
    params
  ) as Promise<GitHubProjectCommentMutationResult>
}

export function updateGitHubProjectIssueComment(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GitHubProjectMutationResult> {
  return mutateProjectComment(requestJson, 'update', params)
}

export function deleteGitHubProjectIssueComment(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GitHubProjectMutationResult> {
  return mutateProjectComment(requestJson, 'delete', params)
}

export function updateGitHubProjectItemField(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GitHubProjectMutationResult> {
  return mutateProjectField(requestJson, 'update', params)
}

export function clearGitHubProjectItemField(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GitHubProjectMutationResult> {
  return mutateProjectField(requestJson, 'clear', params)
}

function mutateProjectField(
  requestJson: RuntimePostJson,
  action: 'update' | 'clear',
  params: unknown
): Promise<GitHubProjectMutationResult> {
  const input = params as {
    projectId?: unknown
    itemId?: unknown
    fieldId?: unknown
    value?: unknown
  }
  return requestJson('/v1/providers/github/projects/fields', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      action,
      projectId: readString(input.projectId),
      itemId: readString(input.itemId),
      fieldId: readString(input.fieldId),
      value: readRecord(input.value)
    }
  })
}

export function updateGitHubProjectIssueType(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GitHubProjectMutationResult> {
  const input = params as GitHubProjectCatalogParams & {
    repo?: unknown
    number?: unknown
    issueTypeId?: unknown
  }
  return requestJson('/v1/providers/github/projects/repository/issue-type', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      owner: readString(input.owner),
      repo: readString(input.repo),
      number: readPositiveInt(input.number),
      issueTypeId: typeof input.issueTypeId === 'string' ? input.issueTypeId : null
    }
  })
}

function mutateProjectComment(
  requestJson: RuntimePostJson,
  action: 'add' | 'update' | 'delete',
  params: unknown
): Promise<GitHubProjectMutationResult | GitHubProjectCommentMutationResult> {
  const input = params as GitHubProjectCatalogParams & {
    repo?: unknown
    number?: unknown
    commentId?: unknown
    body?: unknown
  }
  return requestJson('/v1/providers/github/projects/repository/comments', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      action,
      owner: readString(input.owner),
      repo: readString(input.repo),
      number: readPositiveInt(input.number),
      commentId: readPositiveInt(input.commentId),
      body: readString(input.body)
    }
  })
}

function repoSlugQuery(params: unknown): URLSearchParams {
  const input = params as GitHubProjectCatalogParams & { repo?: unknown }
  return new URLSearchParams({ owner: readString(input.owner), repo: readString(input.repo) })
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readOwnerType(value: unknown): string {
  return value === 'organization' || value === 'user' ? value : ''
}

function readPositiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
