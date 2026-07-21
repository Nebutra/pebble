import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, requestRuntimeJsonMock, readWorktreesMock, readReposMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  requestRuntimeJsonMock: vi.fn(),
  readWorktreesMock: vi.fn(),
  readReposMock: vi.fn()
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('./pebble-tauri-runtime-transport', () => ({ requestRuntimeJson: requestRuntimeJsonMock }))
vi.mock('./pebble-tauri-workspace-runtime-api', () => ({
  readWorktrees: readWorktreesMock,
  readRepos: readReposMock
}))

import {
  callTauriDiagnosticsRuntimeRpc,
  clearTauriDiagnosticsMemoryHistoryForTests,
  readTauriMemorySnapshot
} from './tauri-diagnostics-runtime-rpc'

describe('callTauriDiagnosticsRuntimeRpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearTauriDiagnosticsMemoryHistoryForTests()
  })

  it('maps live Go sessions into the native process-tree collector', async () => {
    requestRuntimeJsonMock.mockResolvedValue([
      {
        id: 'sess-live',
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'leaf-1',
        pid: 42,
        status: 'running'
      },
      { id: 'sess-exited', worktreeId: 'wt-1', pid: 43, status: 'exited' }
    ])
    readWorktreesMock.mockResolvedValue([
      { id: 'wt-1', repoId: 'repo-1', displayName: 'Feature auth' }
    ])
    readReposMock.mockResolvedValue([{ id: 'repo-1', displayName: 'Pebble' }])
    invokeMock.mockResolvedValue({
      app: { memory: 30, history: [] },
      worktrees: [{ worktreeId: 'wt-1', memory: 70, history: [] }],
      totalMemory: 100
    })

    await expect(callTauriDiagnosticsRuntimeRpc('diagnostics.memory')).resolves.toEqual({
      handled: true,
      result: {
        app: { memory: 30, history: [30] },
        worktrees: [{ worktreeId: 'wt-1', memory: 70, history: [70] }],
        totalMemory: 100
      }
    })
    expect(invokeMock).toHaveBeenCalledWith('diagnostics_memory_snapshot', {
      sessions: [
        {
          sessionId: 'sess-live',
          paneKey: 'tab-1:leaf-1',
          pid: 42,
          worktreeId: 'wt-1',
          worktreeName: 'Feature auth',
          repoId: 'repo-1',
          repoName: 'Pebble'
        }
      ]
    })
  })

  it('leaves unrelated runtime methods unhandled', async () => {
    await expect(callTauriDiagnosticsRuntimeRpc('diagnostics.other')).resolves.toEqual({
      handled: false
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('exposes the same native snapshot directly to the desktop memory API', async () => {
    requestRuntimeJsonMock.mockResolvedValue([])
    readWorktreesMock.mockResolvedValue([])
    readReposMock.mockResolvedValue([])
    invokeMock.mockResolvedValue({
      app: { memory: 48, history: [] },
      worktrees: [],
      totalMemory: 48
    })

    await expect(readTauriMemorySnapshot()).resolves.toMatchObject({
      app: { memory: 48, history: [48] },
      totalMemory: 48
    })
    expect(invokeMock).toHaveBeenCalledWith('diagnostics_memory_snapshot', { sessions: [] })
  })
})
