import { describe, expect, it, vi } from 'vitest'
import { fetchReviewWorkItems, type ReviewWorkItem } from './tauri-provider-review-bridge'

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
