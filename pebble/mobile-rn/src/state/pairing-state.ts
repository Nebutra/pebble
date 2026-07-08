import { useCallback, useEffect, useState } from 'react'

import { DeviceIdentity, PairingRecord, PairingRequest } from '@/relay/relay-protocol'
import {
  clearStoredPairingRecord,
  loadOrCreateDeviceIdentity,
  loadStoredPairingRecord,
  saveStoredPairingRecord,
} from '@/state/pairing-storage'

export type PairingPhase = 'loading' | 'unpaired' | 'pairing' | 'paired' | 'error'

export interface PairingState {
  phase: PairingPhase
  device: DeviceIdentity | null
  record: PairingRecord | null
  pendingRequest: PairingRequest | null
  errorMessage?: string
}

export interface PairingController extends PairingState {
  startPairing: (request: PairingRequest) => void
  completePairing: (record: PairingRecord) => Promise<void>
  rejectPairing: (reason: string) => void
  forgetPairing: () => Promise<void>
  markConnected: () => Promise<void>
}

const initialPairingState: PairingState = {
  phase: 'loading',
  device: null,
  record: null,
  pendingRequest: null,
}

export function usePairingState(): PairingController {
  const [state, setState] = useState<PairingState>(initialPairingState)

  useEffect(() => {
    let isActive = true

    async function loadPairingState(): Promise<void> {
      try {
        const [device, record] = await Promise.all([
          loadOrCreateDeviceIdentity(),
          loadStoredPairingRecord(),
        ])

        if (!isActive) {
          return
        }

        setState({
          phase: record === null ? 'unpaired' : 'paired',
          device,
          record,
          pendingRequest: null,
        })
      } catch (error) {
        if (!isActive) {
          return
        }

        setState({
          phase: 'error',
          device: null,
          record: null,
          pendingRequest: null,
          errorMessage: error instanceof Error ? error.message : 'Pairing state could not be loaded',
        })
      }
    }

    void loadPairingState()

    return () => {
      isActive = false
    }
  }, [])

  const startPairing = useCallback((request: PairingRequest) => {
    setState((currentState) => ({
      ...currentState,
      phase: 'pairing',
      pendingRequest: request,
      errorMessage: undefined,
    }))
  }, [])

  const completePairing = useCallback(async (record: PairingRecord) => {
    await saveStoredPairingRecord(record)

    setState((currentState) => ({
      ...currentState,
      phase: 'paired',
      record,
      pendingRequest: null,
      errorMessage: undefined,
    }))
  }, [])

  const rejectPairing = useCallback((reason: string) => {
    setState((currentState) => ({
      ...currentState,
      phase: 'error',
      pendingRequest: null,
      errorMessage: reason,
    }))
  }, [])

  const forgetPairing = useCallback(async () => {
    await clearStoredPairingRecord()

    setState((currentState) => ({
      ...currentState,
      phase: 'unpaired',
      record: null,
      pendingRequest: null,
      errorMessage: undefined,
    }))
  }, [])

  const markConnected = useCallback(async () => {
    let nextRecord: PairingRecord | null = null

    setState((currentState) => {
      if (currentState.record === null) {
        return currentState
      }

      nextRecord = {
        ...currentState.record,
        lastConnectedAt: new Date().toISOString(),
      }

      return {
        ...currentState,
        record: nextRecord,
      }
    })

    if (nextRecord !== null) {
      await saveStoredPairingRecord(nextRecord)
    }
  }, [])

  return {
    ...state,
    startPairing,
    completePairing,
    rejectPairing,
    forgetPairing,
    markConnected,
  }
}
