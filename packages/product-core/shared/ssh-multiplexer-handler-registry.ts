import type {
  MethodNotificationHandler,
  NotificationHandler,
  RequestHandler
} from './ssh-multiplexer-contracts'

export class SshMultiplexerHandlerRegistry {
  private readonly notificationHandlers: NotificationHandler[] = []
  private readonly methodNotificationHandlers = new Map<string, Set<MethodNotificationHandler>>()
  private readonly requestHandlers = new Map<string, RequestHandler>()

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.push(handler)
    return () => {
      const index = this.notificationHandlers.indexOf(handler)
      if (index !== -1) {
        this.notificationHandlers.splice(index, 1)
      }
    }
  }

  onNotificationByMethod(method: string, handler: MethodNotificationHandler): () => void {
    let handlers = this.methodNotificationHandlers.get(method)
    if (!handlers) {
      handlers = new Set()
      this.methodNotificationHandlers.set(method, handlers)
    }
    handlers.add(handler)
    return () => {
      const current = this.methodNotificationHandlers.get(method)
      if (!current) {
        return
      }
      current.delete(handler)
      if (current.size === 0) {
        this.methodNotificationHandlers.delete(method)
      }
    }
  }

  onRequest(method: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(method, handler)
    return () => {
      if (this.requestHandlers.get(method) === handler) {
        this.requestHandlers.delete(method)
      }
    }
  }

  getRequestHandler(method: string): RequestHandler | undefined {
    return this.requestHandlers.get(method)
  }

  dispatchNotification(method: string, params: Record<string, unknown>): void {
    // Why: subscribers can remove themselves while handling a frame; snapshots
    // keep the next subscriber from being skipped by collection mutation.
    for (const handler of Array.from(this.notificationHandlers)) {
      invokeNotificationHandler(() => handler(method, params), method, false)
    }
    for (const handler of Array.from(this.methodNotificationHandlers.get(method) ?? [])) {
      invokeNotificationHandler(() => handler(params), method, true)
    }
  }

  clear(): void {
    this.notificationHandlers.length = 0
    this.methodNotificationHandlers.clear()
    this.requestHandlers.clear()
  }
}

function invokeNotificationHandler(
  invoke: () => void,
  method: string,
  methodSpecific: boolean
): void {
  try {
    invoke()
  } catch (error) {
    const kind = methodSpecific ? 'Method notification' : 'Notification'
    console.warn(
      `[ssh-mux] ${kind} handler failed for ${method}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}
