type InputSender = (sessionId: string, data: string) => Promise<boolean>

type PendingWrite = {
  data: string
  resolve: (accepted: boolean) => void
}

type SessionQueue = {
  pending: PendingWrite[]
  flushScheduled: boolean
}

const IMMEDIATE_INPUT_BYTES = 64

export function createRuntimePtyInputBatcher(sender: InputSender): {
  write: (sessionId: string, data: string) => Promise<boolean>
  forget: (sessionId: string) => void
} {
  const queues = new Map<string, SessionQueue>()

  const getQueue = (sessionId: string): SessionQueue => {
    const existing = queues.get(sessionId)
    if (existing) {
      return existing
    }
    const created: SessionQueue = { pending: [], flushScheduled: false }
    queues.set(sessionId, created)
    return created
  }

  const flush = (sessionId: string, queue: SessionQueue): void => {
    queue.flushScheduled = false
    if (queue.pending.length === 0) {
      return
    }

    const writes = queue.pending.splice(0)
    const data = writes.map((write) => write.data).join('')
    // Why: Rust owns the ordered per-session queue. Waiting for each invoke reply
    // here duplicates that queue and turns bridge jitter into visible typing lag.
    void (async () => {
      const accepted = await sender(sessionId, data).catch(() => false)
      writes.forEach((write) => write.resolve(accepted))
    })()
  }

  return {
    write(sessionId, data) {
      const queue = getQueue(sessionId)
      const result = new Promise<boolean>((resolve) => queue.pending.push({ data, resolve }))
      if (shouldFlushImmediately(data)) {
        flush(sessionId, queue)
      } else if (!queue.flushScheduled) {
        // Why: a timer adds visible latency to every key. A microtask still
        // coalesces paste bursts emitted in one turn without delaying typing.
        queue.flushScheduled = true
        queueMicrotask(() => flush(sessionId, queue))
      }
      return result
    },
    forget(sessionId) {
      const queue = queues.get(sessionId)
      if (!queue) {
        return
      }
      flush(sessionId, queue)
      queues.delete(sessionId)
    }
  }
}

function shouldFlushImmediately(data: string): boolean {
  if (data.length >= IMMEDIATE_INPUT_BYTES) {
    return true
  }
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index)
    if (code < 32 || code === 127) {
      return true
    }
  }
  return false
}
