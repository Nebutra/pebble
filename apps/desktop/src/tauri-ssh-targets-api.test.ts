import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

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
      state: {
        targetId: 'ssh-1',
        status: 'connecting',
        error: null,
        reconnectAttempt: 0
      }
    })
    expect(listener).toHaveBeenNthCalledWith(2, {
      targetId: 'ssh-1',
      state: {
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      }
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

  it('surfaces a bounded runtime timeout as an SSH error state', async () => {
    requestRuntimeJsonMock.mockRejectedValueOnce(
      new Error('runtime request timed out after 15000ms')
    )
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']

    await expect(api.testConnection({ targetId: 'ssh-windows' })).resolves.toMatchObject({
      success: false,
      error: 'runtime request timed out after 15000ms',
      state: {
        targetId: 'ssh-windows',
        status: 'error'
      }
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets/ssh-windows/probe', {
      method: 'POST',
      timeoutMs: 15_000
    })
  })

  it('prompts after auth failure, seeds memory-only credentials, and retries', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string, options: { method: string }) => {
      if (path.endsWith('/probe')) {
        const probeCount = requestRuntimeJsonMock.mock.calls.filter(([route]) =>
          String(route).endsWith('/probe')
        ).length
        return probeCount === 1
          ? { success: false, status: 'auth-failed', error: 'encrypted key' }
          : { success: true, status: 'connected' }
      }
      if (path === '/v1/ssh-targets' && options.method === 'GET') {
        return [
          {
            id: 'ssh-locked',
            label: 'Locked',
            host: 'locked.example',
            identityFile: '/keys/id_ed25519',
            port: 22,
            username: 'deploy'
          }
        ]
      }
      if (path.endsWith('/credential')) {
        return { cached: true, promptRequired: false }
      }
      if (path.endsWith('/port-forwards')) {
        return []
      }
      return {}
    })
    const base = {
      onCredentialRequest: () => () => {},
      onCredentialResolved: () => () => {},
      submitCredential: vi.fn().mockResolvedValue(undefined)
    } as unknown as PreloadApi['ssh']
    const api = createPebbleSshApi(base) as PreloadApi['ssh']
    const requests: { requestId: string; kind: string; detail: string }[] = []
    const resolved = vi.fn()
    const unsubscribeRequest = api.onCredentialRequest((request) => {
      requests.push(request)
      void api.submitCredential({ requestId: request.requestId, value: 'secret value' })
    })
    const unsubscribeResolved = api.onCredentialResolved(resolved)

    await expect(api.connect({ targetId: 'ssh-locked' })).resolves.toMatchObject({
      status: 'connected'
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      kind: 'passphrase',
      detail: '/keys/id_ed25519'
    })
    expect(resolved).toHaveBeenCalledWith({ requestId: requests[0].requestId })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets/ssh-locked/credential', {
      method: 'POST',
      body: { kind: 'passphrase', value: 'secret value' }
    })
    expect(
      requestRuntimeJsonMock.mock.calls.filter(([path]) => String(path).endsWith('/probe'))
    ).toHaveLength(2)
    unsubscribeRequest()
    unsubscribeResolved()
  })

  it('cancels an SSH credential prompt without caching or retrying', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string) => {
      if (path.endsWith('/probe')) {
        return { success: false, status: 'auth-failed', error: 'password required' }
      }
      if (path === '/v1/ssh-targets') {
        return [{ id: 'ssh-password', label: 'Password host', host: 'password.example' }]
      }
      return {}
    })
    const base = {
      onCredentialRequest: () => () => {},
      onCredentialResolved: () => () => {},
      submitCredential: vi.fn().mockResolvedValue(undefined)
    } as unknown as PreloadApi['ssh']
    const api = createPebbleSshApi(base) as PreloadApi['ssh']
    const unsubscribe = api.onCredentialRequest((request) => {
      void api.submitCredential({ requestId: request.requestId, value: null })
    })

    await expect(api.connect({ targetId: 'ssh-password' })).resolves.toMatchObject({
      status: 'disconnected'
    })
    expect(
      requestRuntimeJsonMock.mock.calls.filter(([path]) => String(path).endsWith('/probe'))
    ).toHaveLength(1)
    expect(
      requestRuntimeJsonMock.mock.calls.some(
        ([path, options]) =>
          String(path).endsWith('/credential') && (options as { method?: string }).method === 'POST'
      )
    ).toBe(false)
    unsubscribe()
  })

  it('updates cached state on disconnect and resetRelay', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ failedIds: [] })
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
      state: {
        targetId: 'ssh-1',
        status: 'disconnected',
        error: null,
        reconnectAttempt: 0
      }
    })
  })

  it('deduplicates resetRelay while terminating target sessions', async () => {
    let resolveTermination!: (value: { failedIds: string[] }) => void
    requestRuntimeJsonMock.mockImplementation((path: string) => {
      if (path.endsWith('/sessions/terminate')) {
        return new Promise((resolve) => {
          resolveTermination = resolve
        })
      }
      return Promise.resolve({})
    })
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']

    const first = api.resetRelay({ targetId: 'ssh-reset' })
    const second = api.resetRelay({ targetId: 'ssh-reset' })
    await vi.waitFor(() => expect(resolveTermination).toBeTypeOf('function'))
    resolveTermination({ failedIds: [] })
    await Promise.all([first, second])

    expect(
      requestRuntimeJsonMock.mock.calls.filter(([path]) =>
        String(path).endsWith('/sessions/terminate')
      )
    ).toHaveLength(1)
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
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets', {
      method: 'GET'
    })
  })

  it('skips the prompt when the runtime credential cache already holds the secret', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce({
      cached: true,
      promptRequired: false
    })
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
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/ssh-targets/ssh-connected/agent-hooks/bootstrap',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ version: 1 })
      })
    )
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/ssh-targets/ssh-connected/port-forwards/restore',
      { method: 'POST', timeoutMs: 20_000 }
    )
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
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets', {
      method: 'GET'
    })
  })

  it('deletes through the runtime-owned teardown and clears cached connection state', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string) => {
      if (path.endsWith('/probe')) {
        return { success: true, status: 'connected' }
      }
      if (path.endsWith('/agent-hooks/bootstrap')) {
        return { success: true }
      }
      if (path.endsWith('/port-forwards/restore')) {
        return []
      }
      if (path.endsWith('/port-forwards')) {
        return []
      }
      if (path === '/v1/ssh-targets/ssh-remove') {
        return { id: 'ssh-remove', host: 'remove.example' }
      }
      return {}
    })
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']
    await api.connect({ targetId: 'ssh-remove' })
    await expect(api.getState({ targetId: 'ssh-remove' })).resolves.toMatchObject({
      status: 'connected'
    })

    await api.removeTarget({ id: 'ssh-remove' })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets/ssh-remove', {
      method: 'DELETE'
    })
    await expect(api.getState({ targetId: 'ssh-remove' })).resolves.toBeNull()
  })

  it('restores saved port forwards after a successful connection', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce({ success: true, status: 'connected' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']

    await api.connect({ targetId: 'ssh-forward' })
    await vi.waitFor(() =>
      expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
        '/v1/ssh-targets/ssh-forward/port-forwards/restore',
        { method: 'POST', timeoutMs: 20_000 }
      )
    )
  })

  it('maps port forward CRUD and emits refreshed target entries', async () => {
    const entry = {
      id: 'sshfwd-1',
      connectionId: 'ssh-1',
      localPort: 43110,
      remoteHost: '127.0.0.1',
      remotePort: 3000
    }
    requestRuntimeJsonMock.mockResolvedValueOnce(entry).mockResolvedValueOnce([entry])
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']
    const listener = vi.fn()
    api.onPortForwardsChanged(listener)

    await expect(
      api.addPortForward({
        targetId: 'ssh-1',
        localPort: 43110,
        remoteHost: '127.0.0.1',
        remotePort: 3000
      })
    ).resolves.toEqual(entry)

    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      1,
      '/v1/ssh-targets/ssh-1/port-forwards',
      expect.objectContaining({ method: 'POST' })
    )
    expect(listener).toHaveBeenCalledWith({ targetId: 'ssh-1', forwards: [entry] })
  })

  it('maps remote port detection and pre-project directory browsing', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce([{ port: 4175, host: '127.0.0.1', processName: 'vite' }])
      .mockResolvedValueOnce({
        resolvedPath: '/home/dev',
        entries: [{ name: 'src', isDirectory: true }]
      })
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']

    await expect(api.listDetectedPorts({ targetId: 'ssh-1' })).resolves.toEqual([
      { port: 4175, host: '127.0.0.1', processName: 'vite' }
    ])
    await expect(api.browseDir({ targetId: 'ssh-1', dirPath: '~' })).resolves.toEqual({
      resolvedPath: '/home/dev',
      entries: [{ name: 'src', isDirectory: true }]
    })
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      1,
      '/v1/ssh-targets/ssh-1/ports/detected',
      { method: 'GET', timeoutMs: 20_000 }
    )
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(2, '/v1/ssh-targets/ssh-1/browse', {
      method: 'POST',
      body: { path: '~' },
      timeoutMs: 20_000
    })
  })

  it.each([
    String.raw`C:\Users\Dev User\source`,
    String.raw`\\build-server\Shared Projects\Pebble`
  ])('passes native Windows remote browse paths without POSIX rewriting: %s', async (dirPath) => {
    requestRuntimeJsonMock.mockResolvedValueOnce({
      resolvedPath: dirPath,
      entries: [{ name: 'Project One', isDirectory: true }]
    })
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']

    await expect(api.browseDir({ targetId: 'ssh windows', dirPath })).resolves.toEqual({
      resolvedPath: dirPath,
      entries: [{ name: 'Project One', isDirectory: true }]
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets/ssh%20windows/browse', {
      method: 'POST',
      body: { path: dirPath },
      timeoutMs: 20_000
    })
  })

  it('propagates bounded remote browse failures without returning an empty listing', async () => {
    requestRuntimeJsonMock.mockRejectedValueOnce(
      new Error('browse remote directory: context deadline exceeded')
    )
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']

    await expect(
      api.browseDir({ targetId: 'ssh-windows', dirPath: String.raw`D:\Large Projects` })
    ).rejects.toThrow('context deadline exceeded')
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets/ssh-windows/browse', {
      method: 'POST',
      body: { path: String.raw`D:\Large Projects` },
      timeoutMs: 20_000
    })
  })

  it('terminates target-scoped runtime SSH sessions', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce({
      targetId: 'ssh-1',
      terminatedIds: ['sess-1'],
      failedIds: []
    })
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']

    await expect(api.terminateSessions({ targetId: 'ssh-1' })).resolves.toBeUndefined()
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/ssh-targets/ssh-1/sessions/terminate',
      { method: 'POST', timeoutMs: 15_000 }
    )
  })

  it('propagates target list runtime failures instead of returning fake empty targets', async () => {
    requestRuntimeJsonMock.mockRejectedValueOnce(new Error('ssh store unavailable'))
    const api = createPebbleSshApi({} as PreloadApi['ssh']) as PreloadApi['ssh']

    await expect(api.listTargets()).rejects.toThrow('ssh store unavailable')
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets', {
      method: 'GET'
    })
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
