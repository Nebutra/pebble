import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { RuntimeRpcResponse } from '../../../packages/product-core/shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../packages/product-core/shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../packages/product-core/shared/runtime-environments'
import { PRODUCT_NAME } from './product-brand'
import { warnUnmappedRuntimeMethod } from './runtime-unmapped-method-warning'
import { getErrorMessage, hasTauriInternals } from './pebble-tauri-runtime-transport'
import { subscribeTauriRuntimeEnvironment } from './tauri-runtime-environment-subscription-api'
import { runtimeFeatureInteractionId } from './runtime-feature-interaction'
import { failRuntimeRpc } from './pebble-runtime-rpc-response'
import { readOrCreateRuntimeStatus } from './pebble-runtime-status-snapshot'
import {
  browserDriverListeners,
  readBrowserDriversFromRuntime,
  readTerminalDrivers,
  readTerminalFitOverrides,
  reclaimTauriBrowserForDesktop,
  restoreTauriTerminalFit,
  subscribeToSet,
  terminalDriverListeners,
  terminalFitOverrideListeners
} from './pebble-runtime-driver-registry'
import { dispatchTauriSubsystemRuntimeRpc } from './pebble-runtime-subsystem-rpc-dispatch'
import { dispatchProjectRuntimeMethod } from './pebble-runtime-project-method-dispatch'
import { dispatchHostCapabilityRuntimeMethod } from './pebble-runtime-host-capability-dispatch'
import { dispatchWorktreeRuntimeMethod } from './pebble-runtime-worktree-method-dispatch'
import { dispatchProviderReadRuntimeMethod } from './pebble-runtime-provider-read-dispatch'
import { dispatchHostedReviewRuntimeMethod } from './pebble-runtime-hosted-review-dispatch'

export function createPebbleRuntimeApi(base: PreloadApi['runtime']): PreloadApi['runtime'] {
  return {
    ...base,
    syncWindowGraph: (graph) => readOrCreateRuntimeStatus(graph),
    getStatus: () => readOrCreateRuntimeStatus(),
    call: ({ method, params }) => callPebbleRuntimeMethod(method, params),
    getTerminalFitOverrides: () => Promise.resolve(readTerminalFitOverrides()),
    getTerminalDrivers: () => Promise.resolve(readTerminalDrivers()),
    getBrowserDrivers: () => readBrowserDriversFromRuntime(),
    restoreTerminalFit: async (ptyId) => restoreTauriTerminalFit(ptyId),
    reclaimBrowserForDesktop: async (browserPageId) => reclaimTauriBrowserForDesktop(browserPageId),
    onTerminalFitOverrideChanged: (callback) =>
      subscribeToSet(terminalFitOverrideListeners, callback),
    onTerminalDriverChanged: (callback) => subscribeToSet(terminalDriverListeners, callback),
    onBrowserDriverChanged: (callback) => subscribeToSet(browserDriverListeners, callback)
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
    // Why: returning the local runtime status made every saved remote server look
    // Connected while remote calls failed; probe the selected environment instead.
    getStatus: async ({ selector, timeoutMs }) => {
      try {
        return (await invoke<RuntimeRpcResponse<RuntimeStatus>>('runtime_environments_call', {
          input: { selector, method: 'status.get', timeoutMs }
        })) as RuntimeRpcResponse<RuntimeStatus>
      } catch (error) {
        return failRuntimeRpc(
          'remote_runtime_unavailable',
          getErrorMessage(error)
        ) as RuntimeRpcResponse<RuntimeStatus>
      }
    },
    call: async ({ selector, method, params, timeoutMs }) => {
      try {
        return await invoke<RuntimeRpcResponse<unknown>>('runtime_environments_call', {
          input: { selector, method, params, timeoutMs }
        })
      } catch (error) {
        return failRuntimeRpc('remote_runtime_unavailable', getErrorMessage(error))
      }
    },
    addFromPairingCode: ({ name, pairingCode }) =>
      invoke<{ environment: PublicKnownRuntimeEnvironment }>(
        'runtime_environments_add_from_pairing_code',
        { input: { name, pairingCode } }
      ),
    updateEndpoint: ({ selector, endpoint }) =>
      invoke<{ environment: PublicKnownRuntimeEnvironment }>(
        'runtime_environments_update_endpoint',
        { input: { selector, endpoint } }
      ),
    remove: ({ selector }) =>
      invoke<{ removed: PublicKnownRuntimeEnvironment }>('runtime_environments_remove', {
        input: { selector }
      }),
    disconnect: ({ selector }) =>
      invoke<{ disconnected: PublicKnownRuntimeEnvironment }>('runtime_environments_disconnect', {
        input: { selector }
      }),
    subscribe: (args, callbacks) =>
      hasTauriInternals()
        ? subscribeTauriRuntimeEnvironment(args, callbacks)
        : base.subscribe(args, callbacks)
  }
}

async function callPebbleRuntimeMethod(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown>> {
  const response = await callPebbleRuntimeMethodInner(method, params)
  const interactionId = response.ok ? runtimeFeatureInteractionId(method, params) : null
  const uiApi = globalThis.window?.api?.ui
  if (interactionId && uiApi) {
    // Why: education telemetry is best-effort and must never turn a successful runtime RPC into a failure.
    void uiApi.recordFeatureInteraction(interactionId).catch(() => {})
  }
  return response
}

// Each dispatch group owns a disjoint slice of the method namespace and returns
// null when it does not recognize the method, so the first match wins.
async function callPebbleRuntimeMethodInner(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown>> {
  try {
    const handled =
      (await dispatchTauriSubsystemRuntimeRpc(method, params)) ??
      (await dispatchProjectRuntimeMethod(method, params)) ??
      (await dispatchHostCapabilityRuntimeMethod(method, params)) ??
      (await dispatchWorktreeRuntimeMethod(method, params)) ??
      (await dispatchProviderReadRuntimeMethod(method, params)) ??
      (await dispatchHostedReviewRuntimeMethod(method, params))
    if (handled) {
      return handled
    }
    warnUnmappedRuntimeMethod(method)
    return failRuntimeRpc(
      'method_not_available',
      `${PRODUCT_NAME} runtime method is not mapped: ${method}`
    )
  } catch (error) {
    return failRuntimeRpc('runtime_error', getErrorMessage(error))
  }
}
