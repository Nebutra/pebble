import type { LocalTerminalStream } from './local-terminal-stream'

// Why: terminal input has two transports now — the direct socket, and the app
// bridge it replaces. Both stay live, because a socket that will not connect
// must degrade to working software rather than to a dead terminal.
//
// The hazard is the handover. A bridge write already in flight and a socket
// write issued just after it race, and losing that race swaps two characters on
// screen. So a session only moves to the socket once its last bridge write has
// landed — the runtime has an ordered per-session queue behind each transport,
// but nothing orders the two against each other.

type BridgeWriter = {
  write: (sessionId: string, data: string) => Promise<boolean>
  forget: (sessionId: string) => void
}

type SessionTransport = {
  onSocket: boolean
  lastBridgeWrite: Promise<boolean> | null
}

export type TerminalInputTransport = {
  write: (sessionId: string, data: string) => Promise<boolean>
  forget: (sessionId: string) => void
  dispose: () => void
  /** Which transport a session is on, for diagnostics. */
  transportFor: (sessionId: string) => 'socket' | 'bridge'
  /**
   * How many sessions are on each transport. A socket that connects but never
   * carries a keystroke looks identical from outside the process, so this is
   * the only way to tell the difference without guessing.
   */
  transportCounts: () => { socket: number; bridge: number }
}

export function createTerminalInputTransport(
  socket: LocalTerminalStream,
  bridge: BridgeWriter
): TerminalInputTransport {
  const sessions = new Map<string, SessionTransport>()

  const stateFor = (sessionId: string): SessionTransport => {
    const existing = sessions.get(sessionId)
    if (existing) {
      return existing
    }
    const created: SessionTransport = { onSocket: false, lastBridgeWrite: null }
    sessions.set(sessionId, created)
    return created
  }

  const unsubscribe = socket.onSessionReady((sessionId) => {
    const state = sessions.get(sessionId)
    if (!state || state.onSocket) {
      return
    }
    const pending = state.lastBridgeWrite
    if (!pending) {
      state.onSocket = true
      return
    }
    void pending.then(() => {
      // The session may have been forgotten while the bridge write drained.
      if (sessions.get(sessionId) === state) {
        state.onSocket = true
      }
    })
  })

  const writeThroughBridge = (
    sessionId: string,
    state: SessionTransport,
    data: string
  ): Promise<boolean> => {
    const result = bridge.write(sessionId, data)
    state.lastBridgeWrite = result
    return result
  }

  return {
    write(sessionId, data) {
      const state = stateFor(sessionId)
      if (state.onSocket && socket.tryWrite(sessionId, data)) {
        return Promise.resolve(true)
      }
      // A socket that dropped mid-session returns false here; the bridge takes
      // over and the next ready handshake moves the session back.
      state.onSocket = false
      // Opening is idempotent, so the first write of a session is what arms the
      // socket for every write after it.
      socket.open(sessionId)
      return writeThroughBridge(sessionId, state, data)
    },
    forget(sessionId) {
      sessions.delete(sessionId)
      socket.close(sessionId)
      bridge.forget(sessionId)
    },
    dispose() {
      unsubscribe()
    },
    transportFor(sessionId) {
      return sessions.get(sessionId)?.onSocket === true ? 'socket' : 'bridge'
    },
    transportCounts() {
      let socket = 0
      let bridge = 0
      for (const state of sessions.values()) {
        if (state.onSocket) {
          socket += 1
        } else {
          bridge += 1
        }
      }
      return { socket, bridge }
    }
  }
}
