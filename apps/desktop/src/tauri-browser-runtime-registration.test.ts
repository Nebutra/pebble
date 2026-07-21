import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestRuntimeJsonMock } = vi.hoisted(() => ({
  requestRuntimeJsonMock: vi.fn()
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))

import {
  registerTauriBrowserGuest,
  unregisterTauriBrowserGuest
} from './tauri-browser-runtime-events'

describe('Tauri browser runtime registration', () => {
  beforeEach(() => {
    requestRuntimeJsonMock.mockReset()
    requestRuntimeJsonMock.mockResolvedValue({})
  })

  it('uses the renderer page UUID as the runtime browser tab identity', async () => {
    const browserPageId = '7f608e5c-19c0-4df7-b5f2-00f65ef367c8'

    await registerTauriBrowserGuest({
      browserPageId,
      workspaceId: 'project-1',
      worktreeId: 'worktree-1',
      sessionProfileId: 'profile-1',
      webContentsId: 42
    })
    await unregisterTauriBrowserGuest(browserPageId)

    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(1, '/v1/browser/tabs', {
      method: 'POST',
      body: {
        id: browserPageId,
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        profileId: 'profile-1',
        title: browserPageId,
        url: 'about:blank'
      }
    })
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(2, `/v1/browser/tabs/${browserPageId}`, {
      method: 'DELETE'
    })
  })
})
