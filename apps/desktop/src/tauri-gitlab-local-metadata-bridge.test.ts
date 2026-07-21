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
  fetchGitLabAssignableUsers,
  fetchGitLabIssue,
  fetchGitLabMergeRequest,
  fetchGitLabMergeRequestForBranch,
  fetchGitLabProjectRef
} from './tauri-gitlab-local-metadata-bridge'

describe('Tauri GitLab local metadata bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readReposMock.mockResolvedValue([{ id: 'proj-1', path: '/workspace/pebble' }])
    readWorktreesMock.mockResolvedValue([])
  })

  it('routes all formerly empty local reads through the registered project', async () => {
    const requestJson = vi.fn().mockResolvedValue(null)
    const selector = { repoPath: '/workspace/pebble' }

    await fetchGitLabProjectRef(requestJson, selector)
    await fetchGitLabMergeRequestForBranch(requestJson, {
      ...selector,
      branch: 'feature/fix',
      linkedMRIid: 9
    })
    await fetchGitLabMergeRequest(requestJson, { ...selector, iid: 7 })
    await fetchGitLabIssue(requestJson, { ...selector, number: 8 })
    requestJson.mockResolvedValueOnce({ users: [{ username: 'tanuki' }] })
    await expect(fetchGitLabAssignableUsers(requestJson, selector)).resolves.toEqual([
      { username: 'tanuki' }
    ])

    expect(requestJson.mock.calls.map(([path]) => path)).toEqual([
      '/v1/providers/gitlab/project-ref?projectId=proj-1',
      '/v1/providers/gitlab/merge-request-for-branch?projectId=proj-1&branch=feature%2Ffix&linkedMRIid=9',
      '/v1/providers/gitlab/merge-request?projectId=proj-1&iid=7',
      '/v1/providers/gitlab/issue?projectId=proj-1&iid=8',
      '/v1/providers/gitlab/assignable-users?projectId=proj-1'
    ])
  })
})
