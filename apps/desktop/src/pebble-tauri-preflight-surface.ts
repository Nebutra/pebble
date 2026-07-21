import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { PreflightStatus } from '../../../packages/product-core/shared/preflight-api-types'
import type { RuntimeRpcResponse } from '../../../packages/product-core/shared/runtime-rpc-envelope'
import {
  readPebbleStatusOrNull,
  requestRuntimeJson
} from './pebble-tauri-runtime-transport'
import {
  normalizeHostTerminalCapabilities,
  readSshTerminalCapabilities
} from './host-terminal-capabilities'
import { readRelayDetectedRemoteAgents } from './tauri-relay-agent-detection'
import {
  detectTauriAgents,
  readTauriPreflightStatus,
  refreshTauriAgents
} from './tauri-preflight-agent-api'

const fallbackPreflightStatus: PreflightStatus = {
  git: { installed: false },
  gh: { installed: false, authenticated: false },
  glab: { installed: false, authenticated: false },
  bitbucket: { configured: false, authenticated: false, account: null },
  azureDevOps: {
    configured: false,
    authenticated: false,
    account: null,
    baseUrl: null,
    tokenConfigured: false
  },
  gitea: {
    configured: false,
    authenticated: false,
    account: null,
    baseUrl: null,
    tokenConfigured: false
  }
}

export function createPebblePreflightApi(base: PreloadApi['preflight']): PreloadApi['preflight'] {
  return {
    ...base,
    check: async () => {
      const status = await readPebbleStatusOrNull()
      if (!status) {
        return readTauriPreflightStatus(fallbackPreflightStatus)
      }
      return readTauriPreflightStatus({
        ...fallbackPreflightStatus,
        git: { installed: !status.unavailableTools?.includes('git') }
      })
    },
    detectAgents: () => detectTauriAgents(),
    refreshAgents: () => refreshTauriAgents(),
    detectRemoteAgents: async ({ connectionId }) => {
      try {
        return readRemoteAgentIds(
          await callRuntimeEnvironmentResult(connectionId, 'preflight.detectAgents')
        )
      } catch {
        // Relay-only SSH connections have no paired runtime environment; fall
        // back to the relay worker's cached PATH probe held by the Go runtime.
        return readRelayDetectedRemoteAgents(requestRuntimeJson, connectionId)
      }
    },
    detectRemoteWindowsTerminalCapabilities: async ({ connectionId }) => {
      try {
        return normalizeHostTerminalCapabilities(
          await callRuntimeEnvironmentResult(
            connectionId,
            'preflight.detectWindowsTerminalCapabilities'
          )
        )
      } catch {
        // Why: relay-only SSH has no paired RPC channel, so probe the selected
        // target through the purpose-scoped native relay worker instead.
        return readSshTerminalCapabilities(requestRuntimeJson, connectionId)
      }
    }
  }
}

async function callRuntimeEnvironmentResult(
  selector: string,
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<unknown> {
  const response = (await window.api.runtimeEnvironments.call({
    selector,
    method,
    params,
    timeoutMs
  })) as RuntimeRpcResponse<unknown>
  if (response.ok) {
    return response.result
  }
  throw new Error(response.error.message)
}

function readRemoteAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))]
}
