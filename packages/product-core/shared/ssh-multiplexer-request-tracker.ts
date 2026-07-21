import type { JsonRpcRequest, JsonRpcResponse } from './ssh-relay-protocol'

type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  cleanup: () => void
}

export class SshMultiplexerRequestTracker {
  private readonly pendingRequests = new Map<number, PendingRequest>()

  request(options: {
    id: number
    method: string
    params?: Record<string, unknown>
    signal?: AbortSignal
    timeoutMs: number
    cancel: (id: number) => void
    send: (message: JsonRpcRequest) => void
  }): Promise<unknown> {
    if (options.signal?.aborted) {
      return Promise.reject(createAbortError(options.method))
    }
    const message: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: options.id,
      method: options.method,
      ...(options.params !== undefined ? { params: options.params } : {})
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const cleanup = (): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        const pending = this.pendingRequests.get(options.id)
        if (!pending) {
          return
        }
        pending.cleanup()
        this.pendingRequests.delete(options.id)
        options.cancel(options.id)
        pending.reject(createAbortError(options.method))
      }
      timer = setTimeout(() => {
        const pending = this.pendingRequests.get(options.id)
        if (pending) {
          pending.cleanup()
          options.cancel(options.id)
        }
        this.pendingRequests.delete(options.id)
        reject(new Error(`Request "${options.method}" timed out after ${options.timeoutMs}ms`))
      }, options.timeoutMs)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.pendingRequests.set(options.id, { resolve, reject, timer, cleanup })
      options.send(message)
    })
  }

  handleResponse(message: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(message.id)
    if (!pending) {
      return
    }
    pending.cleanup()
    this.pendingRequests.delete(message.id)
    if (message.error) {
      const error = new Error(message.error.message)
      Object.defineProperty(error, 'code', { value: message.error.code })
      Object.defineProperty(error, 'data', { value: message.error.data })
      pending.reject(error)
      return
    }
    pending.resolve(message.result)
  }

  rejectAll(message: string, code: string): void {
    for (const [id, pending] of this.pendingRequests) {
      pending.cleanup()
      const error = new Error(message) as Error & { code: string }
      error.code = code
      pending.reject(error)
      this.pendingRequests.delete(id)
    }
  }
}

function createAbortError(method: string): Error {
  const error = new Error(`Request "${method}" was cancelled`) as Error & { name: string }
  error.name = 'AbortError'
  return error
}
