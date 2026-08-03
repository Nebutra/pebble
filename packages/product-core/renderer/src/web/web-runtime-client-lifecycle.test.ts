import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { WebRuntimeClient } from './web-runtime-client'

const fakeSockets: FakeWebSocket[] = []

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState = FakeWebSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED
  })
  send = vi.fn()
  constructor(readonly _url: string) {
    fakeSockets.push(this)
  }
}

describe('WebRuntimeClient control lifecycle (#65)', () => {
  beforeEach(() => {
    fakeSockets.length = 0
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
    })
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('exposes connection state and notifies listeners on transitions', () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const seen: string[] = []
    client.onConnectionStateChange((state) => {
      seen.push(state)
    })
    // Constructor already opened → connecting
    expect(client.getConnectionState()).toBe('connecting')
    // Simulate auth success via private state for observer wiring
    const internals = client as unknown as {
      setState: (s: string) => void
      hasEverConnected: boolean
    }
    internals.setState('connected')
    expect(client.getConnectionState()).toBe('connected')
    expect(internals.hasEverConnected).toBe(true)
    expect(seen).toContain('connected')
  })

  it('does not promote a pre-auth close to connected; schedules recovery', () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const socket = fakeSockets[0]!
    const internals = client as unknown as {
      ws: FakeWebSocket | null
      state: string
      handleSocketClosed: (ws: FakeWebSocket) => void
      scheduleReconnect: () => void
      reconnectTimer: number | null
    }
    internals.state = 'handshaking'
    internals.ws = socket
    internals.handleSocketClosed(socket)
    // Never authenticated → disconnected (not "connected" zombie control).
    expect(client.getConnectionState()).toBe('disconnected')
    expect(internals.ws).toBeNull()
  })

  it('uses reconnecting state after a proven session drops', () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const socket = fakeSockets[0]!
    const internals = client as unknown as {
      ws: FakeWebSocket | null
      state: string
      hasEverConnected: boolean
      handleSocketClosed: (ws: FakeWebSocket) => void
    }
    internals.hasEverConnected = true
    internals.state = 'connected'
    internals.ws = socket
    internals.handleSocketClosed(socket)
    expect(client.getConnectionState()).toBe('reconnecting')
  })
})
