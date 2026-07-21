import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureMock, requestMock, subscribeMock } = vi.hoisted(() => ({
  ensureMock: vi.fn().mockResolvedValue(undefined),
  requestMock: vi.fn(),
  subscribeMock: vi.fn().mockResolvedValue({ supported: true })
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: ensureMock,
  requestRuntimeJson: requestMock
}))
vi.mock('./tauri-runtime-event-push', () => ({ subscribeRuntimeEventPush: subscribeMock }))

import { createPebbleWorkspaceSpaceApi } from './tauri-workspace-space-api'

describe('createPebbleWorkspaceSpaceApi', () => {
  beforeEach(() => {
    ensureMock.mockClear()
    requestMock.mockReset()
  })

  it('analyzes and cancels through the Go runtime', async () => {
    requestMock.mockResolvedValueOnce({ ok: true, analysis: { worktreeCount: 0 } })
    requestMock.mockResolvedValueOnce({ cancelled: true })
    const api = createPebbleWorkspaceSpaceApi()

    await expect(api.analyze()).resolves.toMatchObject({ ok: true })
    await expect(api.cancel()).resolves.toBe(true)
    expect(requestMock).toHaveBeenNthCalledWith(1, '/v1/workspace-space/analyze', {
      method: 'POST'
    })
    expect(requestMock).toHaveBeenNthCalledWith(2, '/v1/workspace-space/cancel', {
      method: 'POST'
    })
  })

  it('forwards valid native progress events', async () => {
    const api = createPebbleWorkspaceSpaceApi()
    const listener = vi.fn()
    api.onProgress(listener)
    const push = subscribeMock.mock.calls[0]?.[0]
    push?.({
      topic: 'workspace-space.progress',
      data: JSON.stringify({ payload: { scanId: 'space-1', state: 'running' } })
    })
    expect(listener).toHaveBeenCalledWith({ scanId: 'space-1', state: 'running' })
  })
})
