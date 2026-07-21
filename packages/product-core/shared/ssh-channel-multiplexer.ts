import {
  FrameDecoder,
  MessageType,
  encodeJsonRpcFrame,
  encodeKeepAliveFrame,
  parseJsonRpcMessage,
  KEEPALIVE_SEND_MS,
  TIMEOUT_MS,
  type DecodedFrame,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification
} from './ssh-relay-protocol'
import type {
  MethodNotificationHandler,
  MultiplexerTransport,
  NotificationHandler,
  RequestHandler
} from './ssh-multiplexer-contracts'
import { SshMultiplexerHandlerRegistry } from './ssh-multiplexer-handler-registry'
import { SshMultiplexerRequestTracker } from './ssh-multiplexer-request-tracker'

export type {
  MethodNotificationHandler,
  MultiplexerTransport,
  NotificationHandler,
  RequestHandler
} from './ssh-multiplexer-contracts'

const REQUEST_TIMEOUT_MS = 30_000

export class SshChannelMultiplexer {
  private decoder: FrameDecoder
  private transport: MultiplexerTransport
  private nextRequestId = 1
  private nextOutgoingSeq = 1
  private highestReceivedSeq = 0
  private highestAckedBySelf = 0
  private lastReceivedAt = Date.now()
  private requests = new SshMultiplexerRequestTracker()
  private handlers = new SshMultiplexerHandlerRegistry()
  private disposeHandlers: ((reason: 'shutdown' | 'connection_lost') => void)[] = []
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private timeoutTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  // Track the oldest unacked outgoing message timestamp
  private unackedTimestamps = new Map<number, number>()

  constructor(transport: MultiplexerTransport) {
    this.transport = transport

    this.decoder = new FrameDecoder(
      (frame) => this.handleFrame(frame),
      (err) => this.handleProtocolError(err)
    )

    transport.onData((data) => {
      if (this.disposed) {
        return
      }
      this.lastReceivedAt = Date.now()
      this.decoder.feed(data)
    })

    transport.onClose(() => {
      this.dispose('connection_lost')
    })

    if (this.disposed) {
      return
    }
    this.startKeepalive()
    this.startTimeoutCheck()
  }

  onNotification(handler: NotificationHandler): () => void {
    if (this.disposed) {
      return () => {}
    }
    return this.handlers.onNotification(handler)
  }

  onNotificationByMethod(method: string, handler: MethodNotificationHandler): () => void {
    if (this.disposed) {
      return () => {}
    }
    return this.handlers.onNotificationByMethod(method, handler)
  }

  onRequest(method: string, handler: RequestHandler): () => void {
    return this.handlers.onRequest(method, handler)
  }

  // Why: the session needs to know when the relay channel dies so it can
  // auto-reconnect. Without this, a relay channel close (e.g. --connect
  // bridge exits) leaves the session in 'ready' state with a dead mux
  // and no recovery path — the SSH connection stays up so onStateChange
  // never fires the reconnect logic.
  onDispose(handler: (reason: 'shutdown' | 'connection_lost') => void): () => void {
    if (this.disposed) {
      return () => {}
    }
    this.disposeHandlers.push(handler)
    return () => {
      const idx = this.disposeHandlers.indexOf(handler)
      if (idx !== -1) {
        this.disposeHandlers.splice(idx, 1)
      }
    }
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async request(
    method: string,
    params?: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<unknown> {
    if (this.disposed) {
      throw new Error('Multiplexer disposed')
    }
    const id = this.nextRequestId++
    return this.requests.request({
      id,
      method,
      params,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs ?? REQUEST_TIMEOUT_MS,
      // Why: cancellation must stop relay-side filesystem/process work rather
      // than only dropping the local promise.
      cancel: (requestId) => this.notify('rpc.cancel', { id: requestId }),
      send: (message) => this.sendMessage(message)
    })
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  notify(method: string, params?: Record<string, unknown>): void {
    if (this.disposed) {
      return
    }

    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    }

    this.sendMessage(msg)
  }

  dispose(reason: 'shutdown' | 'connection_lost' = 'shutdown'): void {
    if (this.disposed) {
      return
    }
    if (process.env.PEBBLE_SSH_MUX_DEBUG === '1') {
      console.warn(
        `[ssh-mux] Disposing multiplexer (reason: ${reason})`,
        new Error('dispose trace').stack
      )
    }
    this.disposed = true

    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer)
      this.timeoutTimer = null
    }

    // Why: the renderer uses the error code to distinguish temporary disconnects
    // (show reconnection overlay) from permanent shutdown (show error toast).
    const errorMessage =
      reason === 'connection_lost' ? 'SSH connection lost, reconnecting...' : 'Multiplexer disposed'
    const errorCode = reason === 'connection_lost' ? 'CONNECTION_LOST' : 'DISPOSED'

    this.requests.rejectAll(errorMessage, errorCode)

    this.unackedTimestamps.clear()
    // Why: relay teardown can race with late provider registration; disposed
    // muxes must not retain provider/session closures through subscribers.
    this.handlers.clear()
    this.decoder.reset()
    this.transport.close?.()

    for (const handler of this.disposeHandlers) {
      try {
        handler(reason)
      } catch {
        // Don't let a handler error prevent other handlers from running
      }
    }
    this.disposeHandlers.length = 0
  }

  isDisposed(): boolean {
    return this.disposed
  }

  // ── Private ───────────────────────────────────────────────────────

  private sendMessage(msg: JsonRpcMessage): void {
    const seq = this.nextOutgoingSeq++
    const frame = encodeJsonRpcFrame(msg, seq, this.highestReceivedSeq)
    this.unackedTimestamps.set(seq, Date.now())
    try {
      this.transport.write(frame)
    } catch (err) {
      // Why: a remote reboot can make the SSH channel's stdin throw EPIPE
      // from a timer/request path. Scope it to this mux instead of letting
      // the Electron main process treat it as an uncaught exception.
      this.handleProtocolError(err)
    }
  }

  private sendKeepAlive(): void {
    if (this.disposed) {
      return
    }
    const seq = this.nextOutgoingSeq++
    const frame = encodeKeepAliveFrame(seq, this.highestReceivedSeq)
    this.unackedTimestamps.set(seq, Date.now())
    try {
      this.transport.write(frame)
    } catch (err) {
      // Why: keepalive runs on an interval; without catching transport
      // write failures here, a dead SSH host can terminate the whole app.
      this.handleProtocolError(err)
    }
  }

  private handleFrame(frame: DecodedFrame): void {
    // Update ack tracking
    if (frame.id > this.highestReceivedSeq) {
      this.highestReceivedSeq = frame.id
    }

    // Process ack from remote: discard timestamps for acked messages
    if (frame.ack > this.highestAckedBySelf) {
      for (let i = this.highestAckedBySelf + 1; i <= frame.ack; i++) {
        this.unackedTimestamps.delete(i)
      }
      this.highestAckedBySelf = frame.ack
    }

    if (frame.type === MessageType.KeepAlive) {
      return
    }

    if (frame.type === MessageType.Regular) {
      try {
        const msg = parseJsonRpcMessage(frame.payload)
        this.handleMessage(msg)
      } catch (err) {
        this.handleProtocolError(err)
      }
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      this.handleResponse(msg as JsonRpcResponse)
    } else if ('id' in msg && 'method' in msg) {
      void this.handleRequest(msg as JsonRpcRequest)
    } else if ('method' in msg && !('id' in msg)) {
      this.handleNotification(msg as JsonRpcNotification)
    }
  }

  private async handleRequest(msg: JsonRpcRequest): Promise<void> {
    const handler = this.handlers.getRequestHandler(msg.method)
    if (!handler) {
      this.sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` }
      })
      return
    }

    try {
      const result = await handler(msg.params ?? {})
      this.sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: result ?? null
      })
    } catch (err) {
      this.sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: (err as { code?: number }).code ?? -32000,
          message: err instanceof Error ? err.message : String(err)
        }
      })
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    this.requests.handleResponse(msg)
  }

  private handleNotification(msg: JsonRpcNotification): void {
    this.handlers.dispatchNotification(msg.method, msg.params ?? {})
  }

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      this.sendKeepAlive()
    }, KEEPALIVE_SEND_MS)
  }

  private startTimeoutCheck(): void {
    this.timeoutTimer = setInterval(() => {
      if (this.disposed) {
        return
      }

      const now = Date.now()
      const noDataReceived = now - this.lastReceivedAt > TIMEOUT_MS

      // Check oldest unacked message
      let oldestUnacked = Infinity
      for (const ts of this.unackedTimestamps.values()) {
        if (ts < oldestUnacked) {
          oldestUnacked = ts
        }
      }
      const oldestUnackedStale = oldestUnacked !== Infinity && now - oldestUnacked > TIMEOUT_MS

      // Connection considered dead when BOTH conditions met
      if (noDataReceived && oldestUnackedStale) {
        this.handleProtocolError(new Error('Connection timed out (no ack received)'))
      }
    }, KEEPALIVE_SEND_MS)
  }

  private handleProtocolError(err: unknown): void {
    console.warn(`[ssh-mux] Protocol error: ${err instanceof Error ? err.message : String(err)}`)
    this.dispose('connection_lost')
  }
}
