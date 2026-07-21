import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readReposMock, readWorktreesMock } = vi.hoisted(() => ({
  readReposMock: vi.fn(),
  readWorktreesMock: vi.fn()
}))
vi.mock('./pebble-tauri-workspace-runtime-api', () => ({
  readRepos: readReposMock,
  readWorktrees: readWorktreesMock
}))

import {
  fetchGitHubIssue,
  fetchGitHubIssues,
  fetchGitHubPRComments,
  fetchGitHubWorkItem,
  fetchGitHubWorkItemDetails,
  fetchGitHubWorkItems
} from './tauri-github-work-items-bridge'

describe('Tauri GitHub work-item bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readReposMock.mockResolvedValue([{ id: 'proj-1', path: '/workspace/pebble' }])
    readWorktreesMock.mockResolvedValue([])
  })

  it('unwraps canonical issue arrays from repoPath selectors', async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValue({
        items: [{ number: 8, title: 'Issue', state: 'open', url: 'https://gh/8', labels: [] }]
      })
    await expect(
      fetchGitHubIssues(requestJson, { repoPath: '/workspace/pebble', limit: 25 })
    ).resolves.toHaveLength(1)
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/github/issues?projectId=proj-1&limit=25'
    )
  })

  it('preserves work-item source and partial-error envelopes', async () => {
    const response = {
      items: [],
      sources: {
        issues: { owner: 'o', repo: 'r' },
        prs: { owner: 'o', repo: 'r' },
        originCandidate: { owner: 'o', repo: 'r' },
        upstreamCandidate: null
      },
      errors: { issues: { type: 'permission_denied', message: 'no' } }
    }
    const requestJson = vi.fn().mockResolvedValue(response)
    await expect(
      fetchGitHubWorkItems(requestJson, {
        repo: 'proj-1',
        limit: 24,
        query: 'label:bug',
        before: '2026-07-01'
      })
    ).resolves.toEqual(response)
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/github/work-items?projectId=proj-1&limit=24&query=label%3Abug&before=2026-07-01'
    )
  })

  it('maps explicit owner/repo lookups and issue info separately', async () => {
    const row = {
      id: 'issue:8',
      type: 'issue',
      number: 8,
      title: 'Issue',
      state: 'open',
      url: 'https://gh/8',
      labels: ['bug'],
      updatedAt: 'now',
      author: 'octocat'
    }
    const requestJson = vi.fn().mockResolvedValue(row)
    await expect(
      fetchGitHubWorkItem(requestJson, {
        repo: 'proj-1',
        owner: 'other',
        ownerRepo: 'repo',
        number: 8,
        type: 'issue'
      })
    ).resolves.toEqual(row)
    await expect(fetchGitHubIssue(requestJson, { repo: 'proj-1', number: 8 })).resolves.toEqual({
      number: 8,
      title: 'Issue',
      state: 'open',
      url: 'https://gh/8',
      labels: ['bug']
    })
    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      '/v1/providers/github/work-item?projectId=proj-1&number=8&type=issue&owner=other&repo=repo'
    )
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      '/v1/providers/github/work-item?projectId=proj-1&number=8&type=issue'
    )
  })

  it('preserves the full work-item detail envelope', async () => {
    const response = {
      item: { id: 'issue:8', type: 'issue' },
      body: 'Body',
      comments: [],
      timelineItems: [],
      participants: []
    }
    const requestJson = vi.fn().mockResolvedValue(response)
    await expect(
      fetchGitHubWorkItemDetails(requestJson, { repo: 'proj-1', number: 8, type: 'issue' })
    ).resolves.toEqual(response)
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/github/work-item-details?projectId=proj-1&number=8&type=issue'
    )
  })

  it('loads full PR comments through the native provider route', async () => {
    const requestJson = vi.fn().mockResolvedValue([{ id: 1, author: 'alice', body: 'Hi' }])
    await expect(
      fetchGitHubPRComments(requestJson, { repo: 'proj-1', number: 7 })
    ).resolves.toHaveLength(1)
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/github/pulls/comments?projectId=proj-1&number=7'
    )
  })
})
