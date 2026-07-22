import { invoke } from '@tauri-apps/api/core'

import { useAppStore } from '@/store'
import {
  getCurrentRuntimeAgentAwakeStatuses,
  subscribeCurrentRuntimeAgentAwakeStatuses,
  type CurrentRuntimeAgentAwakeStatus
} from './tauri-agent-status-api'

type AgentAwakeSyncInput = {
  enabled: boolean
  statuses: CurrentRuntimeAgentAwakeStatus[]
}

type AgentAwakeSyncDependencies = {
  invokeSync: (input: AgentAwakeSyncInput) => Promise<unknown>
  readInput: () => AgentAwakeSyncInput
  subscribe: (listener: () => void) => () => void
}

type QueuedSync = {
  fingerprint: string
  input: AgentAwakeSyncInput
}

export type AgentAwakeSyncCoordinator = {
  dispose: () => void
}

let installed = false

export function installTauriAgentAwakeSync(): void {
  if (installed) {
    return
  }
  installed = true
  const coordinator = createAgentAwakeSyncCoordinator({
    invokeSync: (input) => invoke('agent_awake_sync', { input }),
    readInput: () => ({
      enabled: useAppStore.getState().settings?.keepComputerAwakeWhileAgentsRun === true,
      statuses: getCurrentRuntimeAgentAwakeStatuses()
    }),
    subscribe: (listener) => {
      const unsubscribeSettings = useAppStore.subscribe(listener)
      const unsubscribeStatuses = subscribeCurrentRuntimeAgentAwakeStatuses(listener)
      return () => {
        unsubscribeSettings()
        unsubscribeStatuses()
      }
    }
  })
  window.addEventListener('pagehide', coordinator.dispose, { once: true })
}

export function createAgentAwakeSyncCoordinator(
  dependencies: AgentAwakeSyncDependencies
): AgentAwakeSyncCoordinator {
  let disposed = false
  let running = false
  let queued: QueuedSync | null = null
  let inFlightFingerprint: string | null = null
  let lastSentFingerprint: string | null = null

  const queueCurrentInput = (): void => {
    if (disposed) {
      return
    }
    queueInput(dependencies.readInput())
  }

  const queueInput = (input: AgentAwakeSyncInput): void => {
    const fingerprint = JSON.stringify(input)
    if (
      fingerprint === lastSentFingerprint ||
      fingerprint === inFlightFingerprint ||
      fingerprint === queued?.fingerprint
    ) {
      return
    }
    queued = { fingerprint, input }
    void flush()
  }

  const flush = async (): Promise<void> => {
    if (running) {
      return
    }
    running = true
    try {
      while (queued) {
        const next = queued
        queued = null
        inFlightFingerprint = next.fingerprint
        try {
          await dependencies.invokeSync(next.input)
          lastSentFingerprint = next.fingerprint
        } catch (error) {
          console.error('Failed to synchronize agent awake state:', error)
        } finally {
          inFlightFingerprint = null
        }
      }
    } finally {
      running = false
    }
  }

  const unsubscribe = dependencies.subscribe(queueCurrentInput)
  queueCurrentInput()

  return {
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      unsubscribe()
      // Why: renderer teardown may precede process exit; explicitly release
      // the native assertion while the command channel is still available.
      queueInput({ enabled: false, statuses: [] })
    }
  }
}
