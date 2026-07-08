import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  DeviceIdentity,
  FileProjection,
  PairingRecord,
  PairingRequest,
  ProjectionKind,
} from '@/relay/relay-protocol'
import { createRuntimeRelayCryptoProvider } from '@/relay/runtime-relay-crypto-provider'
import {
  RuntimeConnectionState,
  RuntimeRelayClient,
} from '@/relay/runtime-relay-client'
import {
  applyRelayServerMessage,
  createEmptyProjectionState,
  RuntimeProjectionState,
} from '@/state/projection-state'

export interface RuntimeSessionOptions {
  pairingRecord: PairingRecord | null
  device: DeviceIdentity | null
  onPairingAccepted: (record: PairingRecord) => void
  onPairingRejected: (reason: string) => void
  onConnected: () => void
}

export interface RuntimeSessionController {
  connection: RuntimeConnectionState
  projection: RuntimeProjectionState
  beginPairing: (request: PairingRequest) => void
  disconnect: () => void
  reconnect: () => void
  subscribe: (projections: ProjectionKind[]) => void
  sendTerminalInput: (sessionId: string, data: string) => void
  sendBrowserCommand: (
    tabId: string,
    command: 'reload' | 'goBack' | 'goForward' | 'stop' | 'screenshot',
  ) => void
  readFile: (file: FileProjection) => void
  writeFile: (file: FileProjection, content: string) => void
}

const initialConnectionState: RuntimeConnectionState = {
  phase: 'idle',
  attempts: 0,
}

export function useRuntimeSession(options: RuntimeSessionOptions): RuntimeSessionController {
  const client = useMemo(() => new RuntimeRelayClient(), [])
  const cryptoProvider = useMemo(createRuntimeRelayCryptoProvider, [])
  const [connection, setConnection] = useState<RuntimeConnectionState>(initialConnectionState)
  const [projection, setProjection] = useState<RuntimeProjectionState>(createEmptyProjectionState)
  const optionsRef = useRef(options)
  const deviceRef = useRef(options.device)
  const pendingPairingEndpointRef = useRef<string | null>(null)

  useEffect(() => {
    optionsRef.current = options
    deviceRef.current = options.device
  }, [options])

  useEffect(() => {
    const stopStatusListener = client.onStatusChange((nextConnection) => {
      setConnection(nextConnection)

      if (nextConnection.phase === 'connected') {
        optionsRef.current.onConnected()
      }
    })

    const stopMessageListener = client.onMessage((message) => {
      if (message.type === 'pair.accepted') {
        const device = deviceRef.current
        const endpoint = message.payload.endpoint ?? pendingPairingEndpointRef.current

        if (device !== null && endpoint !== null) {
          optionsRef.current.onPairingAccepted({
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            endpoint,
            relayId: message.payload.relayId,
            workspaceName: message.payload.workspaceName,
            pairingSecretRef: message.payload.pairingSecretRef,
            createdAt: new Date().toISOString(),
            lastConnectedAt: new Date().toISOString(),
          })
        }
      }

      if (message.type === 'pair.rejected') {
        optionsRef.current.onPairingRejected(message.payload.reason)
      }

      setProjection((currentProjection) =>
        applyRelayServerMessage(currentProjection, message),
      )
    })

    return () => {
      stopStatusListener()
      stopMessageListener()
      client.disconnect()
    }
  }, [client])

  useEffect(() => {
    const pairingRecord = options.pairingRecord
    const device = options.device

    if (pairingRecord === null || device === null) {
      client.disconnect()
      setProjection(createEmptyProjectionState())
      return
    }

    client.connect({
      endpoint: pairingRecord.endpoint,
      device,
      relayId: pairingRecord.relayId,
      pairingSecretRef: pairingRecord.pairingSecretRef,
      cryptoProvider,
    })
  }, [
    client,
    cryptoProvider,
    options.device,
    options.pairingRecord,
  ])

  const beginPairing = useCallback(
    (request: PairingRequest) => {
      if (deviceRef.current === null) {
        optionsRef.current.onPairingRejected('Device identity is not ready')
        return
      }

      pendingPairingEndpointRef.current = request.endpoint
      client.beginPairing(request, deviceRef.current)
    },
    [client],
  )

  const disconnect = useCallback(() => {
    client.disconnect()
  }, [client])

  const reconnect = useCallback(() => {
    const pairingRecord = optionsRef.current.pairingRecord
    const device = optionsRef.current.device

    if (pairingRecord === null || device === null) {
      return
    }

    client.connect({
      endpoint: pairingRecord.endpoint,
      device,
      relayId: pairingRecord.relayId,
      pairingSecretRef: pairingRecord.pairingSecretRef,
      cryptoProvider,
    })
  }, [client, cryptoProvider])

  const subscribe = useCallback(
    (projections: ProjectionKind[]) => {
      client.subscribe(projections)
    },
    [client],
  )

  const sendTerminalInput = useCallback(
    (sessionId: string, data: string) => {
      client.sendTerminalInput(sessionId, data)
    },
    [client],
  )

  const sendBrowserCommand = useCallback(
    (
      tabId: string,
      command: 'reload' | 'goBack' | 'goForward' | 'stop' | 'screenshot',
    ) => {
      client.sendBrowserCommand(tabId, command)
    },
    [client],
  )

  const readFile = useCallback(
    (file: FileProjection) => {
      client.sendFileRead(file.projectId, file.worktreeId, file.path, 256 * 1024)
    },
    [client],
  )

  const writeFile = useCallback(
    (file: FileProjection, content: string) => {
      client.sendFileWrite(file.projectId, file.worktreeId, file.path, content, true)
    },
    [client],
  )

  return {
    connection,
    projection,
    beginPairing,
    disconnect,
    reconnect,
    subscribe,
    sendTerminalInput,
    sendBrowserCommand,
    readFile,
    writeFile,
  }
}
