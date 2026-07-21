import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../packages/product-core/shared/types'

const { invokeMock, requestRuntimeJsonMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  requestRuntimeJsonMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))

import {
  getTauriBaseRefDefault,
  resolveTauriMrBase,
  resolveTauriPrBase,
  searchTauriBaseRefDetails
} from './tauri-git-base-ref-api'

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'project-1',
    name: 'Pebble',
    path: '/workspace/pebble',
    defaultBranch: 'main',
    ...overrides
  } as Repo
}

describe('Tauri git base refs', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the Go runtime relay for SSH repositories', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce({ defaultBaseRef: 'origin/main', remoteCount: 1 })
      .mockResolvedValueOnce([{ refName: 'origin/main', localBranchName: 'main' }])
    const repos = Promise.resolve([repo({ connectionId: 'ssh-host-1' })])

    await expect(getTauriBaseRefDefault(repos, 'project-1')).resolves.toEqual({
      defaultBaseRef: 'origin/main',
      remoteCount: 1
    })
    await expect(
      searchTauriBaseRefDetails(repos, { repoId: 'project-1', query: 'main', limit: 12 })
    ).resolves.toEqual([{ refName: 'origin/main', localBranchName: 'main' }])

    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      1,
      '/v1/git/base-refs/default?projectId=project-1',
      { method: 'GET' }
    )
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      2,
      '/v1/git/base-refs/search?projectId=project-1&query=main&limit=12',
      { method: 'GET' }
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('keeps local repositories on the Rust host command', async () => {
    invokeMock.mockResolvedValue({ defaultBaseRef: 'origin/main', remoteCount: 1 })

    await getTauriBaseRefDefault(Promise.resolve([repo()]), 'project-1')

    expect(invokeMock).toHaveBeenCalledWith('git_get_base_ref_default', {
      input: { repoPath: '/workspace/pebble' }
    })
    expect(requestRuntimeJsonMock).not.toHaveBeenCalled()
  })

  it('resolves SSH PR and MR start points through the relay runtime', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce({ baseBranch: 'abc123', headSha: 'abc123' })
      .mockResolvedValueOnce({
        baseBranch: 'origin/topic',
        pushTarget: { remoteName: 'origin', branchName: 'topic' }
      })
    const repos = Promise.resolve([repo({ connectionId: 'ssh-host-1' })])

    await resolveTauriPrBase(repos, {
      repoId: 'project-1',
      prNumber: 42,
      headRefName: 'topic',
      baseRefName: 'main',
      isCrossRepository: true
    })
    await resolveTauriMrBase(repos, {
      repoId: 'project-1',
      mrIid: 7,
      sourceBranch: 'topic',
      targetBranch: 'main'
    })

    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(1, '/v1/git/review-start', {
      method: 'POST',
      body: {
        projectId: 'project-1',
        kind: 'pr',
        number: 42,
        head: 'topic',
        base: 'main',
        isCrossRepository: true
      }
    })
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(2, '/v1/git/review-start', {
      method: 'POST',
      body: {
        projectId: 'project-1',
        kind: 'mr',
        number: 7,
        head: 'topic',
        base: 'main',
        isCrossRepository: undefined
      }
    })
  })
})
