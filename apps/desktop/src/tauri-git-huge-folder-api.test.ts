import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestRuntimeJsonMock, readReposMock, readWorktreesMock } = vi.hoisted(() => ({
  requestRuntimeJsonMock: vi.fn(),
  readReposMock: vi.fn(),
  readWorktreesMock: vi.fn()
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))
vi.mock('./pebble-tauri-workspace-runtime-api', () => ({
  readRepos: readReposMock,
  readWorktrees: readWorktreesMock
}))

import {
  appendTauriHugeFolderToGitignore,
  findTauriHugeFoldersToIgnore
} from './tauri-git-huge-folder-api'

describe('Tauri huge-folder gitignore API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readReposMock.mockResolvedValue([{ id: 'project-1', path: '/repo' }])
    readWorktreesMock.mockResolvedValue([
      { id: 'worktree-1', repoId: 'project-1', path: '/repo/parallel' }
    ])
  })

  it('targets the registered parallel universe instead of trusting an absolute path', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce(['node_modules']).mockResolvedValueOnce(true)
    await expect(findTauriHugeFoldersToIgnore('/repo/parallel')).resolves.toEqual(['node_modules'])
    await expect(appendTauriHugeFolderToGitignore('/repo/parallel', 'node_modules')).resolves.toBe(
      true
    )
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(1, '/v1/source-control/huge-folders', {
      method: 'POST',
      timeoutMs: 5_000,
      body: { projectId: 'project-1', worktreeId: 'worktree-1' }
    })
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      2,
      '/v1/source-control/append-gitignore',
      {
        method: 'POST',
        timeoutMs: 5_000,
        body: { projectId: 'project-1', worktreeId: 'worktree-1', folderName: 'node_modules' }
      }
    )
  })

  it('rejects unregistered renderer paths before native I/O', async () => {
    await expect(findTauriHugeFoldersToIgnore('/unregistered')).rejects.toThrow('not registered')
    expect(requestRuntimeJsonMock).not.toHaveBeenCalled()
  })
})
