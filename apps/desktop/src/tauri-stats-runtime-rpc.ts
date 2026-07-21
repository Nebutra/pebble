import type { StatsSummary } from '../../../packages/product-core/shared/types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

type RuntimeRpcResult = { handled: boolean; result?: unknown }

export async function callTauriStatsRuntimeRpc(method: string): Promise<RuntimeRpcResult> {
  if (method !== 'stats.summary') {
    return { handled: false }
  }
  const summary = await requestRuntimeJson<
    Omit<StatsSummary, 'firstEventAt'> & { firstEventAt?: number }
  >('/v1/stats/summary', { method: 'GET' })
  return {
    handled: true,
    result: { ...summary, firstEventAt: summary.firstEventAt ?? null } satisfies StatsSummary
  }
}
