import { describe, expect, it, vi } from 'vitest'
import type { LocalTerminalStream } from './local-terminal-stream'
import { createTerminalInputTransport } from './terminal-input-transport'

type FakeSocket = LocalTerminalStream & {
  readySessions: Set<string>
  written: string[]
  emitReady: (sessionId: string) => void
}

function createFakeSocket(options: { acceptWrites?: boolean } = {}): FakeSocket {
  const acceptWrites = options.acceptWrites ?? true
  const listeners = new Set<(sessionId: string) => void>()
  const readySessions = new Set<string>()
  const written: string[] = []
  return {
    readySessions,
    written,
    emitReady(sessionId) {
      readySessions.add(sessionId)
      for (const listener of listeners) {
        listener(sessionId)
      }
    },
    start: () => undefined,
    stop: () => undefined,
    open: () => undefined,
    close: (sessionId) => readySessions.delete(sessionId),
    tryWrite: (sessionId, data) => {
      if (!acceptWrites || !readySessions.has(sessionId)) {
        return false
      }
      written.push(data)
      return true
    },
    isReady: (sessionId) => readySessions.has(sessionId),
    onSessionReady: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

describe('createTerminalInputTransport', () => {
  it('writes through the bridge until the socket stream is open', async () => {
    const socket = createFakeSocket()
    const bridge = { write: vi.fn().mockResolvedValue(true), forget: vi.fn() }
    const transport = createTerminalInputTransport(socket, bridge)

    await transport.write('sess-1', 'a')

    expect(bridge.write).toHaveBeenCalledWith('sess-1', 'a')
    expect(socket.written).toEqual([])
    expect(transport.transportFor('sess-1')).toBe('bridge')
  })

  it('moves a session to the socket once its stream is open', async () => {
    const socket = createFakeSocket()
    const bridge = { write: vi.fn().mockResolvedValue(true), forget: vi.fn() }
    const transport = createTerminalInputTransport(socket, bridge)

    await transport.write('sess-1', 'a')
    socket.emitReady('sess-1')
    await Promise.resolve()
    await transport.write('sess-1', 'b')

    expect(socket.written).toEqual(['b'])
    expect(bridge.write).toHaveBeenCalledTimes(1)
    expect(transport.transportFor('sess-1')).toBe('socket')
  })

  it('does not move to the socket while a bridge write is still in flight', async () => {
    // Why: the two transports have no shared ordering, so overlapping them is
    // what would swap two characters on screen.
    const socket = createFakeSocket()
    let settleBridgeWrite: (accepted: boolean) => void = () => undefined
    const pending = new Promise<boolean>((resolve) => {
      settleBridgeWrite = resolve
    })
    const bridge = { write: vi.fn().mockReturnValue(pending), forget: vi.fn() }
    const transport = createTerminalInputTransport(socket, bridge)

    void transport.write('sess-1', 'a')
    socket.emitReady('sess-1')
    await Promise.resolve()

    expect(transport.transportFor('sess-1')).toBe('bridge')

    settleBridgeWrite(true)
    await pending
    await Promise.resolve()

    expect(transport.transportFor('sess-1')).toBe('socket')
  })

  it('falls back to the bridge when the socket refuses a write', async () => {
    const socket = createFakeSocket({ acceptWrites: false })
    const bridge = { write: vi.fn().mockResolvedValue(true), forget: vi.fn() }
    const transport = createTerminalInputTransport(socket, bridge)

    socket.emitReady('sess-1')
    await transport.write('sess-1', 'a')

    expect(bridge.write).toHaveBeenCalledWith('sess-1', 'a')
    expect(transport.transportFor('sess-1')).toBe('bridge')
  })

  it('keeps a forgotten session off the socket even if its write settles later', async () => {
    const socket = createFakeSocket()
    let settleBridgeWrite: (accepted: boolean) => void = () => undefined
    const pending = new Promise<boolean>((resolve) => {
      settleBridgeWrite = resolve
    })
    const bridge = { write: vi.fn().mockReturnValue(pending), forget: vi.fn() }
    const transport = createTerminalInputTransport(socket, bridge)

    void transport.write('sess-1', 'a')
    socket.emitReady('sess-1')
    transport.forget('sess-1')
    settleBridgeWrite(true)
    await pending
    await Promise.resolve()

    expect(transport.transportFor('sess-1')).toBe('bridge')
    expect(bridge.forget).toHaveBeenCalledWith('sess-1')
  })
})
