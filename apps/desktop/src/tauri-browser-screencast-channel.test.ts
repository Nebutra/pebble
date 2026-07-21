import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFrameSequence, startTauriBrowserScreencast } from './tauri-browser-screencast-channel'
import { createLatestBrowserScreencastForwarder } from './tauri-browser-screencast-forwarder'

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  onmessage: null as ((frame: ArrayBuffer) => void) | null
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
  Channel: class<T> {
    constructor(onmessage: (message: T) => void) {
      tauriMocks.onmessage = onmessage as (frame: ArrayBuffer) => void
    }
  }
}))

describe('Tauri browser screencast channel', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset()
    tauriMocks.onmessage = null
  })

  it('reads the shared protocol sequence from a raw frame', () => {
    const frame = new Uint8Array(16)
    frame.set([0x62, 1, 1, 1])
    new DataView(frame.buffer).setUint32(4, 73, true)
    expect(readFrameSequence(frame)).toBe(73)
  })

  it('rejects JSON and malformed binary payloads', () => {
    expect(() => readFrameSequence(new Uint8Array([0x62, 1, 1]))).toThrow('invalid protocol')
    expect(() => readFrameSequence(new Uint8Array(16))).toThrow('invalid protocol')
  })

  it('stops native capture when the channel receives a malformed frame', async () => {
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === 'browser_screencast_start') {
        return Promise.resolve({ streamId: 'native-invalid' })
      }
      return Promise.resolve()
    })
    await startTauriBrowserScreencast({
      label: 'browser-tab-1',
      format: 'jpeg',
      minFrameIntervalMs: 16,
      deviceScaleFactor: 2,
      onFrame: vi.fn()
    })

    tauriMocks.onmessage?.(new Uint8Array([0x62, 1, 1]).buffer)

    await vi.waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith('browser_screencast_stop', {
        input: { streamId: 'native-invalid' }
      })
    )
  })

  it('waits for the native stream id before forwarding and acknowledging frame zero', async () => {
    let resolveStart!: (value: { streamId: string }) => void
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === 'browser_screencast_start') {
        return new Promise((resolve) => {
          resolveStart = resolve
        })
      }
      return Promise.resolve()
    })
    const onFrame = vi.fn()
    const pendingSession = startTauriBrowserScreencast({
      label: 'browser-tab-1',
      format: 'jpeg',
      minFrameIntervalMs: 16,
      deviceScaleFactor: 2,
      onFrame
    })
    const frame = new Uint8Array(16)
    frame.set([0x62, 1, 1, 1])
    new DataView(frame.buffer).setUint32(4, 1, true)
    tauriMocks.onmessage?.(frame.buffer)
    await Promise.resolve()
    expect(onFrame).not.toHaveBeenCalled()

    resolveStart({ streamId: 'native-1' })
    await pendingSession
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledOnce())
    expect(tauriMocks.invoke).toHaveBeenCalledWith('browser_screencast_ack', {
      input: { streamId: 'native-1', seq: 1 }
    })
  })

  it('acknowledges native capture without waiting for runtime frame forwarding', async () => {
    let releaseForward!: () => void
    const forwardPending = new Promise<void>((resolve) => {
      releaseForward = resolve
    })
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === 'browser_screencast_start') {
        return Promise.resolve({ streamId: 'native-fast' })
      }
      return Promise.resolve()
    })
    const forwarder = createLatestBrowserScreencastForwarder(() => forwardPending)
    const session = await startTauriBrowserScreencast({
      label: 'browser-tab-1',
      format: 'jpeg',
      minFrameIntervalMs: 16,
      deviceScaleFactor: 2,
      onFrame: (frame) => forwarder.offer(frame)
    })
    const rawFrame = new Uint8Array(16)
    rawFrame.set([0x62, 1, 1, 1])
    new DataView(rawFrame.buffer).setUint32(4, 9, true)

    tauriMocks.onmessage?.(rawFrame.buffer)

    await vi.waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith('browser_screencast_ack', {
        input: { streamId: 'native-fast', seq: 9 }
      })
    )
    releaseForward()
    await forwarder.stop()
    await session.stop()
  })
})
