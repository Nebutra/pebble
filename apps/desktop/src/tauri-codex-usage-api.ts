import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { projectCodexUsage, type NativeCodexSnapshot } from './tauri-codex-usage-projection'

async function get<T>(path: string): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, { method: 'GET' })
}

async function post<T>(path: string, body: unknown): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, { method: 'POST', body })
}

async function nativeSnapshot(force = false): Promise<NativeCodexSnapshot> {
  return post('/v1/usage/codex/snapshot', { force })
}

export function createPebbleCodexUsageApi(): PreloadApi['codexUsage'] {
  return {
    getScanState: () => get('/v1/usage/codex/state'),
    setEnabled: ({ enabled }) => post('/v1/usage/codex/state', { enabled }),
    refresh: async ({ force } = {}) => (await nativeSnapshot(force)).scanState,
    getSnapshot: async ({ scope, range, limit }) =>
      projectCodexUsage(await nativeSnapshot(), scope, range, limit),
    getSummary: async ({ scope, range }) =>
      projectCodexUsage(await nativeSnapshot(), scope, range).summary,
    getDaily: async ({ scope, range }) =>
      projectCodexUsage(await nativeSnapshot(), scope, range).daily,
    getBreakdown: async ({ scope, range, kind }) =>
      projectCodexUsage(await nativeSnapshot(), scope, range)[
        kind === 'model' ? 'modelBreakdown' : 'projectBreakdown'
      ],
    getRecentSessions: async ({ scope, range, limit }) =>
      projectCodexUsage(await nativeSnapshot(), scope, range, limit).recentSessions
  }
}
