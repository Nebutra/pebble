import { describe, expect, it, vi } from 'vitest'

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

import { createPebbleSparsePresetsApi } from './tauri-sparse-presets-api'

describe('createPebbleSparsePresetsApi', () => {
  it('persists and removes repo-scoped presets through Go', async () => {
    requestMock.mockResolvedValue({ id: 'preset-1' })
    const api = createPebbleSparsePresetsApi()
    await api.save({ repoId: 'repo/a', name: 'Web', directories: ['apps/web'] })
    expect(requestMock).toHaveBeenCalledWith('/v1/sparse-presets?repoId=repo%2Fa', {
      method: 'POST',
      body: { name: 'Web', directories: ['apps/web'] }
    })
    await api.remove({ repoId: 'repo/a', presetId: 'preset 1' })
    expect(requestMock).toHaveBeenLastCalledWith(
      '/v1/sparse-presets?repoId=repo%2Fa&presetId=preset%201',
      { method: 'DELETE' }
    )
  })
})
