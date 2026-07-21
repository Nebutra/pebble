export type BrowserScreencastForwarder = {
  offer: (frame: Uint8Array) => void
  stop: () => Promise<void>
  failed: Promise<Error>
}

export function createLatestBrowserScreencastForwarder(
  send: (frame: Uint8Array) => Promise<void>
): BrowserScreencastForwarder {
  let active: Promise<void> | null = null
  let pending: Uint8Array | null = null
  let stopped = false
  let failure: Error | null = null
  let rejectFailure!: (error: Error) => void
  const failed = new Promise<Error>((_resolve, reject) => {
    rejectFailure = reject
  }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))

  const pump = (): void => {
    if (active || stopped || failure || !pending) {
      return
    }
    const frame = pending
    pending = null
    active = send(frame)
      .catch((error: unknown) => {
        failure = error instanceof Error ? error : new Error(String(error))
        pending = null
        rejectFailure(failure)
      })
      .finally(() => {
        active = null
        pump()
      })
  }

  return {
    offer: (frame) => {
      if (stopped || failure) {
        return
      }
      // Why: native capture must not inherit HTTP latency; one replaceable slot
      // preserves the freshest visual state without an unbounded frame queue.
      pending = frame
      pump()
    },
    stop: async () => {
      stopped = true
      pending = null
      await active?.catch(() => undefined)
    },
    failed
  }
}
