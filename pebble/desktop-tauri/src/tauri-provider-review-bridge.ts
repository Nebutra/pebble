// Bridges the renderer's provider RPC methods (github.prChecks, gitlab.listMRs)
// to the local Go runtime's /v1/providers routes, so PR/MR + review flows work
// without pairing a remote environment. Only methods whose full response shape
// the local gh/glab CLI paths can produce faithfully are routed here; anything
// else stays remote-gated in the dispatcher.
import type { PRCheckDetail } from '../../../src/shared/types'
import type { GitLabPagedResult, GitLabWorkItem } from '../../../src/shared/gitlab-types'

type RuntimeGetJson = <T>(path: string) => Promise<T>

// The renderer sends `repo` as the Pebble Repo.id, which is the runtime's
// projectId. Worktree-scoped callers may also pass worktreeId.
type ProviderSelectorParams = {
  repo?: unknown
  worktreeId?: unknown
}

// ── GitHub PR checks ────────────────────────────────────────────────
// github.prChecks resolves to PRCheckDetail[] (src/main/runtime/rpc/methods/github.ts
// → getRepoPRChecks). The Go route returns the same rows the `gh pr checks`
// fallback path produces in Electron.

type GitHubPRChecksParams = ProviderSelectorParams & {
  prNumber?: unknown
}

export async function fetchGitHubPRChecks(
  requestJson: RuntimeGetJson,
  params: unknown
): Promise<PRCheckDetail[]> {
  const { repo, worktreeId, prNumber } = params as GitHubPRChecksParams
  const number = coercePositiveInt(prNumber)
  if (number === null) {
    throw new Error('Missing pull request number')
  }
  const query = providerQuery(repo, worktreeId, { number: String(number) })
  const result = await requestJson<{ checks: PRCheckDetail[] }>(
    `/v1/providers/github/pulls/checks?${query}`
  )
  return result.checks ?? []
}

// ── GitLab MR list ──────────────────────────────────────────────────
// gitlab.listMRs resolves to GitLabPagedResult<GitLabWorkItem> (listGitLabRepoMRs
// → listMergeRequests). The Go route returns the mapped MR rows; totals mirror
// the CLI cwd-fallback in src/main/gitlab/client.ts, which the renderer already
// treats as approximate.

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
  const { repo, worktreeId, state, page, perPage, query } = params as GitLabListMRsParams
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
  const queryString = providerQuery(repo, worktreeId, extra)
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

function providerQuery(repo: unknown, worktreeId: unknown, extra: Record<string, string>): string {
  const search = new URLSearchParams()
  if (typeof repo === 'string' && repo.trim()) {
    search.set('projectId', repo.trim())
  }
  if (typeof worktreeId === 'string' && worktreeId.trim()) {
    search.set('worktreeId', worktreeId.trim())
  }
  for (const [key, value] of Object.entries(extra)) {
    search.set(key, value)
  }
  return search.toString()
}

function coercePositiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}
