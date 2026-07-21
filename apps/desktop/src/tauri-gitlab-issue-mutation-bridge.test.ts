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
  addGitLabIssueComment,
  createGitLabIssue,
  fetchGitLabLabels,
  updateGitLabIssue
} from './tauri-gitlab-issue-mutation-bridge'

describe('Tauri GitLab issue mutation bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readReposMock.mockResolvedValue([{ id: 'proj-1', path: '/workspace/pebble' }])
    readWorktreesMock.mockResolvedValue([])
  })

  it('resolves canonical repoPath selectors for label reads', async () => {
    const requestJson = vi.fn().mockResolvedValue(['bug', 'backend'])
    await expect(
      fetchGitLabLabels(requestJson, {
        repoPath: '/workspace/pebble'
      })
    ).resolves.toEqual(['bug', 'backend'])
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/gitlab/labels?projectId=proj-1')
  })

  it('posts create input through the bounded native route', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true, number: 42, url: 'https://gl/42' })
    await expect(
      createGitLabIssue(requestJson, {
        repoId: 'proj-1',
        worktreeId: 'wt-1',
        title: 'Ship it',
        body: 'Body'
      })
    ).resolves.toEqual({ ok: true, number: 42, url: 'https://gl/42' })
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/gitlab/issues/create', {
      method: 'POST',
      timeoutMs: 30_000,
      body: { projectId: 'proj-1', worktreeId: 'wt-1', title: 'Ship it', body: 'Body' }
    })
  })

  it('preserves exact project identity and structured updates', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true })
    await updateGitLabIssue(requestJson, {
      repo: 'proj-1',
      number: 8,
      projectRef: { host: 'git.internal', path: 'group/sub/project' },
      updates: { state: 'closed', body: '', addLabels: ['bug'], removeAssignees: ['former'] }
    })
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/gitlab/issues/update', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        projectId: 'proj-1',
        number: 8,
        projectRef: { host: 'git.internal', path: 'group/sub/project' },
        updates: { state: 'closed', body: '', addLabels: ['bug'], removeAssignees: ['former'] }
      }
    })
  })

  it('maps issue comments onto the canonical GitLab comment result', async () => {
    const response = {
      ok: true,
      comment: {
        id: 9,
        author: 'tanuki',
        authorAvatarUrl: '',
        body: 'Done',
        createdAt: 'now',
        url: '',
        isBot: false
      }
    }
    const requestJson = vi.fn().mockResolvedValue(response)
    await expect(
      addGitLabIssueComment(requestJson, {
        repo: 'proj-1',
        number: 8,
        body: 'Done'
      })
    ).resolves.toEqual(response)
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/gitlab/issues/comment', {
      method: 'POST',
      timeoutMs: 30_000,
      body: { projectId: 'proj-1', number: 8, body: 'Done' }
    })
  })
})
