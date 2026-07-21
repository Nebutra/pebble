import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readReposMock, readWorktreesMock } = vi.hoisted(() => ({
  readReposMock: vi.fn(),
  readWorktreesMock: vi.fn()
}))

vi.mock('./pebble-tauri-workspace-runtime-api', () => ({
  readRepos: readReposMock,
  readWorktrees: readWorktreesMock
}))

import { fetchGitHubPRFileContents } from './tauri-github-pr-file-contents-bridge'

describe('Tauri GitHub PR file contents bridge', () => {
  beforeEach(() => {
    readReposMock.mockResolvedValue([{ id: 'proj-1', path: '/workspace/pebble' }])
    readWorktreesMock.mockResolvedValue([])
  })

  it('posts base/head file coordinates to the registered project', async () => {
    const requestJson = vi.fn().mockResolvedValue({
      original: 'old',
      modified: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
    await fetchGitHubPRFileContents(requestJson, {
      repoPath: '/workspace/pebble',
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      status: 'renamed',
      headSha: 'head',
      baseSha: 'base'
    })
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/github/pulls/file-contents', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        projectId: 'proj-1',
        file: {
          path: 'src/new.ts',
          oldPath: 'src/old.ts',
          status: 'renamed',
          headSha: 'head',
          baseSha: 'base'
        }
      }
    })
  })
})
