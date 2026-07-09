import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../src/preload/api-types'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION
} from '../../../src/shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../src/shared/runtime-rpc-envelope'
import type {
  RuntimeSyncWindowGraph,
  RuntimeSyncWindowGraphResult
} from '../../../src/shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../src/shared/runtime-environments'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import { PRODUCT_NAME } from './product-brand'
import {
  getErrorMessage,
  getHostPlatform,
  hasTauriInternals,
  readPebbleStatusOrNull
} from './pebble-tauri-runtime-transport'
import {
  createRuntimeWorktree,
  getRuntimeRepoId,
  readRepos,
  readWorktrees,
  removeRuntimeWorktree,
  setRuntimeWorktreeMeta,
  toCreateWorktreeArgs
} from './pebble-tauri-workspace-runtime-api'

const PEBBLE_RUNTIME_ID = 'pebble-local'

export function createPebbleRuntimeApi(base: PreloadApi['runtime']): PreloadApi['runtime'] {
  return {
    ...base,
    syncWindowGraph: (graph) => readOrCreateRuntimeStatus(graph),
    getStatus: () => readOrCreateRuntimeStatus(),
    call: ({ method, params }) => callPebbleRuntimeMethod(method, params),
    getTerminalFitOverrides: () => Promise.resolve([]),
    getTerminalDrivers: () => Promise.resolve([]),
    getBrowserDrivers: () => Promise.resolve([]),
    restoreTerminalFit: () => Promise.resolve({ restored: false }),
    reclaimBrowserForDesktop: () => Promise.resolve({ reclaimed: false }),
    onTerminalFitOverrideChanged: () => noopUnsubscribe,
    onTerminalDriverChanged: () => noopUnsubscribe,
    onBrowserDriverChanged: () => noopUnsubscribe
  }
}

export function createPebbleRuntimeEnvironmentsApi(
  base: PreloadApi['runtimeEnvironments']
): PreloadApi['runtimeEnvironments'] {
  return {
    ...base,
    list: () =>
      hasTauriInternals()
        ? invoke<PublicKnownRuntimeEnvironment[]>('runtime_environments_list')
        : Promise.resolve([]),
    resolve: ({ selector }) =>
      invoke<PublicKnownRuntimeEnvironment>('runtime_environments_resolve', {
        input: { selector }
      }),
    getStatus: async () => okRuntimeRpc(await readOrCreateRuntimeStatus()),
    call: ({ method, params }) => callPebbleRuntimeMethod(method, params),
    addFromPairingCode: ({ name, pairingCode }) =>
      invoke<{ environment: PublicKnownRuntimeEnvironment }>(
        'runtime_environments_add_from_pairing_code',
        { input: { name, pairingCode } }
      ),
    remove: ({ selector }) =>
      invoke<{ removed: PublicKnownRuntimeEnvironment }>('runtime_environments_remove', {
        input: { selector }
      }),
    disconnect: ({ selector }) =>
      invoke<{ disconnected: PublicKnownRuntimeEnvironment }>('runtime_environments_disconnect', {
        input: { selector }
      }),
    subscribe: async (_args, callbacks) => {
      callbacks.onClose?.()
      return { unsubscribe: noopUnsubscribe, sendBinary: noopSendBinary }
    }
  }
}

async function callPebbleRuntimeMethod(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown>> {
  try {
    switch (method) {
      case 'status.get':
        return okRuntimeRpc(await readOrCreateRuntimeStatus())
      case 'repo.list':
        return okRuntimeRpc({ repos: await readRepos() })
      case 'project.list':
        return okRuntimeRpc({ projects: projectHostSetupProjectionFromRepos(await readRepos()).projects })
      case 'projectHostSetup.list':
        return okRuntimeRpc({ setups: projectHostSetupProjectionFromRepos(await readRepos()).setups })
      case 'worktree.list':
        return okRuntimeRpc({ worktrees: await readWorktrees(getRuntimeRepoId(params)) })
      case 'worktree.lineageList':
        return okRuntimeRpc({ lineage: {}, workspaceLineage: {} })
      case 'worktree.create':
        return okRuntimeRpc({ worktree: await createRuntimeWorktree(toCreateWorktreeArgs(params)) })
      case 'worktree.set':
        return okRuntimeRpc({ worktree: await setRuntimeWorktreeMeta(params) })
      case 'worktree.remove':
        await removeRuntimeWorktree(params)
        return okRuntimeRpc({ preservedBranch: undefined })
      case 'preflight.check':
        return okRuntimeRpc(await window.api.preflight.check())
      default:
        return failRuntimeRpc(
          'method_not_available',
          `${PRODUCT_NAME} runtime method is not mapped: ${method}`
        )
    }
  } catch (error) {
    return failRuntimeRpc('runtime_error', getErrorMessage(error))
  }
}

async function readOrCreateRuntimeStatus(
  graph?: RuntimeSyncWindowGraph
): Promise<RuntimeSyncWindowGraphResult> {
  const status = await readPebbleStatusOrNull()
  return {
    runtimeId: PEBBLE_RUNTIME_ID,
    rendererGraphEpoch: Date.now(),
    graphStatus: status ? 'ready' : 'unavailable',
    authoritativeWindowId: null,
    liveTabCount: graph?.tabs.length ?? 0,
    liveLeafCount: graph?.leaves.length ?? 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
    capabilities: [...RUNTIME_CAPABILITIES],
    hostPlatform: getHostPlatform(),
    remoteControl: null,
    agentOrchestrationByPaneKey: {}
  }
}

function okRuntimeRpc<TResult>(result: TResult): RuntimeRpcResponse<TResult> {
  return {
    id: crypto.randomUUID(),
    ok: true,
    result,
    _meta: { runtimeId: PEBBLE_RUNTIME_ID }
  }
}

function failRuntimeRpc(code: string, message: string): RuntimeRpcResponse<unknown> {
  return {
    id: crypto.randomUUID(),
    ok: false,
    error: { code, message },
    _meta: { runtimeId: PEBBLE_RUNTIME_ID }
  }
}

function noopUnsubscribe(): void {}

function noopSendBinary(_bytes: Uint8Array<ArrayBufferLike>): void {}
