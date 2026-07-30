import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'

// GET adapter for the provider-review bridge; ensures the runtime is up first,
// then a non-2xx (501 CLI-missing, 401 unauthenticated) throws so the dispatcher
// surfaces a failed RPC like Electron's provider load failures.
export async function getProviderJson<T>(path: string): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, { method: 'GET' })
}

export async function postProviderJson<T>(
  path: string,
  options: { method: 'POST'; body?: unknown; timeoutMs?: number }
): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, options)
}
