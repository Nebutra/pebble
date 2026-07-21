import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'
import { encodeFrame, HEADER_LENGTH, MessageType } from './ssh-relay-protocol'

type MockTransport = MultiplexerTransport & {
  dataCallbacks: ((data: Buffer) => void)[]
  closeCallbacks: (() => void)[]
  written: Buffer[]
}

function createMockTransport(): MockTransport {
  const dataCallbacks: ((data: Buffer) => void)[] = []
  const closeCallbacks: (() => void)[] = []
  const written: Buffer[] = []
  return {
    write: (data) => written.push(data),
    onData: (callback) => dataCallbacks.push(callback),
    onClose: (callback) => closeCallbacks.push(callback),
    dataCallbacks,
    closeCallbacks,
    written
  }
}

function makeNotificationFrame(
  method: string,
  params: Record<string, unknown>,
  sequence: number
): Buffer {
  return encodeFrame(
    MessageType.Regular,
    sequence,
    0,
    Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params }))
  )
}

describe('SshChannelMultiplexer lifecycle', () => {
  let transport: MockTransport
  let multiplexer: SshChannelMultiplexer

  beforeEach(() => {
    vi.useFakeTimers()
    transport = createMockTransport()
    multiplexer = new SshChannelMultiplexer(transport)
  })

  afterEach(() => {
    multiplexer.dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('sends notifications without expecting a response', () => {
    multiplexer.notify('pty.data', { id: 'pty-1', data: 'hello' })
    const frame = transport.written[0]
    const payload = JSON.parse(
      frame.subarray(HEADER_LENGTH, HEADER_LENGTH + frame.readUInt32BE(9)).toString()
    )
    expect(payload).toMatchObject({ method: 'pty.data' })
    expect(payload.id).toBeUndefined()
  })

  it('dispatches generic and method-specific notifications', () => {
    const generic = vi.fn()
    const chunk = vi.fn()
    const other = vi.fn()
    multiplexer.onNotification(generic)
    multiplexer.onNotificationByMethod('fs.streamChunk', chunk)
    multiplexer.onNotificationByMethod('fs.streamEnd', other)
    const params = { streamId: 1, seq: 0, data: 'aGk=' }
    transport.dataCallbacks[0](makeNotificationFrame('fs.streamChunk', params, 1))
    expect(generic).toHaveBeenCalledWith('fs.streamChunk', params)
    expect(chunk).toHaveBeenCalledWith(params)
    expect(other).not.toHaveBeenCalled()
  })

  it('removes only the method handler that unsubscribes', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = multiplexer.onNotificationByMethod('fs.streamEnd', first)
    multiplexer.onNotificationByMethod('fs.streamEnd', second)
    unsubscribe()
    transport.dataCallbacks[0](makeNotificationFrame('fs.streamEnd', { streamId: 7 }, 1))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith({ streamId: 7 })
  })

  it.each([
    [
      'generic',
      (bad: () => void, good: () => void) => {
        multiplexer.onNotification(bad)
        multiplexer.onNotification(good)
      }
    ],
    [
      'method',
      (bad: () => void, good: () => void) => {
        multiplexer.onNotificationByMethod('fs.streamChunk', bad)
        multiplexer.onNotificationByMethod('fs.streamChunk', good)
      }
    ]
  ])('contains %s notification subscriber failures', (_kind, register) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = vi.fn(() => {
      throw new Error('subscriber exploded')
    })
    const good = vi.fn()
    register(bad, good)
    expect(() =>
      transport.dataCallbacks[0](makeNotificationFrame('fs.streamChunk', {}, 1))
    ).not.toThrow()
    expect(bad).toHaveBeenCalled()
    expect(good).toHaveBeenCalled()
    expect(warning).toHaveBeenCalled()
    expect(multiplexer.isDisposed()).toBe(false)
  })

  it('sends keepalives and contains timer write failures', () => {
    vi.advanceTimersByTime(5_000)
    expect(transport.written.at(-1)?.[0]).toBe(MessageType.KeepAlive)
    transport.write = vi.fn(() => {
      throw new Error('write EPIPE')
    })
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow()
    expect(multiplexer.isDisposed()).toBe(true)
  })

  it('rejects pending and future requests on dispose', async () => {
    const pending = multiplexer.request('pty.spawn')
    multiplexer.dispose()
    await expect(pending).rejects.toThrow('Multiplexer disposed')
    await expect(multiplexer.request('pty.spawn')).rejects.toThrow('Multiplexer disposed')
  })

  it('clears subscribers and accepts inert registrations after dispose', () => {
    const lifecycle = vi.fn()
    const generic = vi.fn()
    const method = vi.fn()
    multiplexer.onNotification(generic)
    multiplexer.onNotificationByMethod('fs.streamChunk', method)
    multiplexer.onDispose(lifecycle)
    multiplexer.dispose()
    transport.dataCallbacks[0](makeNotificationFrame('fs.streamChunk', {}, 1))
    expect(lifecycle).toHaveBeenCalledWith('shutdown')
    expect(generic).not.toHaveBeenCalled()
    expect(method).not.toHaveBeenCalled()
    expect(() => {
      multiplexer.onNotification(vi.fn())()
      multiplexer.onNotificationByMethod('fs.streamChunk', vi.fn())()
      multiplexer.onDispose(vi.fn())()
    }).not.toThrow()
  })

  it('reports connection loss when the transport closes', async () => {
    const pending = multiplexer.request('pty.spawn')
    transport.closeCallbacks[0]()
    await expect(pending).rejects.toThrow('SSH connection lost, reconnecting...')
    expect(multiplexer.isDisposed()).toBe(true)
  })
})
