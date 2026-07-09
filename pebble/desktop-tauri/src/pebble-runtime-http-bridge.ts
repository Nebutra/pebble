import {
  createRuntimeProcessStartCommand,
  createRuntimeResourceGetCommand,
  createRuntimeResourceRequestCommand,
  createRuntimeStatusProbeCommand,
  getRuntimeProcessStatus,
  getRuntimeResourceJson,
  probeRuntimeStatus,
  requestRuntimeResourceJson,
  startRuntimeProcess
} from './runtime-bridge'
import { DEFAULT_RUNTIME_URL, type RuntimeResourceGetResult } from './runtime-command-shapes'

export type RuntimeHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Start the embedded Pebble runtime if it is not already reachable. Native
 *  namespace bridges call this before their first request so the Go runtime is
 *  guaranteed live without each caller re-implementing the probe/spawn dance. */
export async function ensurePebbleRuntimeProcess(): Promise<void> {
  if (!hasTauriInternals()) {
    return
  }
  const probe = await probeRuntimeStatus(createRuntimeStatusProbeCommand({ timeoutMs: 500 })).catch(
    () => null
  )
  if (probe?.transport === 'connected') {
    return
  }
  const processStatus = await getRuntimeProcessStatus().catch(() => null)
  if (processStatus?.running) {
    return
  }
  await startRuntimeProcess(createRuntimeProcessStartCommand({ listen: '127.0.0.1:17777' })).catch(
    () => undefined
  )
}

/** Issue a JSON request to the embedded runtime. Inside Tauri it routes through
 *  the Rust invoke boundary (no CORS/fetch); in a plain browser dev shell it
 *  falls back to fetch against the local runtime. */
export async function requestRuntimeJson<T>(
  path: string,
  options: { method: RuntimeHttpMethod; body?: unknown; timeoutMs?: number }
): Promise<T> {
  if (hasTauriInternals()) {
    const result =
      options.method === 'GET'
        ? await getRuntimeResourceJson(
            createRuntimeResourceGetCommand({
              path,
              timeoutMs: options.timeoutMs ?? 1500
            })
          )
        : await requestRuntimeResourceJson(
            createRuntimeResourceRequestCommand({
              method: options.method,
              path,
              bodyJson: JSON.stringify(options.body ?? {}),
              timeoutMs: options.timeoutMs ?? 1500
            })
          )
    return parseRuntimeJsonResult<T>(result)
  }

  const response = await fetch(`${DEFAULT_RUNTIME_URL}${path}`, {
    method: options.method,
    headers:
      options.method === 'GET'
        ? undefined
        : {
            'Content-Type': 'application/json'
          },
    body: options.method === 'GET' ? undefined : JSON.stringify(options.body ?? {})
  })
  if (!response.ok) {
    throw new Error(`Runtime request failed with HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

function parseRuntimeJsonResult<T>(result: RuntimeResourceGetResult): T {
  if (result.transport !== 'connected') {
    throw new Error(result.error ?? `Runtime transport failed: ${result.transport}`)
  }
  if (result.httpStatus !== null && (result.httpStatus < 200 || result.httpStatus > 299)) {
    throw new Error(result.body ?? `Runtime request failed with HTTP ${result.httpStatus}`)
  }
  if (!result.body) {
    throw new Error('Runtime returned an empty JSON response.')
  }
  return JSON.parse(result.body) as T
}
