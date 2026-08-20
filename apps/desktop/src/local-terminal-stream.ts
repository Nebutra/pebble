import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  type TerminalStreamOpcodeValue
} from './local-terminal-stream-protocol'

// Why: a keystroke reached its own PTY by crossing the app bridge — invoke(JSON)
// to the host, HTTP to the runtime, an event channel back. This dials the
// runtime's binary terminal socket directly from the page, so typing costs one
// socket write instead of a JSON round trip through native code.
//
// Input only, for now. Output still arrives on the event channel, and a stream
// that also echoed it here would render every byte twice.

export const LOCAL_TERMINAL_STREAM_PATH = '/v1/terminal-stream'
export const LOCAL_TERMINAL_STREAM_PROTOCOL = 'pebble.local-terminal.v1'
export const LOCAL_TERMINAL_STREAM_TOKEN_PREFIX = 'pebble.token.'

const RECONNECT_MIN_DELAY_MS = 250
const RECONNECT_MAX_DELAY_MS = 5000

// Why the DOM event types rather than looser ones: these are properties holding
// functions, so their parameters are checked contravariantly, and a handler
// declared to take `unknown` demands more than WebSocket's own handlers offer —
// which makes a real WebSocket unassignable to this type.
export type SocketLike = {
  binaryType: BinaryType
  readyState: number
  send: (data: ArrayBufferView) => void
  close: () => void
  onopen: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
}

export type LocalTerminalStreamOptions = {
  url: string
  token: string
  connect: (url: string, protocols: string[]) => SocketLike
  /** Retries are scheduled through this so tests need no timers. */
  schedule?: (callback: () => void, delayMs: number) => void
  now?: () => number
}

// Why: the transport re-opens a session's stream on its next write, so a stream
// the runtime keeps rejecting would otherwise be re-subscribed on every
// keystroke. This bounds the retry rate without ever giving up on a session
// that later appears.
const FAILED_STREAM_RETRY_DELAY_MS = 1000

type SessionStream = {
  streamId: number
  /** Writes only move to the socket once the runtime has opened the stream. */
  ready: boolean
}

export type LocalTerminalStream = {
  start: () => void
  stop: () => void
  /** Opens a stream for the session so later writes can take the socket. */
  open: (sessionId: string) => void
  close: (sessionId: string) => void
  /** True when the bytes were handed to the socket; false means use the bridge. */
  tryWrite: (sessionId: string, data: string) => boolean
  isReady: (sessionId: string) => boolean
  /**
   * Called with a session id once its stream is open. The router uses this to
   * flip a session over only after its in-flight bridge writes have landed,
   * which is what keeps the two transports from reordering characters.
   */
  onSessionReady: (listener: (sessionId: string) => void) => () => void
}

const SOCKET_OPEN = 1

export function createLocalTerminalStream(
  options: LocalTerminalStreamOptions
): LocalTerminalStream {
  const encoder = new TextEncoder()
  const streams = new Map<string, SessionStream>()
  const retryNotBefore = new Map<string, number>()
  const readyListeners = new Set<(sessionId: string) => void>()
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const now = options.now ?? (() => Date.now())
  let socket: SocketLike | null = null
  let nextStreamId = 1
  let reconnectDelayMs = RECONNECT_MIN_DELAY_MS
  let stopped = false

  const isOpen = (): boolean => socket !== null && socket.readyState === SOCKET_OPEN

  const sendFrame = (
    opcode: TerminalStreamOpcodeValue,
    streamId: number,
    payload: Uint8Array
  ): boolean => {
    if (!isOpen()) {
      return false
    }
    try {
      socket?.send(encodeTerminalStreamFrame({ opcode, streamId, payload }))
      return true
    } catch {
      return false
    }
  }

  const subscribe = (sessionId: string, stream: SessionStream): void => {
    const payload = encoder.encode(
      // Output stays on the event channel until the renderer's output path moves.
      JSON.stringify({ terminal: sessionId, output: false })
    )
    sendFrame(TerminalStreamOpcode.Subscribe, stream.streamId, payload)
  }

  const markReady = (streamId: number): void => {
    for (const [sessionId, stream] of streams) {
      if (stream.streamId !== streamId || stream.ready) {
        continue
      }
      stream.ready = true
      for (const listener of readyListeners) {
        listener(sessionId)
      }
      return
    }
  }

  const handleFrame = (data: Uint8Array): void => {
    const frame = decodeTerminalStreamFrame(data)
    if (!frame || frame.opcode !== TerminalStreamOpcode.Metadata) {
      return
    }
    let message: { type?: string } = {}
    try {
      message = JSON.parse(new TextDecoder().decode(frame.payload)) as { type?: string }
    } catch {
      return
    }
    if (message.type === 'subscribed') {
      markReady(frame.streamId)
      return
    }
    if (message.type === 'error' || message.type === 'exited') {
      dropStream(frame.streamId, message.type === 'error')
    }
  }

  const dropStream = (streamId: number, backOff: boolean): void => {
    for (const [sessionId, stream] of streams) {
      if (stream.streamId === streamId) {
        streams.delete(sessionId)
        if (backOff) {
          retryNotBefore.set(sessionId, now() + FAILED_STREAM_RETRY_DELAY_MS)
        }
        return
      }
    }
  }

  const connect = (): void => {
    if (stopped || socket !== null) {
      return
    }
    let created: SocketLike
    try {
      created = options.connect(options.url + LOCAL_TERMINAL_STREAM_PATH, [
        LOCAL_TERMINAL_STREAM_PROTOCOL,
        LOCAL_TERMINAL_STREAM_TOKEN_PREFIX + options.token
      ])
    } catch {
      // No socket means every write keeps taking the bridge, which still works.
      scheduleReconnect()
      return
    }
    created.binaryType = 'arraybuffer'
    socket = created
    created.onopen = () => {
      reconnectDelayMs = RECONNECT_MIN_DELAY_MS
      // A reconnect inherits the sessions the previous socket held, and their
      // stream ids are only meaningful to the connection that opened them.
      for (const [sessionId, stream] of streams) {
        stream.ready = false
        subscribe(sessionId, stream)
      }
    }
    created.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        handleFrame(new Uint8Array(event.data))
      }
    }
    created.onerror = () => undefined
    created.onclose = () => {
      socket = null
      for (const stream of streams.values()) {
        stream.ready = false
      }
      scheduleReconnect()
    }
  }

  const scheduleReconnect = (): void => {
    if (stopped) {
      return
    }
    const delayMs = reconnectDelayMs
    reconnectDelayMs = Math.min(RECONNECT_MAX_DELAY_MS, reconnectDelayMs * 2)
    schedule(connect, delayMs)
  }

  return {
    start() {
      stopped = false
      connect()
    },
    stop() {
      stopped = true
      streams.clear()
      retryNotBefore.clear()
      const existing = socket
      socket = null
      existing?.close()
    },
    open(sessionId) {
      if (streams.has(sessionId)) {
        return
      }
      const blockedUntil = retryNotBefore.get(sessionId)
      if (blockedUntil !== undefined && now() < blockedUntil) {
        return
      }
      retryNotBefore.delete(sessionId)
      const stream: SessionStream = { streamId: nextStreamId, ready: false }
      nextStreamId += 1
      streams.set(sessionId, stream)
      subscribe(sessionId, stream)
    },
    close(sessionId) {
      retryNotBefore.delete(sessionId)
      const stream = streams.get(sessionId)
      if (!stream) {
        return
      }
      streams.delete(sessionId)
      sendFrame(TerminalStreamOpcode.Unsubscribe, stream.streamId, new Uint8Array())
    },
    tryWrite(sessionId, data) {
      const stream = streams.get(sessionId)
      if (!stream || !stream.ready) {
        return false
      }
      return sendFrame(TerminalStreamOpcode.Input, stream.streamId, encoder.encode(data))
    },
    isReady(sessionId) {
      return streams.get(sessionId)?.ready === true
    },
    onSessionReady(listener) {
      readyListeners.add(listener)
      return () => readyListeners.delete(listener)
    }
  }
}
