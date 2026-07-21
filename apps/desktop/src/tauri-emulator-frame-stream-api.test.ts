import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, listenMock, eventHandlers } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>()
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock.mockImplementation(async (name: string, callback: never) => {
    eventHandlers.set(name, callback)
    return () => undefined
  })
}))

import { installTauriEmulatorFrameStreamApi } from './tauri-emulator-frame-stream-api'

beforeEach(() => {
  vi.clearAllMocks()
  eventHandlers.clear()
  vi.stubGlobal('window', {
    __TAURI_INTERNALS__: {},
    api: {
      emulator: {
        onPaneFocus: vi.fn(),
        onAutoAttach: vi.fn()
      }
    }
  })
})

describe('installTauriEmulatorFrameStreamApi', () => {
  it('starts native MJPEG streams and delivers binary frames', async () => {
    invokeMock.mockResolvedValueOnce({ streamId: 'stream-1' })
    installTauriEmulatorFrameStreamApi()
    const onFrame = vi.fn()
    window.api.emulator.onFrameStreamFrame(onFrame)

    await expect(
      window.api.emulator.startFrameStream({ streamUrl: 'http://127.0.0.1/stream.mjpeg' })
    ).resolves.toEqual({ streamId: 'stream-1' })
    eventHandlers.get('pebble:emulator-frame')?.({
      payload: { streamId: 'stream-1', contentBase64: 'AQID' }
    })

    expect(invokeMock).toHaveBeenCalledWith('emulator_frame_stream_start', {
      input: { streamUrl: 'http://127.0.0.1/stream.mjpeg' }
    })
    expect(Array.from(new Uint8Array(onFrame.mock.calls[0][0].bytes))).toEqual([1, 2, 3])
  })
})
