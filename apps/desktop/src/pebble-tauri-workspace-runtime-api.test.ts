import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import {
  createPebbleProjectsApi,
  createPebbleReposApi,
  readRepos,
  readWorktrees
} from './pebble-tauri-workspace-runtime-api'

const { ensurePebbleRuntimeProcessMock, requestRuntimeJsonMock, subscribeRuntimeEventPushMock } =
  vi.hoisted(() => ({
    ensurePebbleRuntimeProcessMock: vi.fn(),
    requestRuntimeJsonMock: vi.fn(),
    subscribeRuntimeEventPushMock: vi.fn()
  }))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: ensurePebbleRuntimeProcessMock,
  requestRuntimeJson: requestRuntimeJsonMock
}))

vi.mock('./tauri-runtime-event-push', () => ({
  subscribeRuntimeEventPush: subscribeRuntimeEventPushMock
}))

vi.mock('./runtime-bridge', () => ({
  createRuntimeEventStreamCommand: vi.fn(),
  readRuntimeEventStream: vi.fn()
}))

vi.mock('./pebble-tauri-workspace-runtime-records', () => ({
  applyWorktreeMeta: vi.fn((worktree) => worktree),
  joinRuntimePath: vi.fn((...parts: string[]) => parts.filter(Boolean).join('/')),
  mapRuntimeProjectToRepo: vi.fn((project) => project),
  mapRuntimeWorktreeToWorktree: vi.fn((worktree) => worktree),
  pathBasename: vi.fn((path: string) => path.split('/').pop() ?? path),
  persistRuntimeProjectGroups: vi.fn(),
  readBoolean: vi.fn((value) => (typeof value === 'boolean' ? value : null)),
  readObject: vi.fn((value) => (value && typeof value === 'object' ? value : {})),
  readRuntimeProjectGroups: vi.fn(() => Promise.resolve([])),
  readString: vi.fn((value) => (typeof value === 'string' ? value : null)),
  removeRuntimeProjectGroup: vi.fn(),
  upsertRuntimeProjectGroup: vi.fn()
}))

describe('pebble Tauri workspace runtime API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('propagates project list runtime failures instead of returning a fake empty list', async () => {
    const error = new Error('runtime offline')
    requestRuntimeJsonMock.mockRejectedValue(error)

    await expect(readRepos()).rejects.toThrow('runtime offline')
    expect(ensurePebbleRuntimeProcessMock).toHaveBeenCalledOnce()
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/projects', { method: 'GET' })
  })

  it('propagates worktree list runtime failures instead of clearing visible worktrees', async () => {
    const error = new Error('worktrees unavailable')
    requestRuntimeJsonMock.mockRejectedValue(error)

    await expect(readWorktrees('repo-1')).rejects.toThrow('worktrees unavailable')
    expect(ensurePebbleRuntimeProcessMock).toHaveBeenCalledOnce()
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/worktrees?projectId=repo-1', {
      method: 'GET'
    })
  })

  it('routes clone cancellation and progress through the Go runtime', async () => {
    subscribeRuntimeEventPushMock.mockResolvedValue({ supported: true })
    requestRuntimeJsonMock.mockResolvedValue({ aborted: true })
    const api = createPebbleReposApi({} as PreloadApi['repos'])
    const progress = vi.fn()
    const unsubscribe = api.onCloneProgress(progress)

    await vi.waitFor(() => expect(subscribeRuntimeEventPushMock).toHaveBeenCalledOnce())
    const runtimeEvent = subscribeRuntimeEventPushMock.mock.calls[0][0] as (entry: {
      topic: string
      data: string
    }) => void
    runtimeEvent({
      topic: 'project.cloneProgress',
      data: JSON.stringify({
        topic: 'project.cloneProgress',
        payload: { phase: 'Receiving objects', percent: 73 }
      })
    })
    expect(progress).toHaveBeenCalledWith({ phase: 'Receiving objects', percent: 73 })

    await api.cloneAbort()
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/projects/clone/abort', {
      method: 'POST'
    })
    unsubscribe()
  })

  it('routes SSH clone through the Go relay host id', async () => {
    requestRuntimeJsonMock.mockResolvedValue({
      id: 'repo-ssh',
      name: 'pebble',
      path: '/home/user/pebble',
      locationKind: 'ssh',
      hostId: 'ssh-1'
    })
    const api = createPebbleReposApi({} as PreloadApi['repos'])

    await api.cloneRemote({
      connectionId: 'ssh-1',
      url: 'https://github.com/nebutra/pebble.git',
      destination: '/home/user'
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/projects/clone', {
      method: 'POST',
      timeoutMs: 10 * 60_000,
      body: {
        hostId: 'ssh-1',
        url: 'https://github.com/nebutra/pebble.git',
        destination: '/home/user'
      }
    })
  })

  it('reads git username through the project runtime route', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ username: 'pebble-dev' })
    const api = createPebbleReposApi({} as PreloadApi['repos'])

    await expect(api.getGitUsername({ repoId: 'repo-1' })).resolves.toBe('pebble-dev')
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/projects/repo-1/git-username', {
      method: 'GET'
    })
  })

  it('persists and clears the GitHub issue source preference explicitly', async () => {
    requestRuntimeJsonMock.mockResolvedValue({
      id: 'repo-1',
      path: '/work/pebble',
      issueSourcePreference: 'upstream'
    })
    const api = createPebbleReposApi({} as PreloadApi['repos'])

    await api.update({ repoId: 'repo-1', updates: { issueSourcePreference: 'upstream' } })
    expect(requestRuntimeJsonMock).toHaveBeenLastCalledWith('/v1/projects/repo-1', {
      method: 'PATCH',
      body: { issueSourcePreference: 'upstream' }
    })

    await api.update({ repoId: 'repo-1', updates: { issueSourcePreference: undefined } })
    expect(requestRuntimeJsonMock).toHaveBeenLastCalledWith('/v1/projects/repo-1', {
      method: 'PATCH',
      body: { issueSourcePreference: 'auto' }
    })
  })

  it('persists project Windows runtime preference through every source repo', async () => {
    const repo = {
      id: 'repo-1',
      path: '/work/pebble',
      displayName: 'Pebble',
      badgeColor: '#737373',
      addedAt: 1,
      kind: 'git' as const,
      localWindowsRuntimePreference: undefined
    }
    requestRuntimeJsonMock
      .mockResolvedValueOnce([repo])
      .mockResolvedValueOnce({
        ...repo,
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu-24.04' }
      })
      .mockResolvedValueOnce([
        {
          ...repo,
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu-24.04' }
        }
      ])
    const api = createPebbleProjectsApi({} as PreloadApi['projects'])

    const updated = await api.update({
      projectId: 'repo:repo-1',
      updates: { localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu-24.04' } }
    })

    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(2, '/v1/projects/repo-1', {
      method: 'PATCH',
      body: {
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu-24.04' }
      }
    })
    expect(updated?.localWindowsRuntimePreference).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu-24.04'
    })
  })

  it('creates independent project host setup records through Go', async () => {
    const repo = {
      id: 'repo-1',
      path: '/work/pebble',
      displayName: 'Pebble',
      badgeColor: '#737373',
      addedAt: 1,
      kind: 'git' as const
    }
    requestRuntimeJsonMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([repo])
      .mockResolvedValueOnce({
        id: 'pebble::gpu-vm',
        projectId: 'repo:repo-1',
        hostId: 'runtime:gpu-vm',
        repoId: '',
        path: '',
        displayName: 'GPU VM',
        setupState: 'setting-up',
        setupMethod: 'provisioned',
        createdAt: '2026-07-12T00:00:00Z',
        updatedAt: '2026-07-12T00:00:00Z'
      })
    const api = createPebbleProjectsApi({} as PreloadApi['projects'])

    const result = await api.createHostSetup({
      projectId: 'repo:repo-1',
      hostId: 'runtime:gpu-vm',
      setupId: 'pebble::gpu-vm',
      displayName: 'GPU VM',
      setupState: 'setting-up',
      setupMethod: 'provisioned'
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/project-host-setups', {
      method: 'POST',
      body: expect.objectContaining({ setupId: 'pebble::gpu-vm' })
    })
    expect(result.setup).toMatchObject({
      id: 'pebble::gpu-vm',
      hostId: 'runtime:gpu-vm',
      createdAt: Date.parse('2026-07-12T00:00:00Z')
    })
  })

  it('binds an existing folder on another host to the same logical project', async () => {
    const originalRepo = {
      id: 'repo-1',
      path: '/work/pebble',
      displayName: 'Pebble',
      badgeColor: '#737373',
      addedAt: 1,
      kind: 'git' as const
    }
    const remoteRepo = {
      id: 'repo-2',
      path: '/srv/pebble',
      displayName: 'Pebble Remote',
      badgeColor: '#737373',
      addedAt: 2,
      kind: 'git' as const,
      logicalProjectId: 'repo:repo-1',
      locationKind: 'ssh',
      hostId: 'ssh-1'
    }
    requestRuntimeJsonMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([originalRepo])
      .mockResolvedValueOnce(remoteRepo)
      .mockResolvedValueOnce([originalRepo, remoteRepo])
    const api = createPebbleProjectsApi({} as PreloadApi['projects'])

    const result = await api.setupExistingFolder({
      projectId: 'repo:repo-1',
      hostId: 'ssh:ssh-1',
      path: '/srv/pebble',
      displayName: 'Pebble Remote',
      kind: 'git'
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/projects', {
      method: 'POST',
      body: expect.objectContaining({
        path: '/srv/pebble',
        locationKind: 'ssh',
        hostId: 'ssh-1',
        logicalProjectId: 'repo:repo-1'
      })
    })
    expect(result.project.sourceRepoIds).toEqual(['repo-1', 'repo-2'])
    expect(result.setup).toMatchObject({ repoId: 'repo-2', projectId: 'repo:repo-1' })
  })

  it('keeps an independent-only logical project visible after its source repo is gone', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce([
        {
          id: 'pebble::gpu-vm',
          projectId: 'project:pebble',
          hostId: 'runtime:gpu-vm',
          repoId: '',
          path: '',
          displayName: 'Pebble GPU',
          setupState: 'setting-up',
          setupMethod: 'provisioned',
          createdAt: '2026-07-10T00:00:00Z',
          updatedAt: '2026-07-12T00:00:00Z'
        }
      ])
      .mockResolvedValueOnce([])
    const api = createPebbleProjectsApi({} as PreloadApi['projects'])

    await expect(api.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'project:pebble',
        displayName: 'Pebble GPU',
        sourceRepoIds: [],
        createdAt: Date.parse('2026-07-10T00:00:00Z'),
        updatedAt: Date.parse('2026-07-12T00:00:00Z')
      })
    ])
  })
})
