import { describe, expect, it, vi } from 'vitest'
import { TauriEmulatorVideoRegistry, type NativeVideoFrame } from './tauri-emulator-video-registry'

function frame(streamId: string, keyFrame: boolean, value: number): NativeVideoFrame {
  return {
    streamId,
    deviceId: 'device-1',
    config: false,
    keyFrame,
    pts: String(value),
    gopIndex: 1,
    bytes: new Uint8Array([value]).buffer
  }
}

describe('TauriEmulatorVideoRegistry', () => {
  it('delivers startup frames exactly once after the native session becomes ready', async () => {
    let resolveStart: () => void = () => {}
    const start = vi.fn(
      (_deviceId: string, _streamId: string) =>
        new Promise<void>((resolve) => {
          resolveStart = () => resolve()
        })
    )
    const metas: string[] = []
    const frames: string[] = []
    const registry = new TauriEmulatorVideoRegistry(
      start,
      vi.fn(async () => undefined),
      (payload) => metas.push(payload.streamId),
      (payload) => frames.push(`${payload.streamId}:${payload.pts}`),
      vi.fn()
    )
    const subscription = registry.subscribe('device-1', 'pane-a')
    const nativeStreamId = start.mock.calls[0][1]
    registry.acceptMeta({
      streamId: nativeStreamId,
      deviceId: 'device-1',
      meta: { codecId: 'h264', width: 100, height: 200 }
    })
    registry.acceptFrame(frame(nativeStreamId, true, 1))
    expect(metas).toEqual([])
    expect(frames).toEqual([])

    resolveStart()
    await subscription
    expect(metas).toEqual(['pane-a'])
    expect(frames).toEqual(['pane-a:1'])
  })

  it('shares one native session and replays a decodeable GOP to late subscribers', async () => {
    const start = vi.fn(async (_deviceId: string, _streamId: string) => undefined)
    const stop = vi.fn(async (_streamId: string) => undefined)
    const metas: string[] = []
    const frames: string[] = []
    const registry = new TauriEmulatorVideoRegistry(
      start,
      stop,
      (payload) => metas.push(payload.streamId),
      (payload) => frames.push(`${payload.streamId}:${payload.pts}`),
      vi.fn()
    )
    await registry.subscribe('device-1', 'pane-a')
    const nativeStreamId = start.mock.calls[0][1]
    registry.acceptMeta({
      streamId: nativeStreamId,
      deviceId: 'device-1',
      meta: { codecId: 'h264', width: 100, height: 200 }
    })
    registry.acceptFrame(frame(nativeStreamId, true, 1))
    registry.acceptFrame(frame(nativeStreamId, false, 2))

    await registry.subscribe('device-1', 'pane-b')

    expect(start).toHaveBeenCalledTimes(1)
    expect(metas).toContain('pane-b')
    expect(frames.slice(-2)).toEqual(['pane-b:1', 'pane-b:2'])
    await registry.unsubscribe('pane-a')
    expect(stop).not.toHaveBeenCalled()
    await registry.unsubscribe('pane-b')
    expect(stop).toHaveBeenCalledWith(nativeStreamId)
  })

  it('drops pre-keyframe deltas and replaces the old GOP at a new keyframe', async () => {
    const frames: string[] = []
    const start = vi.fn(async (_deviceId: string, _streamId: string) => undefined)
    const registry = new TauriEmulatorVideoRegistry(
      start,
      vi.fn(async (_streamId: string) => undefined),
      vi.fn(),
      (payload) => frames.push(`${payload.streamId}:${payload.pts}`),
      vi.fn()
    )
    await registry.subscribe('device-1', 'pane-a')
    const nativeStreamId = start.mock.calls[0][1]
    registry.acceptFrame(frame(nativeStreamId, false, 0))
    registry.acceptFrame(frame(nativeStreamId, true, 1))
    registry.acceptFrame(frame(nativeStreamId, false, 2))
    registry.acceptFrame(frame(nativeStreamId, true, 3))
    await registry.subscribe('device-1', 'pane-b')
    expect(frames.slice(-1)).toEqual(['pane-b:3'])
  })

  it('replays config separately without inserting it into the current GOP', async () => {
    const frames: string[] = []
    const start = vi.fn(async (_deviceId: string, _streamId: string) => undefined)
    const registry = new TauriEmulatorVideoRegistry(
      start,
      vi.fn(async (_streamId: string) => undefined),
      vi.fn(),
      (payload) => frames.push(`${payload.streamId}:${payload.config ? 'C' : payload.pts}`),
      vi.fn()
    )
    await registry.subscribe('device-1', 'pane-a')
    const nativeStreamId = start.mock.calls[0][1]
    registry.acceptFrame(frame(nativeStreamId, true, 1))
    registry.acceptFrame({ ...frame(nativeStreamId, false, 0), config: true })
    registry.acceptFrame(frame(nativeStreamId, false, 2))

    await registry.subscribe('device-1', 'pane-b')
    expect(frames.slice(-3)).toEqual(['pane-b:C', 'pane-b:1', 'pane-b:2'])
  })

  it('rejects duplicate subscriber ids across devices', async () => {
    const registry = new TauriEmulatorVideoRegistry(
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
      vi.fn(),
      vi.fn(),
      vi.fn()
    )
    await registry.subscribe('device-1', 'pane-a')
    await expect(registry.subscribe('device-2', 'pane-a')).rejects.toThrow('already active')
  })

  it('bounds replay frames while retaining the keyframe anchor', async () => {
    const replay: string[] = []
    const start = vi.fn(async (_deviceId: string, _streamId: string) => undefined)
    const registry = new TauriEmulatorVideoRegistry(
      start,
      vi.fn(async () => undefined),
      vi.fn(),
      (payload) => {
        if (payload.streamId === 'pane-b') {
          replay.push(payload.pts)
        }
      },
      vi.fn()
    )
    await registry.subscribe('device-1', 'pane-a')
    const nativeStreamId = start.mock.calls[0][1]
    registry.acceptFrame(frame(nativeStreamId, true, 0))
    for (let index = 1; index <= 120; index += 1) {
      registry.acceptFrame(frame(nativeStreamId, false, index))
    }

    await registry.subscribe('device-1', 'pane-b')
    expect(replay).toHaveLength(120)
    expect(replay[0]).toBe('0')
    expect(replay[1]).toBe('2')
    expect(replay.at(-1)).toBe('120')
  })
})
