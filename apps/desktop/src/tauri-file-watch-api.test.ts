import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { RuntimeRpcResponse } from '../../../packages/product-core/shared/runtime-rpc-envelope'
import { createPebbleFileWatchApi } from './tauri-file-watch-api'

const { invokeMock, listenMock, requestRuntimeJsonMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  requestRuntimeJsonMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))

type RuntimeSubscribeCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
}

const reposList = vi.fn()
const worktreesListAll = vi.fn()
const runtimeSubscribe = vi.fn()
const runtimeCall = vi.fn()

function createBaseFsApi(): PreloadApi['fs'] {
  return {
    watchWorktree: vi.fn(),
    unwatchWorktree: vi.fn(),
    onFsChanged: vi.fn()
  } as unknown as PreloadApi['fs']
}

beforeEach(() => {
  vi.clearAllMocks()
  listenMock.mockResolvedValue(vi.fn())
  reposList.mockResolvedValue([{ id: 'repo-1', connectionId: 'env-1' }])
  worktreesListAll.mockResolvedValue([{ id: 'wt-1', repoId: 'repo-1', path: '/remote/repo' }])
  runtimeCall.mockResolvedValue({ id: 'unwatch', ok: true, result: { unsubscribed: true } })
  runtimeSubscribe.mockResolvedValue({ unsubscribe: vi.fn(), sendBinary: vi.fn() })
  requestRuntimeJsonMock.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      worktrees: { listAll: worktreesListAll },
      runtimeEnvironments: {
        subscribe: runtimeSubscribe,
        call: runtimeCall
      }
    }
  })
})

describe('createPebbleFileWatchApi', () => {
  it('keeps local worktree watches on the native Tauri notify command', async () => {
    const api = createPebbleFileWatchApi(createBaseFsApi())

    await api.watchWorktree({ worktreePath: '/local/repo' })

    expect(invokeMock).toHaveBeenCalledWith('fs_watch_worktree', {
      input: { worktreePath: '/local/repo' }
    })
    expect(runtimeSubscribe).not.toHaveBeenCalled()
  })

  it('bridges connectionId worktree watches through runtime files.watch', async () => {
    const unsubscribe = vi.fn()
    let callbacks: RuntimeSubscribeCallbacks | undefined
    runtimeSubscribe.mockImplementation((_args, nextCallbacks) => {
      callbacks = nextCallbacks
      return Promise.resolve({ unsubscribe, sendBinary: vi.fn() })
    })
    const api = createPebbleFileWatchApi(createBaseFsApi())
    const payloads: unknown[] = []
    const stopEvents = api.onFsChanged((payload) => payloads.push(payload))

    await api.watchWorktree({ worktreePath: '/remote/repo', connectionId: 'env-1' })

    expect(runtimeSubscribe).toHaveBeenCalledWith(
      {
        selector: 'env-1',
        method: 'files.watch',
        params: { worktree: 'id:wt-1' },
        timeoutMs: 15_000
      },
      expect.any(Object)
    )

    if (!callbacks) {
      throw new Error('runtime subscription callbacks were not captured')
    }
    const activeCallbacks = callbacks

    activeCallbacks.onResponse({
      id: 'ready',
      ok: true,
      result: { type: 'ready', subscriptionId: 'files-watch-1' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    activeCallbacks.onResponse({
      id: 'changed',
      ok: true,
      result: {
        type: 'changed',
        worktree: 'id:wt-1',
        events: [{ kind: 'update', absolutePath: '/remote/repo/README.md' }]
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    expect(payloads).toEqual([
      {
        worktreePath: '/remote/repo',
        events: [{ kind: 'update', absolutePath: '/remote/repo/README.md' }]
      }
    ])

    await api.unwatchWorktree({ worktreePath: '/remote/repo', connectionId: 'env-1' })

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.unwatch',
      params: { subscriptionId: 'files-watch-1' },
      timeoutMs: 5_000
    })
    stopEvents()
  })

  it('shares one runtime watch across repeated connectionId subscriptions', async () => {
    const unsubscribe = vi.fn()
    runtimeSubscribe.mockResolvedValue({ unsubscribe, sendBinary: vi.fn() })
    const api = createPebbleFileWatchApi(createBaseFsApi())

    await api.watchWorktree({ worktreePath: '/remote/repo', connectionId: 'env-1' })
    await api.watchWorktree({ worktreePath: '/remote/repo', connectionId: 'env-1' })
    await api.unwatchWorktree({ worktreePath: '/remote/repo', connectionId: 'env-1' })

    expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
    expect(unsubscribe).not.toHaveBeenCalled()

    await api.unwatchWorktree({ worktreePath: '/remote/repo', connectionId: 'env-1' })

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('falls back to Go relay snapshots for legacy SSH watches', async () => {
    vi.useFakeTimers()
    runtimeSubscribe.mockRejectedValue(new Error('runtime environment not found'))
    requestRuntimeJsonMock
      .mockResolvedValueOnce([
        { path: 'README.md', size: 4, mtimeNanos: 1, isDirectory: false },
        { path: 'old.txt', size: 1, mtimeNanos: 1, isDirectory: false }
      ])
      .mockResolvedValueOnce([
        { path: 'README.md', size: 8, mtimeNanos: 2, isDirectory: false },
        { path: 'src', size: 0, mtimeNanos: 2, isDirectory: true }
      ])
    const api = createPebbleFileWatchApi(createBaseFsApi())
    const payloads: unknown[] = []
    const stopEvents = api.onFsChanged((payload) => payloads.push(payload))

    await api.watchWorktree({ worktreePath: '/remote/repo', connectionId: 'env-1' })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(payloads).toEqual([
      {
        worktreePath: '/remote/repo',
        events: [
          {
            kind: 'update',
            absolutePath: '/remote/repo/README.md',
            isDirectory: false
          },
          { kind: 'create', absolutePath: '/remote/repo/src', isDirectory: true },
          { kind: 'delete', absolutePath: '/remote/repo/old.txt', isDirectory: false }
        ]
      }
    ])
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/files/watch-snapshot?projectId=repo-1&worktreeId=wt-1',
      { method: 'GET', timeoutMs: 60_000 }
    )

    await api.unwatchWorktree({ worktreePath: '/remote/repo', connectionId: 'env-1' })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(2)
    stopEvents()
    vi.useRealTimers()
  })
})
