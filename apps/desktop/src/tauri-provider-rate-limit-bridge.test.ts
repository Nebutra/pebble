import { describe, expect, it, vi } from 'vitest'
import {
  fetchGitHubAuthDiagnostic,
  fetchGitHubRateLimit,
  fetchGitHubViewer,
  fetchGitLabAuthDiagnostic,
  fetchGitLabRateLimit,
  fetchGitLabViewer
} from './tauri-provider-rate-limit-bridge'

describe('provider rate-limit bridge', () => {
  it('routes a forced GitHub refresh to the native runtime', async () => {
    const result = { ok: true, snapshot: { fetchedAt: 1 } }
    const requestJson = vi.fn().mockResolvedValue(result)
    await expect(fetchGitHubRateLimit(requestJson, { force: true })).resolves.toEqual(result)
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/github/rate-limit?force=true')
  })

  it('preserves a self-hosted GitLab hostname and force flag', async () => {
    const result = { ok: true, snapshot: { fetchedAt: 1 } }
    const requestJson = vi.fn().mockResolvedValue(result)
    await expect(
      fetchGitLabRateLimit(requestJson, { force: true, host: 'git.internal' })
    ).resolves.toEqual(result)
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/gitlab/rate-limit?force=true&host=git.internal'
    )
  })

  it('does not emit empty GitLab query parameters', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true })
    await fetchGitLabRateLimit(requestJson, { host: '  ' })
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/gitlab/rate-limit')
  })

  it('routes provider identities and auth diagnostics to native endpoints', async () => {
    const requestJson = vi.fn().mockResolvedValue({})
    await fetchGitHubViewer(requestJson)
    await fetchGitHubAuthDiagnostic(requestJson)
    await fetchGitLabViewer(requestJson)
    await fetchGitLabAuthDiagnostic(requestJson)
    expect(requestJson.mock.calls.map(([path]) => path)).toEqual([
      '/v1/providers/github/viewer',
      '/v1/providers/github/auth-diagnostic',
      '/v1/providers/gitlab/viewer',
      '/v1/providers/gitlab/auth-diagnostic'
    ])
  })
})
