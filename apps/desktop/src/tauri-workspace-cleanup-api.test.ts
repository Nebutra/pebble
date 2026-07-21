import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureRuntimeMock, readReposMock, readWorktreesMock, requestRuntimeMock, subscribeMock } =
  vi.hoisted(() => ({
    ensureRuntimeMock: vi.fn(),
    readReposMock: vi.fn(),
    readWorktreesMock: vi.fn(),
    requestRuntimeMock: vi.fn(),
    subscribeMock: vi.fn()
  }))
vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: ensureRuntimeMock,
  requestRuntimeJson: requestRuntimeMock
}))
vi.mock('./tauri-runtime-event-push', () => ({
  subscribeRuntimeEventPush: subscribeMock
}))
vi.mock('./pebble-tauri-workspace-runtime-api', () => ({
  readRepos: readReposMock,
  readWorktrees: readWorktreesMock
}))

import { createPebbleWorkspaceCleanupApi } from './tauri-workspace-cleanup-api'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

beforeEach(() => {
  vi.clearAllMocks()
  readReposMock.mockResolvedValue([])
  readWorktreesMock.mockResolvedValue([])
  globalThis.window = {
    api: { runtimeEnvironments: { call: vi.fn() } }
  } as unknown as Window & typeof globalThis
})

describe('createPebbleWorkspaceCleanupApi', () => {
  it('routes scans and matching progress through the Go runtime', async () => {
    let eventHandler: ((entry: { topic: string; data: string }) => void) | undefined
    subscribeMock.mockImplementation((handler) => {
      eventHandler = handler
      return Promise.resolve(() => undefined)
    })
    requestRuntimeMock.mockResolvedValue({
      scannedAt: 1,
      candidates: [],
      errors: []
    })
    ensureRuntimeMock.mockResolvedValue(undefined)
    const progress = vi.fn()
    const api = createPebbleWorkspaceCleanupApi(createUiApi())
    const promise = api.scan({ scanId: 'scan-1' }, progress)
    await Promise.resolve()
    eventHandler?.({
      topic: 'workspace-cleanup.progress',
      data: JSON.stringify({
        payload: {
          scanId: 'scan-1',
          scannedAt: 1,
          candidates: [],
          errors: [],
          scannedWorktreeCount: 0,
          totalWorktreeCount: 1
        }
      })
    })
    await promise
    expect(progress).toHaveBeenCalledOnce()
    expect(requestRuntimeMock).toHaveBeenCalledWith(
      '/v1/workspace-cleanup/scan',
      expect.objectContaining({
        method: 'POST',
        body: { scanId: 'scan-1' }
      })
    )
  })

  it('merges valid dismissal fingerprints through persisted UI state', async () => {
    const ui = createUiApi()
    await createPebbleWorkspaceCleanupApi(ui).dismiss({
      dismissals: [
        {
          worktreeId: 'wt-2',
          dismissedAt: 2,
          fingerprint: 'v2',
          classifierVersion: 2
        }
      ]
    })
    expect(ui.set).toHaveBeenCalledWith({
      workspaceCleanup: {
        dismissals: expect.objectContaining({
          'wt-1': expect.any(Object),
          'wt-2': expect.any(Object)
        })
      }
    })
  })

  it('aggregates paired SSH scans and preserves candidate ownership', async () => {
    readReposMock.mockResolvedValue([
      { id: 'local', connectionId: null },
      { id: 'remote', connectionId: 'ssh-1' }
    ])
    requestRuntimeMock.mockResolvedValue({
      scannedAt: 1,
      candidates: [],
      errors: []
    })
    const remoteCall = vi.mocked(window.api.runtimeEnvironments.call)
    remoteCall.mockResolvedValue({
      ok: true,
      result: {
        scannedAt: 2,
        candidates: [{ worktreeId: 'wt-remote', connectionId: null }],
        errors: []
      }
    } as never)

    const result = await createPebbleWorkspaceCleanupApi(createUiApi()).scan()

    expect(remoteCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'ssh-1',
        method: 'workspaceCleanup.scan'
      })
    )
    expect(result.candidates).toEqual([
      expect.objectContaining({
        worktreeId: 'wt-remote',
        connectionId: 'ssh-1'
      })
    ])
  })

  it('keeps remote scan failures explicit instead of falling back locally', async () => {
    readReposMock.mockResolvedValue([{ id: 'remote', connectionId: 'ssh-1' }])
    requestRuntimeMock.mockResolvedValue({
      scannedAt: 1,
      candidates: [],
      errors: []
    })
    vi.mocked(window.api.runtimeEnvironments.call).mockResolvedValue({
      ok: false,
      error: { code: 'disconnected', message: 'Host is offline' }
    } as never)

    const result = await createPebbleWorkspaceCleanupApi(createUiApi()).scan()

    expect(result.candidates).toEqual([])
    expect(result.errors).toEqual([
      { repoId: 'ssh-1', repoName: 'ssh-1', message: 'Host is offline' }
    ])
    expect(requestRuntimeMock).toHaveBeenCalledTimes(1)
  })

  it('checks SSH process liveness on the owning runtime', async () => {
    vi.mocked(window.api.runtimeEnvironments.call).mockResolvedValue({
      ok: true,
      result: { hasKillableProcesses: true }
    } as never)

    const result = await createPebbleWorkspaceCleanupApi(createUiApi()).hasKillableLocalProcesses({
      worktreeId: 'wt-remote',
      connectionId: 'ssh-1',
      worktreePath: '/srv/repo'
    })

    expect(result).toEqual({ hasKillableProcesses: true })
    expect(requestRuntimeMock).not.toHaveBeenCalled()
  })
})

function createUiApi(): PreloadApi['ui'] {
  return {
    get: vi.fn().mockResolvedValue({
      workspaceCleanup: {
        dismissals: {
          'wt-1': {
            worktreeId: 'wt-1',
            dismissedAt: 1,
            fingerprint: 'v1',
            classifierVersion: 2
          }
        }
      }
    }),
    set: vi.fn().mockResolvedValue(undefined),
    recordFeatureInteraction: vi.fn(),
    getZoomLevel: vi.fn().mockResolvedValue(0),
    setZoomLevel: vi.fn(),
    onZoomLevelChanged: vi.fn(() => () => undefined)
  } as unknown as PreloadApi['ui']
}
