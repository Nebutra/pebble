import { describe, expect, it, vi } from 'vitest'
import {
  fetchReviewWorkItems,
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
    await expect(fetchReviewWorkItems(requestJson, { repo: 'p', provider: 'github' })).rejects.toThrow(
      'Unsupported review provider: github'
    )
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
