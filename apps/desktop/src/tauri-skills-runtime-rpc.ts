import type { SkillDiscoveryResult } from '../../../packages/product-core/shared/skills'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

type RuntimeRpcResult = { handled: boolean; result?: unknown }

export async function callTauriSkillsRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeRpcResult> {
  if (method !== 'skills.discover') {
    return { handled: false }
  }
  const input = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
  const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined
  return {
    handled: true,
    result: await requestRuntimeJson<SkillDiscoveryResult>('/v1/skills/discover', {
      method: 'POST',
      timeoutMs: 15_000,
      body: cwd ? { cwd } : {}
    })
  }
}
