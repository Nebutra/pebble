import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureRuntimeMock, requestRuntimeJsonMock } = vi.hoisted(() => ({
  ensureRuntimeMock: vi.fn(),
  requestRuntimeJsonMock: vi.fn()
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: ensureRuntimeMock,
  requestRuntimeJson: requestRuntimeJsonMock
}))

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../packages/product-core/shared/ai-vault-types'
import { createPebbleAiVaultApi } from './tauri-ai-vault-api'

describe('createPebbleAiVaultApi', () => {
  beforeEach(() => {
    ensureRuntimeMock.mockReset().mockResolvedValue(undefined)
    requestRuntimeJsonMock.mockReset().mockResolvedValue({
      sessions: [],
      issues: [],
      scannedAt: '2026-07-13T00:00:00Z'
    })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      setTimeout,
      api: {
        runtimeEnvironments: {
          list: vi.fn().mockResolvedValue([]),
          call: vi.fn()
        }
      }
    })
  })

  it('forwards SSH host scope and all active scope paths to the Go runtime', async () => {
    const base = {} as PreloadApi['aiVault']
    const api = createPebbleAiVaultApi(base)

    await api.listSessions({
      limit: 75,
      executionHostScope: 'ssh:prod%2Fmac',
      scopePaths: ['/srv/pebble', '/srv/other project']
    })

    const [path, options] = requestRuntimeJsonMock.mock.calls[0]
    const url = new URL(path, 'http://runtime.invalid')
    expect(url.pathname).toBe('/v1/ai-vault/sessions')
    expect(url.searchParams.get('limit')).toBe('75')
    expect(url.searchParams.get('executionHostScope')).toBe('ssh:prod%2Fmac')
    expect(url.searchParams.getAll('scopePath')).toEqual(['/srv/pebble', '/srv/other project'])
    expect(options).toEqual({ method: 'GET', timeoutMs: 30_000 })
  })

  it('routes a paired host scan through the encrypted runtime channel', async () => {
    vi.mocked(window.api.runtimeEnvironments.call).mockResolvedValue({
      id: 'request-1',
      ok: true,
      result: resultWithSessions(session('local:codex:remote:/a', '2026-07-18T02:00:00Z')),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const api = createPebbleAiVaultApi({} as PreloadApi['aiVault'])

    const result = await api.listSessions({
      limit: 25,
      executionHostScope: 'runtime:studio%2Fmac',
      scopePaths: ['/remote/workspace']
    })

    expect(window.api.runtimeEnvironments.call).toHaveBeenCalledWith({
      selector: 'studio/mac',
      method: 'aiVault.listSessions',
      params: {
        limit: 25,
        executionHostScope: 'local',
        scopePaths: ['/remote/workspace']
      },
      timeoutMs: 30_000
    })
    expect(result.sessions[0]).toMatchObject({
      id: 'runtime:studio%2Fmac:codex:remote:/a',
      executionHostId: 'runtime:studio%2Fmac'
    })
  })

  it('merges local, SSH, and paired histories with a global recency limit', async () => {
    vi.mocked(window.api.runtimeEnvironments.list).mockResolvedValue([
      runtimeEnvironment('env-1'),
      runtimeEnvironment('offline')
    ])
    requestRuntimeJsonMock.mockResolvedValue(
      resultWithSessions(session('local:codex:local:/a', '2026-07-18T01:00:00Z'))
    )
    vi.mocked(window.api.runtimeEnvironments.call).mockImplementation(async ({ selector }) =>
      selector === 'env-1'
        ? {
            id: 'request-2',
            ok: true,
            result: resultWithSessions(session('local:codex:remote:/b', '2026-07-18T03:00:00Z')),
            _meta: { runtimeId: 'remote-runtime' }
          }
        : {
            id: 'request-3',
            ok: false,
            error: { code: 'offline', message: 'Runtime is offline' },
            _meta: { runtimeId: null }
          }
    )
    const api = createPebbleAiVaultApi({} as PreloadApi['aiVault'])

    const result = await api.listSessions({ limit: 1, executionHostScope: 'all' })

    expect(result.sessions.map((entry) => entry.executionHostId)).toEqual(['runtime:env-1'])
    expect(result.issues).toContainEqual({
      executionHostId: 'runtime:offline',
      agent: 'codex',
      path: 'offline',
      message: 'Runtime is offline'
    })
    const localUrl = new URL(requestRuntimeJsonMock.mock.calls[0][0], 'http://runtime.invalid')
    expect(localUrl.searchParams.get('executionHostScope')).toBe('all')
  })
})

function resultWithSessions(...sessions: AiVaultSession[]): AiVaultListResult {
  return { sessions, issues: [], scannedAt: '2026-07-18T03:00:00Z' }
}

function session(id: string, modifiedAt: string): AiVaultSession {
  return {
    id,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: id,
    title: id,
    cwd: null,
    branch: null,
    model: null,
    filePath: id,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt,
    messageCount: 0,
    totalTokens: 0,
    previewMessages: [],
    resumeCommand: 'codex resume test'
  }
}

function runtimeEnvironment(id: string) {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: `ws-${id}`, kind: 'websocket' as const, label: id, endpoint: 'ws://test' }],
    preferredEndpointId: `ws-${id}`
  }
}
