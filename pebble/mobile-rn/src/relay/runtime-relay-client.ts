import {
  RelayCryptoHandshakeState,
  RelayCryptoProvider,
  RelayCryptoSession,
} from './relay-crypto'
import { createRuntimeRandomId } from './runtime-random-id'
import {
  DeviceIdentity,
  MOBILE_RELAY_PATH,
  MOBILE_RELAY_PROTOCOL_VERSION,
  MobileRelayClientMessage,
  MobileRelayServerMessage,
  PairingRequest,
  ProjectionKind,
  RelayCryptoEnvelope,
  RelayCryptoHandshake,
  RUNTIME_API_VERSION,
  RUNTIME_EVENT_VERSION,
} from './relay-protocol'

export type RuntimeConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'

export interface RuntimeConnectionState {
  phase: RuntimeConnectionPhase
  attempts: number
  endpoint?: string
  lastConnectedAt?: string
  lastDisconnectedAt?: string
  errorMessage?: string
}

export interface RuntimeRelayReconnectPolicy {
  enabled: boolean
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export interface RuntimeRelayClientOptions {
  endpoint: string
  device: DeviceIdentity
  relayId?: string
  pairingSecretRef?: string
  subscriptions?: ProjectionKind[]
  cryptoProvider?: RelayCryptoProvider
  reconnect?: Partial<RuntimeRelayReconnectPolicy>
}

export type RuntimeConnectionListener = (state: RuntimeConnectionState) => void
export type RuntimeMessageListener = (message: MobileRelayServerMessage) => void
type RuntimeRelayConnectionMode = 'paired' | 'pairing'

const defaultSubscriptions: ProjectionKind[] = [
  'terminal',
  'agents',
  'source-control',
  'browser',
  'files',
  'orchestration',
  'automations',
  'external-tasks',
  'releases',
  'providers',
  'computer',
  'emulator',
  'settings',
]

const defaultReconnectPolicy: RuntimeRelayReconnectPolicy = {
  enabled: true,
  maxAttempts: 10,
  baseDelayMs: 750,
  maxDelayMs: 8000,
}

const heartbeatIntervalMs = 30000

export class RuntimeRelayClient {
  private socket: WebSocket | null = null
  private options: RuntimeRelayClientOptions | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private pendingCryptoHandshake: RelayCryptoHandshakeState | null = null
  private cryptoSession: RelayCryptoSession | null = null
  private connectionMode: RuntimeRelayConnectionMode = 'paired'
  private intentionalDisconnect = false
  private queuedMessages: MobileRelayClientMessage[] = []
  private statusListeners = new Set<RuntimeConnectionListener>()
  private messageListeners = new Set<RuntimeMessageListener>()
  private status: RuntimeConnectionState = {
    phase: 'idle',
    attempts: 0,
  }

  connect(options: RuntimeRelayClientOptions): void {
    this.connectWithMode(options, 'paired')
  }

  private connectWithMode(options: RuntimeRelayClientOptions, mode: RuntimeRelayConnectionMode): void {
    const trimmedPairingSecretRef = options.pairingSecretRef?.trim()
    const pairingSecretRef =
      trimmedPairingSecretRef === '' ? undefined : trimmedPairingSecretRef
    if (mode === 'paired' && pairingSecretRef === undefined) {
      this.failWithoutReconnect(
        'Pairing secret missing. Pair this device again.',
        options.endpoint,
      )
      return
    }

    this.connectionMode = mode
    this.options = {
      ...options,
      pairingSecretRef,
      subscriptions: options.subscriptions ?? defaultSubscriptions,
    }
    this.intentionalDisconnect = false
    this.pendingCryptoHandshake = null
    this.cryptoSession = null
    this.clearReconnectTimer()
    this.closeActiveSocket()
    this.openSocket('connecting')
  }

  beginPairing(request: PairingRequest, device: DeviceIdentity): void {
    this.connectWithMode(
      {
        endpoint: request.endpoint,
        device,
        subscriptions: defaultSubscriptions,
        reconnect: {
          enabled: false,
        },
      },
      'pairing',
    )

    this.enqueueOrSend({
      version: MOBILE_RELAY_PROTOCOL_VERSION,
      id: createClientMessageId('pair'),
      type: 'pair.start',
      payload: {
        ...request,
        device,
      },
    })
  }

  disconnect(): void {
    this.intentionalDisconnect = true
    this.clearReconnectTimer()
    this.clearHeartbeatTimer()
    this.pendingCryptoHandshake = null
    this.cryptoSession = null
    this.queuedMessages = []

    if (this.socket !== null) {
      this.socket.close()
      this.socket = null
    }

    this.setStatus({
      phase: 'disconnected',
      attempts: 0,
      endpoint: this.status.endpoint,
      lastConnectedAt: this.status.lastConnectedAt,
      lastDisconnectedAt: new Date().toISOString(),
    })
  }

  onStatusChange(listener: RuntimeConnectionListener): () => void {
    this.statusListeners.add(listener)
    listener(this.status)

    return () => {
      this.statusListeners.delete(listener)
    }
  }

  onMessage(listener: RuntimeMessageListener): () => void {
    this.messageListeners.add(listener)

    return () => {
      this.messageListeners.delete(listener)
    }
  }

  subscribe(projections: ProjectionKind[]): void {
    this.enqueueOrSend({
      version: MOBILE_RELAY_PROTOCOL_VERSION,
      id: createClientMessageId('sub'),
      type: 'projection.subscribe',
      payload: {
        projections,
      },
    })
  }

  sendCryptoHandshake(payload: RelayCryptoHandshake): void {
    this.enqueueOrSend({
      version: MOBILE_RELAY_PROTOCOL_VERSION,
      id: createClientMessageId('crypto'),
      type: 'crypto.handshake',
      payload,
    })
  }

  sendEncryptedEnvelope(envelope: RelayCryptoEnvelope): void {
    this.enqueueOrSend({
      version: MOBILE_RELAY_PROTOCOL_VERSION,
      id: createClientMessageId('sealed'),
      type: 'encrypted',
      payload: envelope,
    })
  }

  sendTerminalInput(sessionId: string, data: string): void {
    this.enqueueOrSend({
      version: MOBILE_RELAY_PROTOCOL_VERSION,
      id: createClientMessageId('term'),
      type: 'terminal.input',
      payload: {
        sessionId,
        data,
      },
    })
  }

  sendBrowserCommand(
    tabId: string,
    command: 'reload' | 'goBack' | 'goForward' | 'stop' | 'screenshot'
  ): void {
    this.enqueueOrSend({
      version: MOBILE_RELAY_PROTOCOL_VERSION,
      id: createClientMessageId('browser'),
      type: 'browser.command',
      payload: {
        tabId,
        command,
      },
    })
  }

  sendFileRead(projectId: string, worktreeId: string | undefined, path: string, maxBytes?: number): string {
    const id = createClientMessageId('file-read')

    this.enqueueOrSend({
      version: MOBILE_RELAY_PROTOCOL_VERSION,
      id,
      type: 'file.read',
      payload: {
        projectId,
        worktreeId,
        path,
        maxBytes,
      },
    })

    return id
  }

  sendFileWrite(
    projectId: string,
    worktreeId: string | undefined,
    path: string,
    content: string,
    createDirs = true,
  ): string {
    const id = createClientMessageId('file-write')

    this.enqueueOrSend({
      version: MOBILE_RELAY_PROTOCOL_VERSION,
      id,
      type: 'file.write',
      payload: {
        projectId,
        worktreeId,
        path,
        content,
        createDirs,
      },
    })

    return id
  }

  private openSocket(phase: RuntimeConnectionPhase): void {
    if (this.options === null) {
      return
    }

    try {
      const endpoint = resolveRelayWebSocketUrl(this.options.endpoint)
      this.setStatus({
        phase,
        attempts: this.status.attempts,
        endpoint,
        lastConnectedAt: this.status.lastConnectedAt,
        errorMessage: undefined,
      })

      const socket = new WebSocket(endpoint)
      this.socket = socket

      socket.onopen = () => {
        if (this.socket !== socket) {
          return
        }

        void this.handleOpen(endpoint)
      }

      socket.onmessage = (event) => {
        if (this.socket !== socket) {
          return
        }

        void this.handleMessage(event.data)
      }

      socket.onerror = (event) => {
        if (this.socket !== socket) {
          return
        }

        this.setStatus({
          ...this.status,
          errorMessage: extractErrorMessage(event),
        })
      }

      socket.onclose = (event) => {
        if (this.socket !== socket) {
          return
        }

        this.socket = null
        this.handleClose(extractCloseMessage(event))
      }
    } catch (error) {
      this.socket = null
      this.handleClose(extractErrorMessage(error))
    }
  }

  private async handleOpen(endpoint: string): Promise<void> {
    if (this.options === null) {
      return
    }

    this.setStatus({
      phase: 'connected',
      attempts: 0,
      endpoint,
      lastConnectedAt: new Date().toISOString(),
    })

    const subscriptions = this.options.subscriptions ?? defaultSubscriptions
    const cryptoProvider = this.options.cryptoProvider
    const pairingSecretRef = this.options.pairingSecretRef

    if (this.connectionMode === 'pairing') {
      this.flushQueue()
      return
    }

    if (pairingSecretRef === undefined) {
      this.failWithoutReconnect('Pairing secret missing. Pair this device again.', endpoint)
      return
    }

    if (cryptoProvider !== undefined && pairingSecretRef !== undefined) {
      try {
        this.pendingCryptoHandshake = await cryptoProvider.createHandshake({
          device: this.options.device,
          relayId: this.options.relayId,
          pairingSecretRef,
          subscriptions,
        })
        this.sendSocketMessage({
          version: MOBILE_RELAY_PROTOCOL_VERSION,
          id: createClientMessageId('crypto'),
          type: 'crypto.handshake',
          payload: this.pendingCryptoHandshake.payload,
        })
      } catch (error) {
        this.failWithoutReconnect(extractErrorMessage(error), endpoint)
      }
      return
    }

    this.enqueueOrSend({
      version: MOBILE_RELAY_PROTOCOL_VERSION,
      id: createClientMessageId('hello'),
      type: 'client.hello',
      payload: {
        device: this.options.device,
        runtimeApiVersion: RUNTIME_API_VERSION,
        runtimeEventVersion: RUNTIME_EVENT_VERSION,
        subscriptions,
        pairingSecretRef,
      },
    })

    this.flushQueue()
    this.startHeartbeat()
  }

  private async handleMessage(rawMessage: unknown): Promise<void> {
    const message = parseServerMessage(rawMessage)

    if (message === null) {
      return
    }

    if (message.type === 'crypto.ready') {
      if (this.pendingCryptoHandshake === null) {
        this.dispatchMessage({
          version: MOBILE_RELAY_PROTOCOL_VERSION,
          id: createClientMessageId('crypto-error'),
          type: 'error',
          payload: {
            code: 'crypto_unexpected_ready',
            message: 'Relay sent crypto.ready without a pending handshake',
          },
        })
        return
      }

      try {
        this.cryptoSession = await this.pendingCryptoHandshake.complete(message.payload)
        this.pendingCryptoHandshake = null
        this.dispatchMessage(message)
        this.flushQueue()
        this.startHeartbeat()
      } catch (error) {
        this.dispatchMessage({
          version: MOBILE_RELAY_PROTOCOL_VERSION,
          id: createClientMessageId('crypto-error'),
          type: 'error',
          payload: {
            code: 'crypto_failed',
            message: extractErrorMessage(error),
          },
        })
      }
      return
    }

    if (message.type === 'encrypted') {
      if (this.cryptoSession === null) {
        this.dispatchMessage({
          version: MOBILE_RELAY_PROTOCOL_VERSION,
          id: createClientMessageId('crypto-error'),
          type: 'error',
          payload: {
            code: 'crypto_missing_session',
            message: 'Relay sent encrypted data before a crypto session was ready',
          },
        })
        return
      }

      try {
        this.dispatchMessage(await this.cryptoSession.decryptMessage(message.payload))
      } catch (error) {
        this.dispatchMessage({
          version: MOBILE_RELAY_PROTOCOL_VERSION,
          id: createClientMessageId('crypto-error'),
          type: 'error',
          payload: {
            code: 'crypto_decrypt_failed',
            message: extractErrorMessage(error),
          },
        })
      }
      return
    }

    this.dispatchMessage(message)
  }

  private dispatchMessage(message: MobileRelayServerMessage): void {
    for (const listener of this.messageListeners) {
      listener(message)
    }
  }

  private handleClose(errorMessage?: string): void {
    this.clearHeartbeatTimer()

    if (this.intentionalDisconnect) {
      this.setStatus({
        phase: 'disconnected',
        attempts: 0,
        endpoint: this.status.endpoint,
        lastConnectedAt: this.status.lastConnectedAt,
        lastDisconnectedAt: new Date().toISOString(),
      })
      return
    }

    this.scheduleReconnect(errorMessage)
  }

  private scheduleReconnect(errorMessage?: string): void {
    const reconnectPolicy = this.getReconnectPolicy()

    if (!reconnectPolicy.enabled || this.status.attempts >= reconnectPolicy.maxAttempts) {
      this.setStatus({
        phase: 'failed',
        attempts: this.status.attempts,
        endpoint: this.status.endpoint,
        lastConnectedAt: this.status.lastConnectedAt,
        lastDisconnectedAt: new Date().toISOString(),
        errorMessage,
      })
      return
    }

    const attempts = this.status.attempts + 1
    const delayMs = Math.min(
      reconnectPolicy.maxDelayMs,
      reconnectPolicy.baseDelayMs * 2 ** Math.max(0, attempts - 1),
    )

    this.setStatus({
      phase: 'reconnecting',
      attempts,
      endpoint: this.status.endpoint,
      lastConnectedAt: this.status.lastConnectedAt,
      lastDisconnectedAt: new Date().toISOString(),
      errorMessage,
    })

    this.reconnectTimer = setTimeout(() => {
      this.openSocket('reconnecting')
    }, delayMs)
  }

  private failWithoutReconnect(errorMessage: string, endpoint?: string): void {
    this.intentionalDisconnect = true
    this.clearReconnectTimer()
    this.clearHeartbeatTimer()
    this.closeActiveSocket()
    this.options = null
    this.queuedMessages = []
    this.setStatus({
      phase: 'failed',
      attempts: 0,
      endpoint,
      lastConnectedAt: this.status.lastConnectedAt,
      lastDisconnectedAt: new Date().toISOString(),
      errorMessage,
    })
  }

  private getReconnectPolicy(): RuntimeRelayReconnectPolicy {
    return {
      ...defaultReconnectPolicy,
      ...this.options?.reconnect,
    }
  }

  private enqueueOrSend(message: MobileRelayClientMessage): void {
    if (
      this.socket?.readyState === WebSocket.OPEN &&
      !this.shouldQueueUntilCryptoReady(message)
    ) {
      this.sendSocketMessage(message)
      return
    }

    this.queuedMessages.push(message)
  }

  private shouldQueueUntilCryptoReady(message: MobileRelayClientMessage): boolean {
    return (
      this.pendingCryptoHandshake !== null &&
      this.cryptoSession === null &&
      message.type !== 'crypto.handshake' &&
      message.type !== 'encrypted'
    )
  }

  private sendSocketMessage(message: MobileRelayClientMessage): void {
    if (this.cryptoSession !== null && shouldEncryptClientMessage(message)) {
      void this.cryptoSession
        .encryptMessage(message)
        .then((envelope) => {
          this.socket?.send(
            JSON.stringify({
              version: MOBILE_RELAY_PROTOCOL_VERSION,
              id: createClientMessageId('sealed'),
              type: 'encrypted',
              payload: envelope,
            }),
          )
        })
        .catch((error) => {
          this.dispatchMessage({
            version: MOBILE_RELAY_PROTOCOL_VERSION,
            id: createClientMessageId('crypto-error'),
            type: 'error',
            payload: {
              code: 'crypto_encrypt_failed',
              message: extractErrorMessage(error),
            },
          })
        })
      return
    }

    this.socket?.send(JSON.stringify(message))
  }

  private flushQueue(): void {
    const pending = [...this.queuedMessages]
    this.queuedMessages = []

    for (const message of pending) {
      this.enqueueOrSend(message)
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimer()
    this.heartbeatTimer = setInterval(() => {
      this.enqueueOrSend({
        version: MOBILE_RELAY_PROTOCOL_VERSION,
        id: createClientMessageId('beat'),
        type: 'heartbeat',
        payload: {
          sentAt: new Date().toISOString(),
        },
      })
    }, heartbeatIntervalMs)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) {
      return
    }

    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer === null) {
      return
    }

    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private closeActiveSocket(): void {
    if (this.socket === null) {
      return
    }

    const socket = this.socket
    this.socket = null
    socket.close()
    this.clearHeartbeatTimer()
    this.pendingCryptoHandshake = null
    this.cryptoSession = null
  }

  private setStatus(nextStatus: RuntimeConnectionState): void {
    this.status = nextStatus

    for (const listener of this.statusListeners) {
      listener(nextStatus)
    }
  }
}

export function resolveRelayWebSocketUrl(endpoint: string): string {
  const trimmedEndpoint = endpoint.trim()

  if (trimmedEndpoint.startsWith('ws://') || trimmedEndpoint.startsWith('wss://')) {
    return ensureRelayPath(trimmedEndpoint)
  }

  const url = new URL(trimmedEndpoint.includes('://') ? trimmedEndpoint : `http://${trimmedEndpoint}`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

  return ensureRelayPath(url.toString())
}

function ensureRelayPath(endpoint: string): string {
  const url = new URL(endpoint)

  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = MOBILE_RELAY_PATH
  }

  return url.toString()
}

function createClientMessageId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${createRuntimeRandomId()}`
}

function parseServerMessage(rawMessage: unknown): MobileRelayServerMessage | null {
  try {
    const parsed =
      typeof rawMessage === 'string' ? (JSON.parse(rawMessage) as unknown) : rawMessage

    if (!isRecord(parsed)) {
      return null
    }

    if (parsed.version !== MOBILE_RELAY_PROTOCOL_VERSION || typeof parsed.type !== 'string') {
      return null
    }

    return parsed as MobileRelayServerMessage
  } catch {
    return null
  }
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (isRecord(error) && typeof error.message === 'string') {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  return 'Relay connection failed'
}

function extractCloseMessage(event: CloseEvent): string | undefined {
  if (event.reason.length > 0) {
    return event.reason
  }

  if (event.code !== 1000) {
    return `Relay connection closed with code ${event.code}`
  }

  return undefined
}

function shouldEncryptClientMessage(message: MobileRelayClientMessage): boolean {
  return (
    message.type !== 'crypto.handshake' &&
    message.type !== 'encrypted' &&
    message.type !== 'pair.start'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
