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

export type PebbleRuntimeStatus = {
  version: string
  startedAt: string
  uptimeSeconds: number
  projectCount: number
  worktreeCount: number
  sessionCount: number
  agentRunCount: number
  taskCount: number
  capabilities: string[]
  unavailableTools?: string[]
}

export type RuntimeHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export async function readPebbleStatusOrNull(): Promise<PebbleRuntimeStatus | null> {
  try {
    if (hasTauriInternals()) {
      const result = await probeRuntimeStatus(createRuntimeStatusProbeCommand({ timeoutMs: 1000 }))
      if (result.transport !== 'connected' || !result.body) {
        return null
      }
      return JSON.parse(result.body) as PebbleRuntimeStatus
    }
    return await requestRuntimeJson<PebbleRuntimeStatus>('/v1/status', {
      method: 'GET',
      timeoutMs: 1000
    })
  } catch {
    return null
  }
}

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
  await startRuntimeProcess(
    createRuntimeProcessStartCommand({ listen: '127.0.0.1:17777' })
  ).catch(() => undefined)
}

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

export function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function getHostPlatform(): NodeJS.Platform {
  const userAgent = navigator.userAgent.toLowerCase()
  if (userAgent.includes('windows')) {
    return 'win32'
  }
  if (userAgent.includes('mac')) {
    return 'darwin'
  }
  return 'linux'
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
