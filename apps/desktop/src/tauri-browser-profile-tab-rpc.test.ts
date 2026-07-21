import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { deleteTauriBrowserProfileStorage } from './tauri-browser-runtime-profiles'
import { deleteBrowserProfile } from './tauri-browser-profile-tab-rpc'

vi.mock('./pebble-tauri-runtime-transport', () => ({ requestRuntimeJson: vi.fn() }))
vi.mock('./tauri-browser-runtime-profiles', () => ({
  deleteTauriBrowserProfileStorage: vi.fn(),
  detectTauriBrowserSessionBrowsers: vi.fn()
}))

const requestRuntimeJsonMock = vi.mocked(requestRuntimeJson)
const deleteStorageMock = vi.mocked(deleteTauriBrowserProfileStorage)

describe('deleteBrowserProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('purges local native storage before removing paired-runtime metadata', async () => {
    deleteStorageMock.mockResolvedValueOnce(undefined)
    requestRuntimeJsonMock.mockResolvedValueOnce({ id: 'profile-1', name: 'Work' })

    await expect(deleteBrowserProfile({ profileId: 'profile-1' })).resolves.toEqual({
      deleted: true,
      profileId: 'profile-1'
    })

    expect(deleteStorageMock).toHaveBeenCalledWith('profile-1')
    expect(deleteStorageMock.mock.invocationCallOrder[0]).toBeLessThan(
      requestRuntimeJsonMock.mock.invocationCallOrder[0]
    )
  })
})
