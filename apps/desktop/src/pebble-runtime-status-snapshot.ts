import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION
} from '../../../packages/product-core/shared/protocol-version'
import type {
  RuntimeSyncWindowGraph,
  RuntimeSyncWindowGraphResult
} from '../../../packages/product-core/shared/runtime-types'
import { getHostPlatform, readPebbleStatusOrNull } from './pebble-tauri-runtime-transport'
import { PEBBLE_RUNTIME_ID } from './pebble-runtime-rpc-response'

const TAURI_RUNTIME_CAPABILITIES = RUNTIME_CAPABILITIES

export async function readOrCreateRuntimeStatus(
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
    // Why: capability reporting follows the native Tauri/Go implementation;
    // clients may select the raw, backpressured screencast transport.
    capabilities: [...TAURI_RUNTIME_CAPABILITIES],
    hostPlatform: getHostPlatform(),
    remoteControl: null,
    agentOrchestrationByPaneKey: {}
  }
}
