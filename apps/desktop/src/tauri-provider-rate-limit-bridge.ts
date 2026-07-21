import type { GhAuthDiagnostic } from '../../../packages/product-core/shared/github-auth-types'
import type {
  GetGitLabRateLimitResult,
  GetRateLimitResult,
  GitHubViewer,
  GitLabAuthDiagnostic,
  GitLabViewer
} from '../../../packages/product-core/shared/types'

type RuntimeGetJson = <T>(path: string) => Promise<T>

export function fetchGitHubRateLimit(
  requestJson: RuntimeGetJson,
  params?: { force?: boolean }
): Promise<GetRateLimitResult> {
  return requestJson<GetRateLimitResult>(
    `/v1/providers/github/rate-limit${params?.force ? '?force=true' : ''}`
  )
}

export function fetchGitLabRateLimit(
  requestJson: RuntimeGetJson,
  params?: { force?: boolean; host?: string | null }
): Promise<GetGitLabRateLimitResult> {
  const query = new URLSearchParams()
  if (params?.force) {
    query.set('force', 'true')
  }
  const host = params?.host?.trim()
  if (host) {
    query.set('host', host)
  }
  const suffix = query.size > 0 ? `?${query}` : ''
  return requestJson<GetGitLabRateLimitResult>(`/v1/providers/gitlab/rate-limit${suffix}`)
}

export function fetchGitHubViewer(requestJson: RuntimeGetJson): Promise<GitHubViewer | null> {
  return requestJson<GitHubViewer | null>('/v1/providers/github/viewer')
}

export function fetchGitHubAuthDiagnostic(requestJson: RuntimeGetJson): Promise<GhAuthDiagnostic> {
  return requestJson<GhAuthDiagnostic>('/v1/providers/github/auth-diagnostic')
}

export function fetchGitLabViewer(requestJson: RuntimeGetJson): Promise<GitLabViewer | null> {
  return requestJson<GitLabViewer | null>('/v1/providers/gitlab/viewer')
}

export function fetchGitLabAuthDiagnostic(
  requestJson: RuntimeGetJson
): Promise<GitLabAuthDiagnostic> {
  return requestJson<GitLabAuthDiagnostic>('/v1/providers/gitlab/auth-diagnostic')
}
