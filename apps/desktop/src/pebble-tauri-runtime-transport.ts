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
import { LOCAL_RUNTIME_ENDPOINT } from './local-runtime-endpoint'

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

export type RuntimeHttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

const RUNTIME_READY_TIMEOUT_MS = 8_000
const RUNTIME_READY_POLL_MS = 25
const RUNTIME_RESTART_BACKOFF_MS = 100
const isParityCapture = String(import.meta.env.VITE_TAURI_PARITY_CAPTURE) === 'true'
let runtimeStartupPromise: Promise<void> | null = null

export async function readPebbleStatusOrNull(): Promise<PebbleRuntimeStatus | null> {
  // Why: parity capture intentionally has no runtime. Probing the user's live
  // endpoint would make screenshot evidence depend on unrelated local state.
  if (isParityCapture) {
    return null
  }
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
  // Why: each parity sample is a short-lived shell. Starting its own runtime
  // collides with the live app and records an expected port conflict as a crash.
  if (isParityCapture || !hasTauriInternals()) {
    return
  }
  const probe = await probeRuntimeStatus(createRuntimeStatusProbeCommand({ timeoutMs: 500 })).catch(
    () => null
  )
  if (probe?.transport === 'connected') {
    return
  }
  if (!runtimeStartupPromise) {
    runtimeStartupPromise = startAndWaitForRuntime().finally(() => {
      runtimeStartupPromise = null
    })
  }
  await runtimeStartupPromise
}

async function startAndWaitForRuntime(): Promise<void> {
  const deadline = Date.now() + RUNTIME_READY_TIMEOUT_MS
  let nextStartAt = 0
  let lastProcessError: string | null = null
  while (Date.now() < deadline) {
    const probe = await probeRuntimeStatus(
      createRuntimeStatusProbeCommand({ timeoutMs: RUNTIME_READY_POLL_MS })
    ).catch(() => null)
    if (probe?.transport === 'connected') {
      return
    }
    const status = await getRuntimeProcessStatus().catch(() => null)
    if (!status?.running && Date.now() >= nextStartAt) {
      lastProcessError = status?.error ?? lastProcessError
      // Why: the previous desktop runtime can release its port just after the
      // replacement sidecar starts. Retry within the bounded readiness window.
      try {
        await startRuntimeProcess(
          createRuntimeProcessStartCommand({
            listen: LOCAL_RUNTIME_ENDPOINT.listen,
            dataDir: LOCAL_RUNTIME_ENDPOINT.dataDir
          })
        )
      } catch (error) {
        lastProcessError = getErrorMessage(error)
      }
      nextStartAt = Date.now() + RUNTIME_RESTART_BACKOFF_MS
    }
    await delay(RUNTIME_READY_POLL_MS)
  }
  if (lastProcessError) {
    throw new Error(lastProcessError)
  }
  throw new Error(`Pebble runtime did not become ready within ${RUNTIME_READY_TIMEOUT_MS}ms.`)
}

export async function requestRuntimeJson<T>(
  path: string,
  options: { method: RuntimeHttpMethod; body?: unknown; timeoutMs?: number }
): Promise<T> {
  if (hasTauriInternals()) {
    // Why: process creation and HTTP readiness are separate states. Every native
    // request joins the shared readiness gate so startup races cannot leak ECONNREFUSED.
    await ensurePebbleRuntimeProcess()
    let result = await requestNativeRuntimeResource(path, options)
    if (result.transport === 'unreachable') {
      // Why: the runtime can exit between a successful readiness probe and the
      // request. Writes may already have arrived, so only side-effect-free GETs replay.
      await ensurePebbleRuntimeProcess()
      if (options.method === 'GET') {
        result = await requestNativeRuntimeResource(path, options)
      }
    }
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

function requestNativeRuntimeResource(
  path: string,
  options: { method: RuntimeHttpMethod; body?: unknown; timeoutMs?: number }
): Promise<RuntimeResourceGetResult> {
  return options.method === 'GET'
    ? getRuntimeResourceJson(
        createRuntimeResourceGetCommand({
          path,
          timeoutMs: options.timeoutMs ?? 1500
        })
      )
    : requestRuntimeResourceJson(
        createRuntimeResourceRequestCommand({
          method: options.method,
          path,
          bodyJson: JSON.stringify(options.body ?? {}),
          timeoutMs: options.timeoutMs ?? 1500
        })
      )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
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
