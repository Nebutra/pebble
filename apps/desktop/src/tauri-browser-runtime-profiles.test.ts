import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  cancelNativeDownloadMock,
  getRuntimeResourceJsonMock,
  invokeMock,
  registerNativeProviderMock,
  requestRuntimeResourceJsonMock
} = vi.hoisted(() => ({
  cancelNativeDownloadMock: vi.fn(),
  getRuntimeResourceJsonMock: vi.fn(),
  invokeMock: vi.fn(),
  registerNativeProviderMock: vi.fn(),
  requestRuntimeResourceJsonMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

vi.mock('./runtime-bridge', () => ({
  createNativeProviderRegistrationInput: (input: unknown) => input,
  createRuntimeResourceGetCommand: (input: unknown) => input,
  createRuntimeResourceRequestCommand: (input: unknown) => input,
  getRuntimeResourceJson: getRuntimeResourceJsonMock,
  registerNativeProvider: registerNativeProviderMock,
  requestRuntimeResourceJson: requestRuntimeResourceJsonMock
}))
vi.mock('./tauri-browser-runtime-events', () => ({
  cancelNativeTauriBrowserDownload: cancelNativeDownloadMock
}))

import {
  cancelTauriBrowserDownload,
  deleteTauriBrowserSessionProfile,
  detectTauriBrowserSessionBrowsers,
  getTauriNativeDownloadCapabilities,
  getTauriNativeScreenshotCapabilities,
  listTauriBrowserSessionProfiles
} from './tauri-browser-runtime-profiles'

describe('detectTauriBrowserSessionBrowsers', () => {
  it('exposes every browser family backed by native import under Tauri', async () => {
    invokeMock.mockResolvedValueOnce([
      { family: 'chrome', label: 'Chrome', profiles: [] },
      { family: 'firefox', label: 'Firefox', profiles: [{ id: 'default', label: 'default' }] },
      { family: 'safari', label: 'Safari', profiles: [] }
    ])

    await expect(detectTauriBrowserSessionBrowsers()).resolves.toEqual([
      { family: 'chrome', label: 'Chrome', profiles: [] },
      { family: 'firefox', label: 'Firefox', profiles: [{ id: 'default', label: 'default' }] },
      { family: 'safari', label: 'Safari', profiles: [] }
    ])
  })
})

describe('listTauriBrowserSessionProfiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps runtime browser profiles after the default partition profile', async () => {
    getRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify([{ id: 'profile-1', name: 'Work' }])
    })

    await expect(listTauriBrowserSessionProfiles()).resolves.toEqual([
      {
        id: 'default',
        scope: 'default',
        partition: 'persist:pebble-browser',
        label: 'Default',
        source: null
      },
      {
        id: 'profile-1',
        scope: 'isolated',
        partition: 'persist:pebble-browser-session-profile-1',
        label: 'Work',
        source: null
      }
    ])
    expect(getRuntimeResourceJsonMock).toHaveBeenCalledWith({
      path: '/v1/browser/profiles',
      timeoutMs: 1500
    })
  })

  it('propagates profile list runtime failures instead of hiding profiles as empty', async () => {
    getRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'disconnected',
      httpStatus: null,
      error: 'runtime browser store unavailable',
      body: null
    })

    await expect(listTauriBrowserSessionProfiles()).rejects.toThrow(
      'runtime browser store unavailable'
    )
  })
})

describe('deleteTauriBrowserSessionProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('purges native WebView storage before deleting runtime profile metadata', async () => {
    invokeMock.mockResolvedValueOnce(true)
    requestRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify({ id: 'profile-1', name: 'Work' })
    })

    await expect(deleteTauriBrowserSessionProfile({ profileId: 'profile-1' })).resolves.toBe(true)

    expect(invokeMock).toHaveBeenCalledWith('browser_profile_storage_delete', {
      profileKey: 'pebble-browser-session-profile-1'
    })
    expect(invokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      requestRuntimeResourceJsonMock.mock.invocationCallOrder[0]
    )
  })

  it('keeps runtime metadata when native profile storage cannot be deleted', async () => {
    invokeMock.mockRejectedValueOnce(new Error('profile directory is busy'))

    await expect(deleteTauriBrowserSessionProfile({ profileId: 'profile-1' })).rejects.toThrow(
      'profile directory is busy'
    )
    expect(requestRuntimeResourceJsonMock).not.toHaveBeenCalled()
  })
})

describe('getTauriNativeScreenshotCapabilities', () => {
  it('advertises only the platforms backed by a native capture adapter', () => {
    expect(getTauriNativeScreenshotCapabilities('Mozilla/5.0 (Macintosh)')).toEqual([
      'native-screenshot'
    ])
    expect(getTauriNativeScreenshotCapabilities('Mozilla/5.0 (Windows NT 10.0)')).toEqual([
      'native-screenshot'
    ])
    expect(getTauriNativeScreenshotCapabilities('Mozilla/5.0 (X11; Linux x86_64)')).toEqual([
      'native-screenshot'
    ])
  })
})

describe('getTauriNativeDownloadCapabilities', () => {
  it('advertises byte progress everywhere and cancellation only with a native handle', () => {
    expect(getTauriNativeDownloadCapabilities('Mozilla/5.0 (Macintosh)')).toEqual([
      'native-download-progress',
      'native-download-cancel'
    ])
    expect(getTauriNativeDownloadCapabilities('Mozilla/5.0 (Windows NT 10.0)')).toEqual([
      'native-download-progress',
      'native-download-cancel'
    ])
    expect(getTauriNativeDownloadCapabilities('Mozilla/5.0 (X11; Linux x86_64)')).toEqual([
      'native-download-progress',
      'native-download-cancel'
    ])
  })
})

describe('cancelTauriBrowserDownload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates runtime state only after native cancellation succeeds', async () => {
    cancelNativeDownloadMock.mockResolvedValueOnce(true)
    requestRuntimeResourceJsonMock.mockResolvedValueOnce({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify({ id: 'download-1', status: 'canceled' })
    })

    await expect(cancelTauriBrowserDownload({ downloadId: 'download-1' })).resolves.toBe(true)
    expect(requestRuntimeResourceJsonMock).toHaveBeenCalled()
  })

  it('does not report canceled when the native transfer is still running', async () => {
    cancelNativeDownloadMock.mockResolvedValueOnce(false)

    await expect(cancelTauriBrowserDownload({ downloadId: 'download-1' })).resolves.toBe(false)
    expect(requestRuntimeResourceJsonMock).not.toHaveBeenCalled()
  })
})
