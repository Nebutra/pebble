import { describe, expect, it, vi } from 'vitest'

import { createLatestBrowserScreencastForwarder } from './tauri-browser-screencast-forwarder'

function frame(seq: number): Uint8Array {
  return new Uint8Array([seq])
}

describe('latest browser screencast forwarder', () => {
  it('keeps one request active and replaces the pending frame with the newest one', async () => {
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const send = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined)
    const forwarder = createLatestBrowserScreencastForwarder(send)

    forwarder.offer(frame(1))
    forwarder.offer(frame(2))
    forwarder.offer(frame(3))

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toEqual(frame(1))
    releaseFirst()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[1]?.[0]).toEqual(frame(3))
    await forwarder.stop()
  })

  it('drops pending work when stopped and waits for the active request', async () => {
    let release!: () => void
    const active = new Promise<void>((resolve) => {
      release = resolve
    })
    const send = vi.fn().mockReturnValue(active)
    const forwarder = createLatestBrowserScreencastForwarder(send)

    forwarder.offer(frame(1))
    forwarder.offer(frame(2))
    const stopping = forwarder.stop()
    release()
    await stopping

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('reports forwarding failures and rejects later frames', async () => {
    const error = new Error('runtime unavailable')
    const send = vi.fn().mockRejectedValue(error)
    const forwarder = createLatestBrowserScreencastForwarder(send)

    forwarder.offer(frame(1))
    await expect(forwarder.failed).resolves.toBe(error)
    forwarder.offer(frame(2))

    expect(send).toHaveBeenCalledTimes(1)
  })
})
