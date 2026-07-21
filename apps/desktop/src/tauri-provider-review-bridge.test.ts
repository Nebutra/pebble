import { describe, expect, it, vi } from 'vitest'
import {
  addHostedReviewComment,
  fetchGitHubPRCheckDetails,
  fetchGitHubPRForBranch,
  fetchHostedReviewForBranch,
  fetchHostedReviewCreationEligibility,
  fetchGitLabIssues,
  fetchGitLabJobTrace,
  fetchGitLabWorkItems,
  fetchReviewWorkItems,
  mergeHostedReview,
  rerunGitHubPRChecks,
  retryGitLabJob,
  setHostedReviewAutoMerge,
  updateHostedReview,
  type ReviewWorkItem
} from './tauri-provider-review-bridge'

const item: ReviewWorkItem = {
  id: 'gitea-pr-3',
  type: 'pr',
  number: 3,
  title: 'docs',
  state: 'open',
  url: 'https://x/3',
  labels: [],
  updatedAt: '2026-01-01T00:00:00Z',
  author: 'u'
}

describe('GitHub check actions', () => {
  it('keeps linked PR lookup authoritative over fallback metadata', async () => {
    const pr = { number: 42, title: 'Fix', state: 'open' }
    const requestJson = vi.fn().mockResolvedValue({ pr })
    await expect(
      fetchGitHubPRForBranch(requestJson, {
        repo: 'id:repo-1',
        worktreeId: 'worktree-1',
        branch: 'feature/fix',
        linkedPRNumber: 42,
        fallbackPRNumber: 41,
        acceptMergedFallbackPR: true,
        currentHeadOid: 'abc123'
      })
    ).resolves.toEqual(pr)
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/github/pulls/for-branch', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        projectId: 'repo-1',
        worktreeId: 'worktree-1',
        branch: 'feature/fix',
        linkedPRNumber: 42,
        acceptMergedFallbackPR: true,
        currentHeadOid: 'abc123'
      }
    })
  })

  it('preserves native check identifiers, URL and cross-repository context for details', async () => {
    const details = { name: 'CI', status: 'completed', annotations: [], jobs: [] }
    const requestJson = vi.fn().mockResolvedValue({ details })
    await expect(
      fetchGitHubPRCheckDetails(requestJson, {
        repo: 'proj-1',
        worktreeId: 'wt-1',
        checkRunId: 12,
        workflowRunId: 34,
        checkName: 'CI',
        url: 'https://github.com/o/r/actions/runs/34',
        prRepo: { owner: 'upstream', repo: 'project' }
      })
    ).resolves.toEqual(details)
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/github/pulls/check-details?projectId=proj-1&worktreeId=wt-1&checkRunId=12&workflowRunId=34&checkName=CI&url=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Factions%2Fruns%2F34&owner=upstream&repo=project'
    )
  })

  it('posts a bounded rerun request through the Go provider route', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true, count: 2 })
    await expect(
      rerunGitHubPRChecks(requestJson, {
        repo: 'proj-1',
        worktreeId: 'wt-1',
        prNumber: 42,
        headSha: 'abc123',
        failedOnly: true
      })
    ).resolves.toEqual({ ok: true, count: 2 })
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/github/pulls/checks/rerun', {
      method: 'POST',
      timeoutMs: 60_000,
      body: {
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        prNumber: 42,
        headSha: 'abc123',
        failedOnly: true
      }
    })
  })

  it('rejects malformed rerun requests before reaching the runtime', async () => {
    const requestJson = vi.fn()
    await expect(
      rerunGitHubPRChecks(requestJson, { repo: 'proj-1', prNumber: 0 })
    ).resolves.toEqual({ ok: false, error: 'Invalid pull request number' })
    expect(requestJson).not.toHaveBeenCalled()
  })
})

describe('GitLab pipeline job actions', () => {
  it('posts self-hosted project context for trace and retry', async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, trace: 'failed output' })
      .mockResolvedValueOnce({ ok: true, job: { id: 100, name: 'test' } })
    const params = {
      repo: 'proj-1',
      worktreeId: 'wt-1',
      jobId: 99,
      projectRef: { host: 'git.internal', path: 'group/sub/project' }
    }
    await expect(fetchGitLabJobTrace(requestJson, params)).resolves.toEqual({
      ok: true,
      trace: 'failed output'
    })
    await expect(retryGitLabJob(requestJson, params)).resolves.toMatchObject({
      ok: true,
      job: { id: 100 }
    })
    const body = {
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      jobId: 99,
      projectRef: { host: 'git.internal', path: 'group/sub/project' }
    }
    expect(requestJson).toHaveBeenNthCalledWith(1, '/v1/providers/gitlab/jobs/trace', {
      method: 'POST',
      timeoutMs: 30_000,
      body
    })
    expect(requestJson).toHaveBeenNthCalledWith(2, '/v1/providers/gitlab/jobs/retry', {
      method: 'POST',
      timeoutMs: 30_000,
      body
    })
  })

  it('rejects malformed job identifiers before runtime I/O', async () => {
    const requestJson = vi.fn()
    await expect(fetchGitLabJobTrace(requestJson, { repo: 'proj-1', jobId: 0 })).rejects.toThrow(
      'positive jobId'
    )
    expect(requestJson).not.toHaveBeenCalled()
  })
})

describe('GitLab issue and combined work-item reads', () => {
  it('prefers an explicitly linked GitLab MR over a same-branch GitHub PR', async () => {
    const requestJson = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'gitlab-mr-9',
          type: 'mr',
          number: 9,
          title: 'MR',
          state: 'opened',
          url: 'https://gitlab.test/mr/9',
          labels: [],
          updatedAt: '2026-07-18T00:00:00Z',
          author: null,
          branchName: 'main'
        }
      ]
    })

    await expect(
      fetchHostedReviewForBranch(requestJson, {
        repo: 'proj-1',
        worktreeId: 'wt-1',
        branch: 'main',
        linkedGitHubPR: null,
        linkedGitLabMR: 9
      })
    ).resolves.toMatchObject({ provider: 'gitlab', number: 9 })
    expect(requestJson).toHaveBeenCalledOnce()
    expect(requestJson.mock.calls[0]?.[0]).toContain('/v1/providers/gitlab/merge-requests?')
  })

  it('preserves issue filters and the structured error envelope', async () => {
    const response = {
      items: [{ number: 8, title: 'Issue', state: 'opened', url: 'https://gl/8', labels: [] }],
      error: { type: 'permission_denied', message: 'partial' }
    }
    const requestJson = vi.fn().mockResolvedValue(response)
    await expect(
      fetchGitLabIssues(requestJson, {
        repo: 'proj-1',
        worktreeId: 'wt-1',
        state: 'all',
        assignee: '@me',
        limit: 25
      })
    ).resolves.toEqual(response)
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/gitlab/issues?projectId=proj-1&worktreeId=wt-1&limit=25&state=all&assignee=%40me'
    )
  })

  it('stamps repo identity and keeps combined pagination semantics', async () => {
    const requestJson = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'gitlab-issue-8',
          type: 'issue',
          number: 8,
          title: 'Issue',
          state: 'opened',
          url: 'https://gl/8',
          labels: [],
          updatedAt: '2026-07-15T00:00:00Z',
          author: null,
          projectRef: { host: 'git.internal', path: 'g/p' }
        }
      ]
    })
    await expect(
      fetchGitLabWorkItems(requestJson, {
        repo: 'proj-1',
        worktreeId: 'wt-1',
        state: 'opened',
        page: 2,
        perPage: 20,
        query: 'review me'
      })
    ).resolves.toMatchObject({
      page: 2,
      perPage: 20,
      totalCount: 1,
      totalPages: 2,
      items: [{ repoId: 'proj-1', projectRef: { host: 'git.internal', path: 'g/p' } }]
    })
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/gitlab/work-items?projectId=proj-1&worktreeId=wt-1&page=2&perPage=20&state=opened&query=review+me'
    )
  })
})

describe('REST-backed hosted review creation', () => {
  it('resolves an explicitly linked Gitea review before provider detection', async () => {
    const requestJson = vi.fn().mockResolvedValue({
      items: [{ ...item, number: 17, branchName: 'feature/review' }]
    })

    await expect(
      fetchHostedReviewForBranch(requestJson, {
        repo: 'proj-1',
        branch: 'feature/review',
        linkedGiteaPR: 17
      })
    ).resolves.toMatchObject({ provider: 'gitea', number: 17 })
    expect(requestJson).toHaveBeenCalledOnce()
    expect(requestJson.mock.calls[0]?.[0]).toContain('/v1/providers/gitea/pulls?')
  })

  it('allows creation for an authenticated Bitbucket branch with no existing review', async () => {
    const requestJsonMock = vi.fn(async (path: string) =>
      path.startsWith('/v1/providers/review-capabilities?')
        ? {
            provider: 'bitbucket',
            authenticated: true,
            currentBranch: 'feature/review',
            defaultBaseRef: 'main'
          }
        : { items: [] }
    )
    const requestJson = requestJsonMock as unknown as <T>(path: string) => Promise<T>

    await expect(
      fetchHostedReviewCreationEligibility(requestJson, {
        repo: 'proj-1',
        branch: 'feature/review',
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).resolves.toMatchObject({
      provider: 'bitbucket',
      canCreate: true,
      blockedReason: null
    })
    expect(
      requestJsonMock.mock.calls.some(([path]) =>
        String(path).startsWith('/v1/providers/bitbucket/pulls?')
      )
    ).toBe(true)
    expect(
      requestJsonMock.mock.calls.filter(([path]) =>
        String(path).startsWith('/v1/providers/review-capabilities?')
      )
    ).toHaveLength(1)
  })
})

describe('addHostedReviewComment', () => {
  it('preserves a GitHub cross-repository target', async () => {
    const response = {
      ok: true,
      comment: {
        id: 1,
        author: 'octocat',
        authorAvatarUrl: '',
        body: 'Done',
        createdAt: 'now',
        url: ''
      }
    }
    const requestJson = vi.fn().mockResolvedValue(response)
    await expect(
      addHostedReviewComment(requestJson, {
        repo: 'proj-1',
        provider: 'github',
        number: 3,
        body: 'Done',
        prRepo: { owner: 'upstream', repo: 'project' }
      })
    ).resolves.toEqual(response)
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/reviews/comments', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        projectId: 'proj-1',
        provider: 'github',
        number: 3,
        body: 'Done',
        owner: 'upstream',
        repo: 'project'
      }
    })
  })
})

describe('mergeHostedReview', () => {
  it('posts the selected provider merge method', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true })
    await expect(
      mergeHostedReview(requestJson, {
        repo: 'proj-1',
        worktreeId: 'wt-1',
        provider: 'gitlab',
        number: 9,
        method: 'rebase'
      })
    ).resolves.toEqual({ ok: true })
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/reviews/merge', {
      method: 'POST',
      timeoutMs: 60_000,
      body: {
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        provider: 'gitlab',
        number: 9,
        method: 'rebase'
      }
    })
  })
})

describe('setHostedReviewAutoMerge', () => {
  it('posts explicit enable state and merge method', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true })
    await expect(
      setHostedReviewAutoMerge(requestJson, {
        repo: 'proj-1',
        number: 5,
        enabled: false,
        method: 'squash'
      })
    ).resolves.toEqual({ ok: true })
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/reviews/auto-merge', {
      method: 'POST',
      timeoutMs: 60_000,
      body: { projectId: 'proj-1', number: 5, enabled: false, method: 'squash' }
    })
  })
})

describe('fetchReviewWorkItems', () => {
  it('routes each REST-backed provider to its runtime path with selector and filters', async () => {
    const requestJson = vi.fn().mockResolvedValue({ items: [item] })
    const result = await fetchReviewWorkItems(requestJson, {
      repo: 'proj-1',
      worktreeId: 'wt-1',
      provider: 'gitea',
      state: 'merged',
      limit: 5
    })
    expect(result).toEqual([item])
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/gitea/pulls?projectId=proj-1&worktreeId=wt-1&limit=5&state=merged'
    )
  })

  it.each(['bitbucket', 'azure-devops'])('supports the %s provider route', async (provider) => {
    const requestJson = vi.fn().mockResolvedValue({ items: [] })
    await fetchReviewWorkItems(requestJson, { repo: 'p', provider })
    expect(requestJson).toHaveBeenCalledWith(`/v1/providers/${provider}/pulls?projectId=p`)
  })

  it('omits invalid limit and blank state from the query', async () => {
    const requestJson = vi.fn().mockResolvedValue({ items: [] })
    await fetchReviewWorkItems(requestJson, {
      repo: 'p',
      provider: 'bitbucket',
      state: '  ',
      limit: 'not-a-number'
    })
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/bitbucket/pulls?projectId=p')
  })

  it('rejects providers outside the REST-backed set instead of guessing a route', async () => {
    const requestJson = vi.fn()
    await expect(
      fetchReviewWorkItems(requestJson, { repo: 'p', provider: 'github' })
    ).rejects.toThrow('Unsupported review provider: github')
    await expect(fetchReviewWorkItems(requestJson, { repo: 'p' })).rejects.toThrow(
      'Unsupported review provider: undefined'
    )
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('returns an empty list when the runtime omits items', async () => {
    const requestJson = vi.fn().mockResolvedValue({})
    await expect(
      fetchReviewWorkItems(requestJson, { repo: 'p', provider: 'gitea' })
    ).resolves.toEqual([])
  })
})

describe('updateHostedReview', () => {
  it('posts title/body edits to the runtime update route', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true })
    const result = await updateHostedReview(requestJson, {
      repo: 'proj-1',
      provider: 'github',
      number: 42,
      title: 'New title',
      body: 'New body'
    })
    expect(result).toEqual({ ok: true })
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/reviews/update', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        projectId: 'proj-1',
        provider: 'github',
        number: 42,
        title: 'New title',
        body: 'New body'
      }
    })
  })

  it('normalizes GitLab "opened" state to the provider-neutral "open"', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true })
    await updateHostedReview(requestJson, {
      repo: 'proj-1',
      provider: 'gitlab',
      number: 7,
      state: 'opened'
    })
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/reviews/update',
      expect.objectContaining({ body: expect.objectContaining({ state: 'open' }) })
    )
  })

  it('maps GitHub baseRefName and draft intent without changing provider semantics', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true })
    await updateHostedReview(requestJson, {
      repo: 'proj-1',
      provider: 'github',
      number: 42,
      baseRefName: 'release/next',
      draft: true,
      prRepo: { owner: 'upstream', repo: 'project' }
    })
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/reviews/update',
      expect.objectContaining({
        body: expect.objectContaining({
          provider: 'github',
          base: 'release/next',
          draft: true,
          owner: 'upstream',
          repo: 'project'
        })
      })
    )
  })

  it('maps GitLab targetBranch and preserves draft false as a ready transition', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true })
    await updateHostedReview(requestJson, {
      repo: 'proj-1',
      provider: 'gitlab',
      number: 7,
      targetBranch: 'stable',
      draft: false
    })
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/reviews/update',
      expect.objectContaining({
        body: expect.objectContaining({
          provider: 'gitlab',
          base: 'stable',
          draft: false
        })
      })
    )
  })

  it('preserves an empty GitLab reviewer list as an explicit clear operation', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true, reviewers: [] })
    const result = await updateHostedReview(requestJson, {
      repo: 'proj-1',
      provider: 'gitlab',
      number: 7,
      reviewerIds: []
    })
    expect(result).toEqual({ ok: true, reviewers: [] })
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/reviews/update',
      expect.objectContaining({ body: expect.objectContaining({ reviewerIds: [] }) })
    )
  })

  it('includes only non-empty reviewer lists', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true })
    await updateHostedReview(requestJson, {
      repo: 'proj-1',
      provider: 'github',
      number: 3,
      addReviewers: ['octocat'],
      removeReviewers: []
    })
    const body = requestJson.mock.calls[0][1].body
    expect(body.addReviewers).toEqual(['octocat'])
    expect(body).not.toHaveProperty('removeReviewers')
  })

  it('surfaces the runtime error message on failure', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: false, error: 'gh not authenticated' })
    const result = await updateHostedReview(requestJson, {
      repo: 'proj-1',
      provider: 'github',
      number: 1,
      title: 'x'
    })
    expect(result).toEqual({ ok: false, error: 'gh not authenticated' })
  })

  it('rejects requests missing a repo or review number without calling the runtime', async () => {
    const requestJson = vi.fn()
    await expect(
      updateHostedReview(requestJson, { provider: 'github', number: 1 })
    ).resolves.toEqual({
      ok: false,
      error: 'Update review failed: repository and review number are required.'
    })
    await expect(
      updateHostedReview(requestJson, { repo: 'proj-1', provider: 'github' })
    ).resolves.toEqual({
      ok: false,
      error: 'Update review failed: repository and review number are required.'
    })
    expect(requestJson).not.toHaveBeenCalled()
  })
})
