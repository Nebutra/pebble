import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

export function createPebbleAgentTrustApi(): PreloadApi['agentTrust'] {
  return {
    markTrusted: async (input) => {
      const connectionId = input.connectionId?.trim()
      if (!connectionId) {
        return invoke<void>('agent_trust_mark_trusted', { input })
      }
      // Why: SSH agents read trust state from the remote user's HOME; writing
      // through the desktop Rust command would trust an unrelated local path.
      const response = await window.api.runtimeEnvironments.call({
        selector: connectionId,
        method: 'agentTrust.markTrusted',
        params: { preset: input.preset, workspacePath: input.workspacePath },
        timeoutMs: 15_000
      })
      if (!response.ok) {
        throw new Error(response.error.message || response.error.code)
      }
    }
  }
}
