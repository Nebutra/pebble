import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureRuntimeMock, requestRuntimeMock, subscribePushMock } = vi.hoisted(() => ({
  ensureRuntimeMock: vi.fn(),
  requestRuntimeMock: vi.fn(),
  subscribePushMock: vi.fn()
}))
vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: ensureRuntimeMock,
  requestRuntimeJson: requestRuntimeMock
}))
vi.mock('./tauri-runtime-event-push', () => ({
  subscribeRuntimeEventPush: subscribePushMock
}))

import {
  createPebbleRemoteWorkspaceApi,
  resetTauriRemoteWorkspaceStateForTests
} from './tauri-remote-workspace-api'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

beforeEach(async () => {
  await resetTauriRemoteWorkspaceStateForTests()
  vi.clearAllMocks()
  ensureRuntimeMock.mockResolvedValue(undefined)
  subscribePushMock.mockResolvedValue({
    supported: true,
    pushActive: true,
    unsubscribe: vi.fn()
  })
})

describe('createPebbleRemoteWorkspaceApi', () => {
  it('projects and patches only hydrated connected targets', async () => {
    requestRuntimeMock
      .mockResolvedValueOnce({
        namespace: 'ns',
        revision: 0,
        updatedAt: 0,
        schemaVersion: 1,
        session: {}
      })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: {
          namespace: 'ns',
          revision: 1,
          updatedAt: 1,
          schemaVersion: 1,
          session: {}
        }
      })
    const api = createBaseApi()
    const result = await createPebbleRemoteWorkspaceApi(api).setForConnectedTargets({
      hydratedTargetIds: ['ssh-1'],
      session: {
        activeWorktreeId: 'repo-1::/remote/project',
        activeTabId: null,
        tabsByWorktree: {},
        activeTabIdByWorktree: {},
        terminalLayoutsByTabId: {}
      } as never
    })
    expect(result).toHaveLength(1)
    expect(requestRuntimeMock).toHaveBeenLastCalledWith('/v1/remote-workspace/patch', {
      method: 'POST',
      body: expect.objectContaining({ targetId: 'ssh-1', baseRevision: 0 }),
      timeoutMs: 60_000
    })
  })

  it('marks the current presence client', async () => {
    requestRuntimeMock.mockResolvedValue({
      clients: [
        {
          clientId: await createPebbleRemoteWorkspaceApi(createBaseApi()).clientId(),
          name: 'This device',
          lastSeenAt: 1
        }
      ]
    })
    const api = createPebbleRemoteWorkspaceApi(createBaseApi())
    const result = await api.listConnectedClients()
    expect(result[0]?.clients[0]?.isCurrent).toBe(true)
  })

  it('delivers pushed remote snapshots and releases the target watcher', async () => {
    let pushHandler: ((entry: { topic: string; data: string }) => void) | undefined
    let pushState: ((active: boolean) => void) | undefined
    subscribePushMock.mockImplementation((handler, state) => {
      pushHandler = handler
      pushState = state
      state?.(true)
      return Promise.resolve({
        supported: true,
        pushActive: true,
        unsubscribe: vi.fn()
      })
    })
    requestRuntimeMock.mockImplementation((path: string) => {
      if (path.endsWith('/get')) {
        return Promise.resolve({
          namespace: 'ns',
          revision: 1,
          updatedAt: 1,
          schemaVersion: 1,
          session: {}
        })
      }
      return Promise.resolve({ watching: true })
    })
    const api = createPebbleRemoteWorkspaceApi(createBaseApi())
    await api.get({ targetId: 'ssh-1' })
    const changed = vi.fn()
    const unsubscribe = api.onChanged(changed)
    await vi.waitFor(() =>
      expect(requestRuntimeMock).toHaveBeenCalledWith(
        '/v1/remote-workspace/watch',
        expect.objectContaining({ body: { targetId: 'ssh-1', enabled: true } })
      )
    )
    pushState?.(true)
    pushHandler?.({
      topic: 'workspace.watch-status',
      data: JSON.stringify({ payload: { targetId: 'ssh-1', connected: true } })
    })
    pushHandler?.({
      topic: 'workspace.changed',
      data: JSON.stringify({
        payload: {
          targetId: 'ssh-1',
          snapshot: {
            namespace: 'ns',
            revision: 2,
            updatedAt: 2,
            schemaVersion: 1,
            session: {}
          }
        }
      })
    })
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'ssh-1' }))

    unsubscribe()
    await vi.waitFor(() =>
      expect(requestRuntimeMock).toHaveBeenCalledWith(
        '/v1/remote-workspace/watch',
        expect.objectContaining({
          body: { targetId: 'ssh-1', enabled: false }
        })
      )
    )
  })
})

function createBaseApi(): PreloadApi {
  return {
    ssh: {
      listTargets: vi.fn().mockResolvedValue([{ id: 'ssh-1' }]),
      getState: vi.fn().mockResolvedValue({ status: 'connected' })
    },
    repos: {
      list: vi.fn().mockResolvedValue([{ id: 'repo-1', connectionId: 'ssh-1' }])
    },
    session: { get: vi.fn() }
  } as unknown as PreloadApi
}
