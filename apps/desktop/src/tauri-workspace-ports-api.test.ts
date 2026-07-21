import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ensurePebbleRuntimeProcessMock, requestRuntimeJsonMock, subscribeRuntimeEventPushMock } =
  vi.hoisted(() => ({
    ensurePebbleRuntimeProcessMock: vi.fn().mockResolvedValue(undefined),
    requestRuntimeJsonMock: vi.fn(),
    subscribeRuntimeEventPushMock: vi.fn().mockResolvedValue({ supported: true })
  }))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: ensurePebbleRuntimeProcessMock,
  requestRuntimeJson: requestRuntimeJsonMock
}))
vi.mock('./tauri-runtime-event-push', () => ({
  subscribeRuntimeEventPush: subscribeRuntimeEventPushMock
}))

import {
  callTauriWorkspacePortsRuntimeRpc,
  createPebbleWorkspacePortsApi
} from './tauri-workspace-ports-api'

describe('createPebbleWorkspacePortsApi', () => {
  beforeEach(() => vi.clearAllMocks())

  it('scans all or one encoded repository through the Go runtime', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ platform: 'darwin', scannedAt: 1, ports: [] })
    const api = createPebbleWorkspacePortsApi()

    await api.scan({ repoId: 'repo/a b' })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/workspace-ports?repoId=repo%2Fa%20b', {
      method: 'GET'
    })
  })

  it('routes process termination through the revalidating runtime endpoint', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ ok: true })
    const api = createPebbleWorkspacePortsApi()

    await expect(api.kill({ repoId: 'repo-1', pid: 42, port: 5173 })).resolves.toEqual({ ok: true })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/workspace-ports/kill', {
      method: 'POST',
      body: { repoId: 'repo-1', pid: 42, port: 5173 }
    })
  })
})

describe('callTauriWorkspacePortsRuntimeRpc', () => {
  it('maps scoped scans and validated process termination', async () => {
    const api = {
      scan: vi.fn().mockResolvedValue({ ports: [] }),
      kill: vi.fn().mockResolvedValue({ ok: true })
    }

    await expect(
      callTauriWorkspacePortsRuntimeRpc('workspacePorts.scan', { repoId: ' repo-1 ' }, api)
    ).resolves.toEqual({ handled: true, result: { ports: [] } })
    await expect(
      callTauriWorkspacePortsRuntimeRpc(
        'workspacePorts.kill',
        { repoId: 'repo-1', pid: 42, port: 5173 },
        api
      )
    ).resolves.toEqual({ handled: true, result: { ok: true } })

    expect(api.scan).toHaveBeenCalledWith({ repoId: 'repo-1' })
    expect(api.kill).toHaveBeenCalledWith({ repoId: 'repo-1', pid: 42, port: 5173 })
  })

  it('rejects invalid kill targets before invoking the native runtime', async () => {
    const api = { scan: vi.fn(), kill: vi.fn() }

    await expect(
      callTauriWorkspacePortsRuntimeRpc(
        'workspacePorts.kill',
        { repoId: 'repo-1', pid: 42, port: 70_000 },
        api
      )
    ).rejects.toThrow('Workspace port must be at most 65535')
    expect(api.kill).not.toHaveBeenCalled()
  })
})
