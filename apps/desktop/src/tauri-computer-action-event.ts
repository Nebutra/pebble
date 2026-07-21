import type { RuntimeEventStreamEntry } from './runtime-command-shapes'

export type TauriComputerActionRecord = {
  id: string
  kind: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  result?: Record<string, unknown>
  error?: string
}

export function readTauriComputerActionEvent(
  entry: RuntimeEventStreamEntry
): TauriComputerActionRecord | null {
  if (entry.topic !== 'computer.changed') {
    return null
  }
  try {
    const envelope = JSON.parse(entry.data) as { payload?: unknown }
    return readTauriComputerAction(envelope.payload)
  } catch {
    return null
  }
}

export function readTauriComputerAction(value: unknown): TauriComputerActionRecord | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const action = value as Record<string, unknown>
  if (
    typeof action.id !== 'string' ||
    typeof action.kind !== 'string' ||
    (action.status !== 'queued' &&
      action.status !== 'running' &&
      action.status !== 'completed' &&
      action.status !== 'failed')
  ) {
    return null
  }
  return action as TauriComputerActionRecord
}

export function isTerminalTauriComputerAction(action: TauriComputerActionRecord): boolean {
  return action.status === 'completed' || action.status === 'failed'
}
