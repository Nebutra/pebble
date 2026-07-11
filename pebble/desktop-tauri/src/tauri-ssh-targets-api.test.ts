import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../src/preload/api-types'

const { ensureRuntimeMock, requestRuntimeJsonMock } = vi.hoisted(() => ({
  ensureRuntimeMock: vi.fn(),
  requestRuntimeJsonMock: vi.fn()
}))

vi.mock('./pebble-runtime-http-bridge', () => ({
  ensurePebbleRuntimeProcess: ensureRuntimeMock,
  requestRuntimeJson: requestRuntimeJsonMock
}))

import { createPebbleSshApi } from './tauri-ssh-targets-api'

describe('createPebbleSshApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps ssh.connect to a real runtime probe and emits state changes', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce({
      success: true,
      status: 'connected'
    })
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']
    const listener = vi.fn()
    const unsubscribe = api.onStateChanged(listener)

    await expect(api.connect({ targetId: 'ssh-1' })).resolves.toEqual({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    await expect(api.getState({ targetId: 'ssh-1' })).resolves.toEqual({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    expect(ensureRuntimeMock).toHaveBeenCalled()
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets/ssh-1/probe', {
      method: 'POST',
      timeoutMs: 15_000
    })
    expect(listener).toHaveBeenNthCalledWith(1, {
      targetId: 'ssh-1',
      state: { targetId: 'ssh-1', status: 'connecting', error: null, reconnectAttempt: 0 }
    })
    expect(listener).toHaveBeenNthCalledWith(2, {
      targetId: 'ssh-1',
      state: { targetId: 'ssh-1', status: 'connected', error: null, reconnectAttempt: 0 }
    })

    unsubscribe()
  })

  it('returns failed probe state without pretending the relay is connected', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce({
      success: false,
      status: 'auth-failed',
      error: 'Permission denied'
    })
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']
    const listener = vi.fn()
    api.onStateChanged(listener)

    await expect(api.connect({ targetId: 'ssh-denied' })).resolves.toEqual({
      targetId: 'ssh-denied',
      status: 'auth-failed',
      error: 'Permission denied',
      reconnectAttempt: 0
    })
    await expect(api.getState({ targetId: 'ssh-denied' })).resolves.toMatchObject({
      status: 'auth-failed',
      error: 'Permission denied'
    })
    expect(listener).toHaveBeenLastCalledWith({
      targetId: 'ssh-denied',
      state: {
        targetId: 'ssh-denied',
        status: 'auth-failed',
        error: 'Permission denied',
        reconnectAttempt: 0
      }
    })
  })

  it('updates cached state on disconnect and resetRelay', async () => {
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']
    const listener = vi.fn()
    api.onStateChanged(listener)

    await api.disconnect({ targetId: 'ssh-1' })
    await expect(api.getState({ targetId: 'ssh-1' })).resolves.toMatchObject({
      status: 'disconnected'
    })

    await api.resetRelay({ targetId: 'ssh-1' })
    expect(listener).toHaveBeenLastCalledWith({
      targetId: 'ssh-1',
      state: { targetId: 'ssh-1', status: 'disconnected', error: null, reconnectAttempt: 0 }
    })
  })

  it('reads persisted passphrase prompt state when the credential cache is unreachable', async () => {
    // First call hits the runtime credential-status route; rejecting it forces
    // the persisted lastRequiredPassphrase fallback path.
    requestRuntimeJsonMock.mockRejectedValueOnce(new Error('cache route unavailable'))
    requestRuntimeJsonMock.mockResolvedValueOnce([
      {
        id: 'ssh-passphrase',
        label: 'Locked',
        host: 'locked.example',
        port: 22,
        username: 'deploy',
        lastRequiredPassphrase: true
      }
    ])
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']

    await expect(api.needsPassphrasePrompt({ targetId: 'ssh-passphrase' })).resolves.toBe(true)
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets', { method: 'GET' })
  })

  it('skips the prompt when the runtime credential cache already holds the secret', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce({ cached: true, promptRequired: false })
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']

    await expect(api.needsPassphrasePrompt({ targetId: 'ssh-passphrase' })).resolves.toBe(false)
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/ssh-targets/ssh-passphrase/credential',
      { method: 'GET' }
    )
  })

  it('does not prompt for a target that is already connected in Tauri state', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce({
      success: true,
      status: 'connected'
    })
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']
    await api.connect({ targetId: 'ssh-connected' })

    await expect(api.needsPassphrasePrompt({ targetId: 'ssh-connected' })).resolves.toBe(false)
    expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(1)
  })

  it('keeps target management backed by Go runtime routes', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce([
      {
        id: 'ssh-1',
        label: 'Builder',
        host: 'builder.local',
        port: 22,
        username: 'dev'
      }
    ])
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']

    await expect(api.listTargets()).resolves.toHaveLength(1)
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets', { method: 'GET' })
  })

  it('propagates target list runtime failures instead of returning fake empty targets', async () => {
    requestRuntimeJsonMock.mockRejectedValueOnce(new Error('ssh store unavailable'))
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']

    await expect(api.listTargets()).rejects.toThrow('ssh store unavailable')
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets', { method: 'GET' })
  })

  it('propagates ssh config import failures instead of reporting already synced', async () => {
    requestRuntimeJsonMock.mockRejectedValueOnce(new Error('ssh import failed'))
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']

    await expect(api.importConfig()).rejects.toThrow('ssh import failed')
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets/import', {
      method: 'POST'
    })
  })
})
