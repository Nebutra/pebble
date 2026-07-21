import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'
import { encodeFrame, encodeKeepAliveFrame, HEADER_LENGTH, MessageType } from './ssh-relay-protocol'

function createMockTransport(): MultiplexerTransport & {
  dataCallbacks: ((data: Buffer) => void)[]
  closeCallbacks: (() => void)[]
  written: Buffer[]
} {
  const dataCallbacks: ((data: Buffer) => void)[] = []
  const closeCallbacks: (() => void)[] = []
  const written: Buffer[] = []

  return {
    write: (data: Buffer) => written.push(data),
    onData: (cb) => dataCallbacks.push(cb),
    onClose: (cb) => closeCallbacks.push(cb),
    dataCallbacks,
    closeCallbacks,
    written
  }
}

function makeResponseFrame(requestId: number, result: unknown, seq: number): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      result
    })
  )
  return encodeFrame(MessageType.Regular, seq, 0, payload)
}

function makeErrorResponseFrame(
  requestId: number,
  code: number,
  message: string,
  seq: number
): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      error: { code, message }
    })
  )
  return encodeFrame(MessageType.Regular, seq, 0, payload)
}

describe('SshChannelMultiplexer', () => {
  let transport: ReturnType<typeof createMockTransport>
  let mux: SshChannelMultiplexer

  beforeEach(() => {
    vi.useFakeTimers()
    transport = createMockTransport()
    mux = new SshChannelMultiplexer(transport)
  })

  afterEach(() => {
    mux.dispose()
    vi.useRealTimers()
  })

  describe('request/response', () => {
    it('sends a JSON-RPC request and resolves on response', async () => {
      const promise = mux.request('pty.spawn', { cols: 80, rows: 24 })

      // Verify the request was written
      expect(transport.written.length).toBe(1)
      const frame = transport.written[0]
      expect(frame[0]).toBe(MessageType.Regular)

      const payloadLen = frame.readUInt32BE(9)
      const payload = JSON.parse(
        frame.subarray(HEADER_LENGTH, HEADER_LENGTH + payloadLen).toString()
      )
      expect(payload.method).toBe('pty.spawn')
      expect(payload.id).toBe(1)

      // Simulate response from relay
      const response = makeResponseFrame(1, { id: 'pty-1' }, 1)
      transport.dataCallbacks[0](response)

      const result = await promise
      expect(result).toEqual({ id: 'pty-1' })
    })

    it('rejects on error response', async () => {
      const promise = mux.request('pty.spawn', { cols: 80, rows: 24 })

      const response = makeErrorResponseFrame(1, -33004, 'PTY allocation failed', 1)
      transport.dataCallbacks[0](response)

      await expect(promise).rejects.toThrow('PTY allocation failed')
    })

    it('times out after 30s with no response', async () => {
      const promise = mux.request('pty.spawn')

      // Feed keepalive frames periodically to prevent the connection-level
      // timeout (20s no-data) from firing before the 30s request timeout.
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(5_000)
        transport.dataCallbacks[0](encodeKeepAliveFrame(i + 1, 0))
      }
      vi.advanceTimersByTime(1_000)

      await expect(promise).rejects.toThrow('timed out')
      const cancelPayload = JSON.parse(
        transport.written
          .at(-1)!
          .subarray(HEADER_LENGTH, HEADER_LENGTH + transport.written.at(-1)!.readUInt32BE(9))
          .toString()
      )
      expect(cancelPayload).toMatchObject({
        method: 'rpc.cancel',
        params: { id: 1 }
      })
    })

    it('uses per-request timeout overrides', async () => {
      const promise = mux.request('fs.workspaceSpaceScan', {}, { timeoutMs: 60_000 })

      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(5_000)
        transport.dataCallbacks[0](encodeKeepAliveFrame(i + 1, 0))
      }
      await Promise.resolve()
      const requestWrites = transport.written.filter((frame) => frame[0] === MessageType.Regular)
      expect(requestWrites).toHaveLength(1)

      for (let i = 6; i < 12; i++) {
        vi.advanceTimersByTime(5_000)
        transport.dataCallbacks[0](encodeKeepAliveFrame(i + 1, 0))
      }
      await expect(promise).rejects.toThrow('timed out after 60000ms')
    })

    it('assigns unique request IDs', async () => {
      void mux.request('method1').catch(() => {})
      void mux.request('method2').catch(() => {})

      expect(transport.written.length).toBe(2)
      const id1 = JSON.parse(
        transport.written[0]
          .subarray(HEADER_LENGTH, HEADER_LENGTH + transport.written[0].readUInt32BE(9))
          .toString()
      ).id
      const id2 = JSON.parse(
        transport.written[1]
          .subarray(HEADER_LENGTH, HEADER_LENGTH + transport.written[1].readUInt32BE(9))
          .toString()
      ).id
      expect(id1).not.toBe(id2)
    })
  })
})
