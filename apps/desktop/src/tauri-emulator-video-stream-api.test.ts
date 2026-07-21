import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, listenMock, eventHandlers } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  eventHandlers: new Map<string, (event: { payload: never }) => void>()
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock.mockImplementation(async (name: string, callback: never) => {
    eventHandlers.set(name, callback)
    return () => undefined
  })
}))

import { installTauriEmulatorVideoStreamApi } from './tauri-emulator-video-stream-api'

beforeEach(() => {
  vi.clearAllMocks()
  eventHandlers.clear()
  vi.stubGlobal('window', {
    __TAURI_INTERNALS__: {},
    api: {
      emulator: {
        onPaneFocus: vi.fn(),
        onAutoAttach: vi.fn(),
        startFrameStream: vi.fn(),
        stopFrameStream: vi.fn(),
        onFrameStreamFrame: vi.fn(),
        onFrameStreamError: vi.fn()
      }
    }
  })
})

describe('installTauriEmulatorVideoStreamApi', () => {
  it('starts native scrcpy and preserves real H264 frame metadata', async () => {
    invokeMock.mockResolvedValueOnce({ streamId: 'video-1' })
    installTauriEmulatorVideoStreamApi()
    const onMeta = vi.fn()
    const onFrame = vi.fn()
    const onError = vi.fn()
    window.api.emulator.onVideoStreamMeta(onMeta)
    window.api.emulator.onVideoStreamFrame(onFrame)
    window.api.emulator.onVideoStreamError?.(onError)

    await expect(
      window.api.emulator.startVideoStream({ deviceId: 'emulator-5554', streamId: 'video-1' })
    ).resolves.toEqual({ streamId: 'video-1' })
    const nativeStreamId = invokeMock.mock.calls.find(
      ([command]) => command === 'emulator_video_stream_start'
    )?.[1].input.streamId as string

    eventHandlers.get('pebble:emulator-video-meta')?.({
      payload: {
        streamId: nativeStreamId,
        deviceId: 'emulator-5554',
        meta: { codecId: 'h264', width: 1080, height: 2400 }
      } as never
    })
    eventHandlers.get('pebble:emulator-video-frame')?.({
      payload: {
        streamId: nativeStreamId,
        deviceId: 'emulator-5554',
        config: false,
        keyFrame: true,
        pts: '42000',
        gopIndex: 7,
        contentBase64: 'AAECAw=='
      } as never
    })
    eventHandlers.get('pebble:emulator-video-error')?.({
      payload: {
        streamId: nativeStreamId,
        deviceId: 'emulator-5554',
        message: 'socket closed'
      } as never
    })

    expect(invokeMock).toHaveBeenCalledWith('emulator_video_stream_start', {
      input: { deviceId: 'emulator-5554', streamId: nativeStreamId }
    })
    expect(onMeta).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { codecId: 'h264', width: 1080, height: 2400 } })
    )
    expect(onFrame).toHaveBeenCalledWith(
      expect.objectContaining({ keyFrame: true, pts: '42000', gopIndex: 7 })
    )
    expect(Array.from(new Uint8Array(onFrame.mock.calls[0][0].bytes))).toEqual([0, 1, 2, 3])
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'socket closed' }))
  })

  it('stops the exact native stream id', async () => {
    invokeMock.mockResolvedValueOnce({ streamId: 'native' })
    installTauriEmulatorVideoStreamApi()
    await window.api.emulator.startVideoStream({ deviceId: 'emulator-2', streamId: 'video-2' })
    const nativeStreamId = invokeMock.mock.calls.find(
      ([command]) => command === 'emulator_video_stream_start'
    )?.[1].input.streamId as string
    await window.api.emulator.stopVideoStream({ streamId: 'video-2' })
    expect(invokeMock).toHaveBeenCalledWith('emulator_video_stream_stop', {
      input: { streamId: nativeStreamId }
    })
  })
})
