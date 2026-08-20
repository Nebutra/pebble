import { describe, expect, it } from 'vitest'
import {
  LOCAL_TERMINAL_STREAM_PATH,
  LOCAL_TERMINAL_STREAM_PROTOCOL,
  LOCAL_TERMINAL_STREAM_TOKEN_PREFIX,
  createLocalTerminalStream,
  type SocketLike
} from './local-terminal-stream'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame
} from './local-terminal-stream-protocol'

class FakeSocket implements SocketLike {
  binaryType = ''
  readyState = 0
  sent: Uint8Array[] = []
  closed = false
  onopen: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null

  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {}

  send(data: ArrayBufferView): void {
    this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }

  close(): void {
    this.closed = true
  }

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  /** Delivers the runtime's acknowledgement for a stream. */
  acknowledge(streamId: number, type: string): void {
    const payload = new TextEncoder().encode(JSON.stringify({ type }))
    const frame = encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Metadata,
      streamId,
      payload
    })
    const copy = new Uint8Array(frame)
    this.onmessage?.({ data: copy.buffer })
  }

  frames(): ReturnType<typeof decodeTerminalStreamFrame>[] {
    return this.sent.map((bytes) => decodeTerminalStreamFrame(bytes))
  }
}

function createHarness(options: { token?: string } = {}) {
  const sockets: FakeSocket[] = []
  const scheduled: (() => void)[] = []
  const clock = { now: 0 }
  const stream = createLocalTerminalStream({
    url: 'ws://127.0.0.1:17777',
    token: options.token ?? 'test-token',
    connect: (url, protocols) => {
      const socket = new FakeSocket(url, protocols)
      sockets.push(socket)
      return socket
    },
    schedule: (callback) => {
      scheduled.push(callback)
    },
    now: () => clock.now
  })
  return { stream, sockets, scheduled, clock }
}

describe('createLocalTerminalStream', () => {
  it('offers the endpoint protocol and its token, which a browser cannot send as a header', () => {
    const { stream, sockets } = createHarness({ token: 'abc123' })
    stream.start()

    expect(sockets[0]?.url).toBe(`ws://127.0.0.1:17777${LOCAL_TERMINAL_STREAM_PATH}`)
    expect(sockets[0]?.protocols).toEqual([
      LOCAL_TERMINAL_STREAM_PROTOCOL,
      `${LOCAL_TERMINAL_STREAM_TOKEN_PREFIX}abc123`
    ])
    expect(sockets[0]?.binaryType).toBe('arraybuffer')
  })

  it('refuses writes until the runtime opens the stream', () => {
    const { stream, sockets } = createHarness()
    stream.start()
    sockets[0]?.open()
    stream.open('sess-1')

    expect(stream.tryWrite('sess-1', 'a')).toBe(false)

    sockets[0]?.acknowledge(1, 'subscribed')

    expect(stream.tryWrite('sess-1', 'a')).toBe(true)
    const input = sockets[0]?.frames().at(-1)
    expect(input?.opcode).toBe(TerminalStreamOpcode.Input)
    expect(input?.streamId).toBe(1)
    expect(new TextDecoder().decode(input?.payload)).toBe('a')
  })

  it('subscribes without output, which the event channel still delivers', () => {
    const { stream, sockets } = createHarness()
    stream.start()
    sockets[0]?.open()
    stream.open('sess-1')

    const subscribe = sockets[0]?.frames().at(-1)
    expect(subscribe?.opcode).toBe(TerminalStreamOpcode.Subscribe)
    expect(JSON.parse(new TextDecoder().decode(subscribe?.payload))).toEqual({
      terminal: 'sess-1',
      output: false
    })
  })

  it('re-subscribes its sessions after a reconnect, since stream ids die with the socket', () => {
    const { stream, sockets, scheduled } = createHarness()
    stream.start()
    sockets[0]?.open()
    stream.open('sess-1')
    sockets[0]?.acknowledge(1, 'subscribed')
    expect(stream.isReady('sess-1')).toBe(true)

    sockets[0]?.onclose?.({})
    expect(stream.isReady('sess-1')).toBe(false)
    expect(stream.tryWrite('sess-1', 'a')).toBe(false)

    scheduled.shift()?.()
    sockets[1]?.open()

    const resubscribe = sockets[1]?.frames().at(-1)
    expect(resubscribe?.opcode).toBe(TerminalStreamOpcode.Subscribe)
    expect(stream.isReady('sess-1')).toBe(false)

    sockets[1]?.acknowledge(1, 'subscribed')
    expect(stream.tryWrite('sess-1', 'a')).toBe(true)
  })

  it('drops a stream the runtime reports as failed or exited', () => {
    const { stream, sockets } = createHarness()
    stream.start()
    sockets[0]?.open()
    stream.open('sess-1')
    sockets[0]?.acknowledge(1, 'subscribed')
    expect(stream.isReady('sess-1')).toBe(true)

    sockets[0]?.acknowledge(1, 'exited')

    expect(stream.isReady('sess-1')).toBe(false)
    expect(stream.tryWrite('sess-1', 'a')).toBe(false)
  })

  it('does not re-subscribe a rejected session on every keystroke', () => {
    // Why: the transport re-opens a session's stream on its next write, so a
    // stream the runtime keeps rejecting would resend a subscribe per key.
    const { stream, sockets, clock } = createHarness()
    stream.start()
    sockets[0]?.open()
    stream.open('sess-gone')
    sockets[0]?.acknowledge(1, 'error')

    const afterRejection = sockets[0]?.sent.length ?? 0
    stream.open('sess-gone')
    stream.open('sess-gone')
    expect(sockets[0]?.sent.length).toBe(afterRejection)

    clock.now += 1000
    stream.open('sess-gone')
    expect(sockets[0]?.sent.length).toBe(afterRejection + 1)
  })

  it('notifies once per session when its stream opens', () => {
    const { stream, sockets } = createHarness()
    const ready: string[] = []
    stream.onSessionReady((sessionId) => ready.push(sessionId))
    stream.start()
    sockets[0]?.open()
    stream.open('sess-1')
    sockets[0]?.acknowledge(1, 'subscribed')
    sockets[0]?.acknowledge(1, 'subscribed')

    expect(ready).toEqual(['sess-1'])
  })

  it('keeps working when the socket cannot be created at all', () => {
    const scheduled: (() => void)[] = []
    const stream = createLocalTerminalStream({
      url: 'ws://127.0.0.1:17777',
      token: 'test-token',
      connect: () => {
        throw new Error('refused')
      },
      schedule: (callback) => scheduled.push(callback)
    })

    expect(() => stream.start()).not.toThrow()
    expect(stream.tryWrite('sess-1', 'a')).toBe(false)
    expect(scheduled).toHaveLength(1)
  })

  it('stops retrying once stopped', () => {
    const { stream, sockets, scheduled } = createHarness()
    stream.start()
    sockets[0]?.open()
    stream.stop()

    expect(sockets[0]?.closed).toBe(true)
    expect(scheduled).toHaveLength(0)
  })
})
