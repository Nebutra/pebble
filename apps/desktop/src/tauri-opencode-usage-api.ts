import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  projectOpenCodeUsage,
  type NativeOpenCodeSnapshot
} from './tauri-opencode-usage-projection'

async function get<T>(path: string): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, { method: 'GET' })
}

async function post<T>(path: string, body: unknown): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, { method: 'POST', body })
}

async function nativeSnapshot(force = false): Promise<NativeOpenCodeSnapshot> {
  return post('/v1/usage/opencode/snapshot', { force })
}

export function createPebbleOpenCodeUsageApi(): PreloadApi['openCodeUsage'] {
  return {
    getScanState: () => get('/v1/usage/opencode/state'),
    setEnabled: ({ enabled }) => post('/v1/usage/opencode/state', { enabled }),
    refresh: async ({ force } = {}) => (await nativeSnapshot(force)).scanState,
    getSnapshot: async ({ scope, range, limit }) =>
      projectOpenCodeUsage(await nativeSnapshot(), scope, range, limit),
    getSummary: async ({ scope, range }) =>
      projectOpenCodeUsage(await nativeSnapshot(), scope, range).summary,
    getDaily: async ({ scope, range }) =>
      projectOpenCodeUsage(await nativeSnapshot(), scope, range).daily,
    getBreakdown: async ({ scope, range, kind }) =>
      projectOpenCodeUsage(await nativeSnapshot(), scope, range)[
        kind === 'model' ? 'modelBreakdown' : 'projectBreakdown'
      ],
    getRecentSessions: async ({ scope, range, limit }) =>
      projectOpenCodeUsage(await nativeSnapshot(), scope, range, limit).recentSessions
  }
}
