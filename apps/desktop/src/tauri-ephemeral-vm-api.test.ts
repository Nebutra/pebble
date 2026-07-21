import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { createPebbleEphemeralVmApi } from './tauri-ephemeral-vm-api'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: vi.fn(),
  requestRuntimeJson: vi.fn()
}))
vi.mock('./tauri-runtime-event-push', () => ({ subscribeRuntimeEventPush: vi.fn() }))

const nativeInvoke = vi.mocked(invoke)
const runtimeRequest = vi.mocked(requestRuntimeJson)
const subscribePush = vi.mocked(subscribeRuntimeEventPush)

function baseApi(): PreloadApi {
  return {
    ssh: { addTarget: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), removeTarget: vi.fn() },
    runtimeEnvironments: { remove: vi.fn() }
  } as unknown as PreloadApi
}

describe('createPebbleEphemeralVmApi', () => {
  beforeEach(() => {
    nativeInvoke.mockReset()
    runtimeRequest.mockReset()
    subscribePush.mockResolvedValue({ supported: true, pushActive: true, unsubscribe: vi.fn() })
  })

  it('registers a Pebble Server environment and patches the runtime record', async () => {
    const runtime = {
      id: 'pebble-1',
      recipeId: 'cloud',
      repoId: 'repo-1',
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 1,
        pairingCode: 'pebble://pair?code=offer',
        projectRoot: '/workspace'
      }
    }
    runtimeRequest
      .mockResolvedValueOnce({
        ok: true,
        connectionType: 'pebble-server',
        runtime,
        connection: {
          type: 'pebble-server',
          pairingCode: 'pebble://pair?code=offer',
          projectRoot: '/workspace'
        },
        stderr: '',
        warnings: []
      })
      .mockResolvedValueOnce([
        { repoId: 'repo-1', repoName: 'Pebble', repoPath: '/repo', recipes: [], diagnostics: [] }
      ])
      .mockResolvedValueOnce({ ...runtime, runtimeEnvironmentId: 'environment-1' })
    nativeInvoke.mockResolvedValue({ environment: { id: 'environment-1' } })

    const api = createPebbleEphemeralVmApi(baseApi())
    const listener = vi.fn()
    api.onProvisionEvent(listener)
    const result = await api.provision({ repoId: 'repo-1', recipeId: 'cloud' })
    expect(result).toMatchObject({
      ok: true,
      connectionType: 'pebble-server',
      runtime: { runtimeEnvironmentId: 'environment-1' }
    })
    expect(nativeInvoke).toHaveBeenCalledWith(
      'runtime_environments_add_from_pairing_code',
      expect.objectContaining({ input: expect.objectContaining({ source: 'ephemeral-vm' }) })
    )
    const eventHandler = subscribePush.mock.calls[0]?.[0]
    eventHandler?.({
      id: 'event-1',
      topic: 'ephemeral-vm.provision',
      data: JSON.stringify({ provisionId: 'provision-1', stream: 'stdout', chunk: 'creating' })
    })
    expect(listener).toHaveBeenCalledWith({
      provisionId: 'provision-1',
      stream: 'stdout',
      chunk: 'creating'
    })
  })
})
