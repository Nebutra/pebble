export type MultiplexerTransport = {
  write: (data: Buffer) => void
  onData: (callback: (data: Buffer) => void) => void
  onClose: (callback: () => void) => void
  close?: () => void
}

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void
export type MethodNotificationHandler = (params: Record<string, unknown>) => void
export type RequestHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown
