import {
  ensurePebbleRuntimeProcess,
  requestRuntimeJson
} from './pebble-tauri-runtime-transport'

export async function nativeRuntimeCall<Result>(method: string, params?: unknown): Promise<Result> {
  const response = await window.api.runtime.call({ method, params })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as Result
}

export async function readProviderJson<T>(path: string): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, { method: 'GET' })
}

export async function writeProviderJson<T>(
  path: string,
  options: { method: 'POST'; body?: unknown; timeoutMs?: number }
): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, options)
}
