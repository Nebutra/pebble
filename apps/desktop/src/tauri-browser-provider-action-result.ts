import {
  getTauriComputerActionCursor,
  waitForTauriComputerAction
} from './tauri-computer-action-waiter'

export type TauriBrowserProviderActionRecord = {
  id: string
  kind: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  result?: Record<string, unknown>
  error?: string
}

const PROVIDER_ACTION_WAIT_TIMEOUT_MS = 15_000

export async function waitForTauriBrowserProviderAction(
  actionId: string,
  afterSequence?: number
): Promise<TauriBrowserProviderActionRecord> {
  return waitForTauriComputerAction({
    actionId,
    kindPrefix: 'browser.',
    timeoutMs: PROVIDER_ACTION_WAIT_TIMEOUT_MS,
    timeoutMessage: 'Timed out waiting for Tauri browser provider action.',
    afterSequence
  }) as Promise<TauriBrowserProviderActionRecord>
}

export function getTauriBrowserProviderActionCursor(): number {
  return getTauriComputerActionCursor()
}
