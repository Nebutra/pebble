import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureRuntimeMock, requestRuntimeMock } = vi.hoisted(() => ({
  ensureRuntimeMock: vi.fn(),
  requestRuntimeMock: vi.fn()
}))
vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: ensureRuntimeMock,
  requestRuntimeJson: requestRuntimeMock
}))

import { createPebbleLocalhostWorktreeLabelsApi } from './tauri-localhost-worktree-labels-api'

beforeEach(() => vi.clearAllMocks())

describe('createPebbleLocalhostWorktreeLabelsApi', () => {
  it('registers the route with the native runtime', async () => {
    requestRuntimeMock.mockResolvedValue({
      label: 'fast-terminal',
      url: 'http://fast-terminal.pebble.localhost:17777/'
    })
    const route = {
      targetUrl: 'http://127.0.0.1:5173/',
      projectName: 'Pebble',
      worktreeName: 'feature/fast-terminal'
    }
    await expect(createPebbleLocalhostWorktreeLabelsApi().register(route)).resolves.toMatchObject({
      label: 'fast-terminal'
    })
    expect(requestRuntimeMock).toHaveBeenCalledWith('/v1/localhost-worktree-labels/register', {
      method: 'POST',
      body: route
    })
  })
})
