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
  countGitHubWorkItems,
  createGitHubIssue,
  fetchGitHubAssignableUsers,
  fetchGitHubLabels,
  updateGitHubIssue
} from './tauri-github-issue-metadata-bridge'

describe('Tauri GitHub issue metadata bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readReposMock.mockResolvedValue([{ id: 'proj-1', path: '/workspace/pebble' }])
    readWorktreesMock.mockResolvedValue([])
  })

  it('creates issues with explicit metadata through the registered project', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true, number: 42, url: 'https://gh/42' })
    await expect(
      createGitHubIssue(requestJson, {
        repoPath: '/workspace/pebble',
        title: 'Ship',
        body: 'Body',
        labels: ['bug'],
        assignees: ['octocat']
      })
    ).resolves.toMatchObject({ ok: true, number: 42 })
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/github/issues/create', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        projectId: 'proj-1',
        title: 'Ship',
        body: 'Body',
        labels: ['bug'],
        assignees: ['octocat']
      }
    })
  })

  it('unwraps count, labels, and assignable users', async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({ count: 17 })
      .mockResolvedValueOnce({ labels: ['bug'] })
      .mockResolvedValueOnce({ users: [{ login: 'octocat', name: null, avatarUrl: '' }] })
    await expect(
      countGitHubWorkItems(requestJson, { repo: 'proj-1', query: 'is:issue' })
    ).resolves.toBe(17)
    await expect(fetchGitHubLabels(requestJson, { repo: 'proj-1' })).resolves.toEqual(['bug'])
    await expect(fetchGitHubAssignableUsers(requestJson, { repo: 'proj-1' })).resolves.toHaveLength(
      1
    )
    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      '/v1/providers/github/work-items/count?projectId=proj-1&query=is%3Aissue'
    )
    expect(requestJson).toHaveBeenNthCalledWith(2, '/v1/providers/github/labels?projectId=proj-1')
    expect(requestJson).toHaveBeenNthCalledWith(
      3,
      '/v1/providers/github/assignable-users?projectId=proj-1'
    )
  })

  it('sends structured issue updates through the registered project', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true })
    await expect(
      updateGitHubIssue(requestJson, {
        repo: 'proj-1',
        number: 17,
        updates: {
          state: 'closed',
          stateReason: 'duplicate',
          duplicateOf: 9,
          title: 'New title',
          addLabels: ['bug']
        }
      })
    ).resolves.toEqual({ ok: true })
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/github/issues/update', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        projectId: 'proj-1',
        number: 17,
        updates: {
          state: 'closed',
          stateReason: 'duplicate',
          duplicateOf: 9,
          title: 'New title',
          addLabels: ['bug']
        }
      }
    })
  })
})
