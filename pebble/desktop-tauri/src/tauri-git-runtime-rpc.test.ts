import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getRuntimeRepoIdMock, requestRuntimeJsonMock } = vi.hoisted(() => ({
  getRuntimeRepoIdMock: vi.fn(),
  requestRuntimeJsonMock: vi.fn()
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))

vi.mock('./pebble-tauri-workspace-runtime-api', () => ({
  getRuntimeRepoId: getRuntimeRepoIdMock
}))

import { callTauriGitRuntimeRpc } from './tauri-git-runtime-rpc'

beforeEach(() => {
  vi.clearAllMocks()
  getRuntimeRepoIdMock.mockReturnValue(undefined)
})

describe('callTauriGitRuntimeRpc', () => {
  it('maps github.repoSlug to the Go repository identity endpoint', async () => {
    getRuntimeRepoIdMock.mockReturnValue('repo-1')
    requestRuntimeJsonMock.mockResolvedValue({
      slug: { owner: 'nebutra', repo: 'pebble' },
      upstream: null
    })

    await expect(callTauriGitRuntimeRpc('github.repoSlug', { repo: 'id:repo-1' })).resolves.toEqual(
      {
        handled: true,
        result: { owner: 'nebutra', repo: 'pebble' }
      }
    )

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/source-control/repository-identity', {
      method: 'POST',
      timeoutMs: 5000,
      body: { projectId: 'repo-1' }
    })
  })

  it('maps github.repoUpstream through a worktree projection fallback', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/source-control?workspaceId=wt-1' && options?.method === 'GET') {
          return [
            {
              repositoryId: 'repo-1',
              workspaceId: 'wt-1',
              branch: 'main',
              ahead: 0,
              behind: 0,
              syncStatus: 'clean',
              changes: []
            }
          ]
        }
        if (path === '/v1/source-control/repository-identity' && options?.method === 'POST') {
          return {
            slug: { owner: 'fork', repo: 'pebble' },
            upstream: { owner: 'nebutra', repo: 'pebble' }
          }
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )

    await expect(
      callTauriGitRuntimeRpc('github.repoUpstream', { worktree: 'id:wt-1' })
    ).resolves.toEqual({
      handled: true,
      result: { owner: 'nebutra', repo: 'pebble' }
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/source-control/repository-identity', {
      method: 'POST',
      timeoutMs: 5000,
      body: { projectId: 'repo-1', worktreeId: 'wt-1' }
    })
  })

  it('maps local branch listing and checkout through Go source-control endpoints', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string; body?: unknown }) => {
        if (path === '/v1/source-control?workspaceId=wt-1' && options?.method === 'GET') {
          return [
            {
              repositoryId: 'repo-1',
              workspaceId: 'wt-1',
              branch: 'feature/x',
              ahead: 0,
              behind: 0,
              syncStatus: 'clean',
              changes: []
            }
          ]
        }
        if (path === '/v1/source-control/local-branches' && options?.method === 'POST') {
          return { current: 'feature/x', branches: ['feature/x', 'main'] }
        }
        if (path === '/v1/source-control/checkout' && options?.method === 'POST') {
          return { ok: true, branch: 'main' }
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )

    await expect(
      callTauriGitRuntimeRpc('git.localBranches', { worktree: 'id:wt-1' })
    ).resolves.toEqual({
      handled: true,
      result: { current: 'feature/x', branches: ['feature/x', 'main'] }
    })
    await expect(
      callTauriGitRuntimeRpc('git.checkout', { worktree: 'id:wt-1', branch: 'main' })
    ).resolves.toEqual({
      handled: true,
      result: { ok: true, branch: 'main' }
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/source-control/checkout', {
      method: 'POST',
      timeoutMs: 10_000,
      body: { projectId: 'repo-1', worktreeId: 'wt-1', branch: 'main' }
    })
  })

  it('rejects checkout branch names that Git would parse as flags', async () => {
    await expect(
      callTauriGitRuntimeRpc('git.checkout', { worktree: 'id:wt-1', branch: '--force' })
    ).rejects.toThrow('invalid_branch_name')
    expect(requestRuntimeJsonMock).not.toHaveBeenCalled()
  })

  it('keeps remote text-generation gaps scoped to the SSH relay', async () => {
    await expect(callTauriGitRuntimeRpc('git.generateCommitMessage', {})).resolves.toEqual({
      handled: true,
      result: {
        success: false,
        error:
          'Commit message generation for remote worktrees is not yet wired through the Tauri SSH relay.'
      }
    })

    expect(requestRuntimeJsonMock).not.toHaveBeenCalled()
  })
})

function projectionResponse(overrides: Record<string, unknown> = {}): Record<string, unknown>[] {
  return [
    {
      repositoryId: 'repo-1',
      workspaceId: 'wt-1',
      branch: 'feature',
      baseBranch: 'main',
      ahead: 0,
      behind: 0,
      syncStatus: 'dirty',
      changes: [],
      ...overrides
    }
  ]
}

describe('callTauriGitRuntimeRpc git.status conflict metadata', () => {
  it('maps conflict rows and the projection conflict operation', async () => {
    requestRuntimeJsonMock.mockResolvedValue(
      projectionResponse({
        conflictOperation: 'merge',
        changes: [
          {
            path: 'shared.txt',
            status: 'modified',
            area: 'unstaged',
            conflictKind: 'both_modified',
            conflictStatus: 'unresolved'
          },
          { path: 'plain.ts', status: 'modified', area: 'unstaged' }
        ]
      })
    )
    const rpc = await callTauriGitRuntimeRpc('git.status', { worktree: 'id:wt-1' })
    expect(rpc.handled).toBe(true)
    const status = rpc.result as {
      conflictOperation: string
      entries: Array<Record<string, unknown>>
    }
    expect(status.conflictOperation).toBe('merge')
    expect(status.entries[0]).toMatchObject({
      path: 'shared.txt',
      status: 'modified',
      area: 'unstaged',
      conflictKind: 'both_modified',
      conflictStatus: 'unresolved'
    })
    expect(status.entries[1].conflictKind).toBeUndefined()
    expect(status.entries[1].conflictStatus).toBeUndefined()
  })

  it('drops unknown conflict kinds and degrades operations to unknown', async () => {
    requestRuntimeJsonMock.mockResolvedValue(
      projectionResponse({
        conflictOperation: 'exploded',
        changes: [{ path: 'weird.txt', status: 'modified', conflictKind: 'both_confused' }]
      })
    )
    const rpc = await callTauriGitRuntimeRpc('git.status', { worktree: 'id:wt-1' })
    const status = rpc.result as {
      conflictOperation: string
      entries: Array<Record<string, unknown>>
    }
    expect(status.conflictOperation).toBe('unknown')
    expect(status.entries[0].conflictKind).toBeUndefined()
  })

  it('serves git.conflictOperation from the projection instead of a stub', async () => {
    requestRuntimeJsonMock.mockResolvedValue(projectionResponse({ conflictOperation: 'rebase' }))
    const rpc = await callTauriGitRuntimeRpc('git.conflictOperation', { worktree: 'id:wt-1' })
    expect(rpc).toEqual({ handled: true, result: 'rebase' })
  })
})
