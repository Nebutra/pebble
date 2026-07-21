// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, playMock, requestRuntimeJsonMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  playMock: vi.fn(() => Promise.resolve()),
  requestRuntimeJsonMock: vi.fn(() => Promise.resolve({ published: true }))
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('./pebble-tauri-runtime-transport', () => ({
  hasTauriInternals: () => true,
  requestRuntimeJson: requestRuntimeJsonMock
}))

import { createPebbleNotificationsApi } from './tauri-notifications-api'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

class TestAudio {
  volume = 1
  constructor(readonly src: string) {}
  addEventListener = vi.fn()
  pause = vi.fn()
  play = playMock
}

describe('createPebbleNotificationsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    window.api = {
      settings: {
        get: vi.fn(() =>
          Promise.resolve({ notifications: { customSoundId: 'two-tone', customSoundPath: null } })
        )
      }
    } as unknown as PreloadApi
    vi.stubGlobal('Audio', TestAudio)
  })

  it('plays bundled notification sounds without a filesystem round trip', async () => {
    const api = createPebbleNotificationsApi({} as PreloadApi['notifications'])

    await expect(api.playSound({ force: true, volume: 35 })).resolves.toEqual({ played: true })
    expect(playMock).toHaveBeenCalledOnce()
    expect(invokeMock).not.toHaveBeenCalledWith('load_notification_sound', expect.anything())
  })

  it('loads custom notification sounds through the bounded native reader', async () => {
    vi.mocked(window.api.settings.get).mockResolvedValue({
      notifications: { customSoundId: 'custom', customSoundPath: '/tmp/pebble-alert.mp3' }
    } as never)
    invokeMock.mockResolvedValue({ dataBase64: 'SUQz', mimeType: 'audio/mpeg' })
    const api = createPebbleNotificationsApi({} as PreloadApi['notifications'])

    await expect(api.playSound({ force: true })).resolves.toEqual({ played: true })
    expect(invokeMock).toHaveBeenCalledWith('load_notification_sound', {
      path: '/tmp/pebble-alert.mp3'
    })
  })

  it('publishes formatted non-test notifications to the native runtime', async () => {
    invokeMock.mockResolvedValue({ delivered: true })
    const api = createPebbleNotificationsApi({} as PreloadApi['notifications'])

    await api.dispatch({
      source: 'terminal-bell',
      worktreeId: 'wt-1',
      notificationId: 'bell-1',
      terminalTitle: 'Build shell'
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/notifications/dispatch', {
      method: 'POST',
      body: expect.objectContaining({
        type: 'notification',
        source: 'terminal-bell',
        worktreeId: 'wt-1',
        notificationId: 'bell-1'
      })
    })
  })

  it('does not publish settings test notifications to mobile clients', async () => {
    invokeMock.mockResolvedValue({ delivered: true })
    const api = createPebbleNotificationsApi({} as PreloadApi['notifications'])
    await api.dispatch({ source: 'test' })
    expect(requestRuntimeJsonMock).not.toHaveBeenCalled()
  })

  it('publishes deduplicated dismiss events without claiming OS toast cancellation', async () => {
    const api = createPebbleNotificationsApi({} as PreloadApi['notifications'])
    await expect(api.dismiss([' notice-1 ', 'notice-1', '', 'notice-2'])).resolves.toEqual({
      dismissed: 0
    })
    expect(requestRuntimeJsonMock.mock.calls).toEqual([
      [
        '/v1/notifications/dispatch',
        { method: 'POST', body: { type: 'dismiss', notificationId: 'notice-1' } }
      ],
      [
        '/v1/notifications/dispatch',
        { method: 'POST', body: { type: 'dismiss', notificationId: 'notice-2' } }
      ]
    ])
  })

  it('preserves native notification permission bridge failures', async () => {
    invokeMock.mockRejectedValue(new Error('notification plugin unavailable'))
    const api = createPebbleNotificationsApi({} as PreloadApi['notifications'])

    await expect(api.getPermissionStatus()).rejects.toThrow('notification plugin unavailable')
    await expect(api.requestPermission()).rejects.toThrow('notification plugin unavailable')
  })
})
