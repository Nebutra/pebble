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
  fetchGitLabTodos,
  fetchGitLabWorkItemByPath,
  fetchGitLabWorkItemDetails
} from './tauri-gitlab-work-item-details-bridge'

describe('Tauri GitLab work-item detail bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readReposMock.mockResolvedValue([{ id: 'proj-1', path: '/workspace/pebble' }])
    readWorktreesMock.mockResolvedValue([])
  })

  it('loads todos through a canonical repoPath selector', async () => {
    const requestJson = vi.fn().mockResolvedValue([{ id: 1 }])
    await expect(fetchGitLabTodos(requestJson, { repoPath: '/workspace/pebble' })).resolves.toEqual(
      [{ id: 1 }]
    )
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/gitlab/todos?projectId=proj-1')
  })

  it('preserves explicit project identity for full details', async () => {
    const response = { item: { id: 'gitlab-mr-9' }, body: 'MR body', comments: [] }
    const requestJson = vi.fn().mockResolvedValue(response)
    await expect(
      fetchGitLabWorkItemDetails(requestJson, {
        repo: 'proj-1',
        worktreeId: 'wt-1',
        iid: 9,
        type: 'mr',
        projectRef: { host: 'git.internal', path: 'group/sub/project' }
      })
    ).resolves.toEqual(response)
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/gitlab/work-item-details?projectId=proj-1&worktreeId=wt-1&iid=9&type=mr&host=git.internal&path=group%2Fsub%2Fproject'
    )
  })

  it('routes pasted URL lookups by host and nested project path', async () => {
    const requestJson = vi.fn().mockResolvedValue({ id: 'gitlab-issue-81' })
    await expect(
      fetchGitLabWorkItemByPath(requestJson, {
        repo: 'proj-1',
        host: 'git.internal',
        path: 'group/sub/project',
        iid: 8,
        type: 'issue'
      })
    ).resolves.toEqual({ id: 'gitlab-issue-81' })
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/gitlab/work-item-by-path?projectId=proj-1&host=git.internal&path=group%2Fsub%2Fproject&iid=8&type=issue'
    )
  })
})
