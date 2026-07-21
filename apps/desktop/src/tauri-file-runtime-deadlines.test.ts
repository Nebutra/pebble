import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestRuntimeJsonMock, runtimeEnvCallMock } = vi.hoisted(() => ({
  requestRuntimeJsonMock: vi.fn(),
  runtimeEnvCallMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn() }))
vi.mock('./pebble-tauri-runtime-transport', () => ({ requestRuntimeJson: requestRuntimeJsonMock }))
vi.mock('./tauri-settings-event-api', () => ({
  emitTauriOpenDiffFromMobile: vi.fn(),
  emitTauriOpenFileFromMobile: vi.fn()
}))

import { callTauriFileRuntimeRpc } from './tauri-file-runtime-rpc'

describe('legacy SSH file runtime deadlines', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeEnvCallMock } }
    })
    runtimeEnvCallMock.mockRejectedValue(new Error('runtime environment not found'))
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/worktrees' && options?.method === 'GET') {
          return [{ id: 'wt-ssh', projectId: 'repo-ssh', path: '/remote/repo' }]
        }
        if (path === '/v1/projects' && options?.method === 'GET') {
          return [{ id: 'repo-ssh', locationKind: 'ssh', hostId: 'ssh-target-1' }]
        }
        if (path === '/v1/source-control?workspaceId=wt-ssh' && options?.method === 'GET') {
          return [{ repositoryId: 'repo-ssh', workspaceId: 'wt-ssh' }]
        }
        if (path.startsWith('/v1/files/tree?')) {
          return []
        }
        if (path === '/v1/files/write') {
          return { content: 'updated', size: 7 }
        }
        if (path === '/v1/files/search') {
          return { files: [], totalMatches: 0, truncated: false }
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
  })

  it('bounds paired attempts and fallback HTTP relay requests', async () => {
    await callTauriFileRuntimeRpc('files.readDir', {
      worktree: 'id:wt-ssh',
      relativePath: 'src'
    })
    await callTauriFileRuntimeRpc('files.write', {
      worktree: 'id:wt-ssh',
      relativePath: 'src/generated.ts',
      content: 'updated'
    })
    await callTauriFileRuntimeRpc('files.search', {
      worktree: 'id:wt-ssh',
      query: 'needle'
    })

    expect(runtimeEnvCallMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.readDir', timeoutMs: 10_000 })
    )
    expect(runtimeEnvCallMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.write', timeoutMs: 10_000 })
    )
    expect(runtimeEnvCallMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.search', timeoutMs: 30_000 })
    )
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/files/tree?'),
      { method: 'GET', timeoutMs: 3000 }
    )
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/files/write',
      expect.objectContaining({ method: 'POST', timeoutMs: 5000 })
    )
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/files/search',
      expect.objectContaining({ method: 'POST', timeoutMs: 10_000 })
    )
  })
})
