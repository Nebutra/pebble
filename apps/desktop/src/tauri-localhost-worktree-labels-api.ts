import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'

export function createPebbleLocalhostWorktreeLabelsApi(): PreloadApi['localhostWorktreeLabels'] {
  return {
    register: async (args) => {
      await ensurePebbleRuntimeProcess()
      return requestRuntimeJson('/v1/localhost-worktree-labels/register', {
        method: 'POST',
        body: args
      })
    }
  }
}
