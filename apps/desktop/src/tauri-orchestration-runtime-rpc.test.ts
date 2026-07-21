import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  ensure: vi.fn(),
  request: vi.fn()
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: runtime.ensure,
  requestRuntimeJson: runtime.request
}))

import { callTauriOrchestrationRuntimeRpc } from './tauri-orchestration-runtime-rpc'

describe('callTauriOrchestrationRuntimeRpc', () => {
  beforeEach(() => {
    runtime.ensure.mockReset().mockResolvedValue(undefined)
    runtime.request.mockReset()
  })

  it('maps the latest Go dispatch to the renderer terminal-link contract', async () => {
    runtime.request.mockResolvedValue([
      {
        id: 'dispatch-1',
        taskId: 'task-1',
        assignee: 'codex',
        sessionId: 'session-old',
        status: 'completed',
        createdAt: '2026-07-19T01:00:00Z',
        updatedAt: '2026-07-19T01:01:00Z'
      },
      {
        id: 'dispatch-2',
        taskId: 'task-1',
        assignee: 'claude',
        sessionId: 'session-live',
        status: 'injected',
        createdAt: '2026-07-19T02:00:00Z',
        updatedAt: '2026-07-19T02:01:00Z'
      }
    ])

    await expect(
      callTauriOrchestrationRuntimeRpc('orchestration.dispatchShow', { task: ' task-1 ' })
    ).resolves.toEqual({
      handled: true,
      result: {
        dispatch: expect.objectContaining({
          id: 'dispatch-2',
          task_id: 'task-1',
          assignee_handle: 'session-live'
        })
      }
    })
    expect(runtime.request).toHaveBeenCalledWith('/v1/orchestration/dispatches?taskId=task-1', {
      method: 'GET',
      timeoutMs: 5000
    })
  })

  it('returns null when a task has never been dispatched', async () => {
    runtime.request.mockResolvedValue([])
    await expect(
      callTauriOrchestrationRuntimeRpc('orchestration.dispatchShow', { task: 'task-2' })
    ).resolves.toEqual({ handled: true, result: { dispatch: null } })
  })

  it('returns the native Go preamble preview with the latest dispatch', async () => {
    runtime.request
      .mockResolvedValueOnce([
        {
          id: 'dispatch-live',
          taskId: 'task-native',
          assignee: 'codex',
          sessionId: 'session-live',
          status: 'injected',
          createdAt: '2026-07-20T01:00:00Z',
          updatedAt: '2026-07-20T01:01:00Z'
        }
      ])
      .mockResolvedValueOnce({ preamble: 'native worker protocol' })

    await expect(
      callTauriOrchestrationRuntimeRpc('orchestration.dispatchShow', {
        task: 'task-native',
        preamble: true,
        from: 'term coordinator',
        devMode: true
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        dispatch: expect.objectContaining({ id: 'dispatch-live' }),
        preamble: 'native worker protocol'
      }
    })
    expect(runtime.request).toHaveBeenNthCalledWith(
      2,
      '/v1/orchestration/dispatch-preamble?taskId=task-native&from=term+coordinator&devMode=true',
      { method: 'GET', timeoutMs: 5000 }
    )
  })

  it('leaves unrelated methods for other domain dispatchers', async () => {
    await expect(callTauriOrchestrationRuntimeRpc('repo.list', {})).resolves.toEqual({
      handled: false
    })
    expect(runtime.ensure).not.toHaveBeenCalled()
  })
})
