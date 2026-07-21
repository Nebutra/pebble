import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { SparsePreset } from '../../../packages/product-core/shared/types'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'

type SparsePresetsApi = PreloadApi['sparsePresets']
const listeners = new Set<(data: { repoId: string }) => void>()
let subscriptionStarted = false

export function createPebbleSparsePresetsApi(): SparsePresetsApi {
  ensureSubscription()
  return {
    list: async ({ repoId }) => {
      await ensurePebbleRuntimeProcess()
      return requestRuntimeJson<SparsePreset[]>(sparsePresetPath(repoId), { method: 'GET' })
    },
    save: async ({ repoId, ...input }) => {
      await ensurePebbleRuntimeProcess()
      return requestRuntimeJson<SparsePreset>(sparsePresetPath(repoId), {
        method: 'POST',
        body: input
      })
    },
    remove: async ({ repoId, presetId }) => {
      await ensurePebbleRuntimeProcess()
      await requestRuntimeJson(
        `${sparsePresetPath(repoId)}&presetId=${encodeURIComponent(presetId)}`,
        { method: 'DELETE' }
      )
    },
    onChanged: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
}

function sparsePresetPath(repoId: string): string {
  return `/v1/sparse-presets?repoId=${encodeURIComponent(repoId)}`
}

function ensureSubscription(): void {
  if (subscriptionStarted) {
    return
  }
  subscriptionStarted = true
  void subscribeRuntimeEventPush((entry) => {
    if (entry.topic !== 'repo.sparse-presets.changed') {
      return
    }
    try {
      const envelope = JSON.parse(entry.data) as { payload?: { repoId?: unknown } }
      const repoId = envelope.payload?.repoId
      if (typeof repoId === 'string') {
        for (const listener of listeners) {
          listener({ repoId })
        }
      }
    } catch {
      // Malformed runtime events are ignored; the next list call remains authoritative.
    }
  })
}
