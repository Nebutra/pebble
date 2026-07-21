import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { WorkspaceSpaceScanProgress } from '../../../packages/product-core/shared/workspace-space-types'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'

type WorkspaceSpaceApi = PreloadApi['workspaceSpace']
const listeners = new Set<(progress: WorkspaceSpaceScanProgress) => void>()
let subscriptionStarted = false

export function createPebbleWorkspaceSpaceApi(): WorkspaceSpaceApi {
  ensureProgressSubscription()
  return {
    analyze: async () => {
      await ensurePebbleRuntimeProcess()
      return requestRuntimeJson('/v1/workspace-space/analyze', { method: 'POST' })
    },
    cancel: async () => {
      await ensurePebbleRuntimeProcess()
      const result = await requestRuntimeJson<{ cancelled: boolean }>(
        '/v1/workspace-space/cancel',
        {
          method: 'POST'
        }
      )
      return result.cancelled
    },
    onProgress: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
}

function ensureProgressSubscription(): void {
  if (subscriptionStarted) {
    return
  }
  subscriptionStarted = true
  void subscribeRuntimeEventPush((entry) => {
    if (entry.topic !== 'workspace-space.progress') {
      return
    }
    try {
      const envelope = JSON.parse(entry.data) as { payload?: WorkspaceSpaceScanProgress }
      if (!envelope.payload?.scanId) {
        return
      }
      for (const listener of listeners) {
        listener(envelope.payload)
      }
    } catch {
      // The next authoritative analyze response repairs a malformed progress event.
    }
  })
}
