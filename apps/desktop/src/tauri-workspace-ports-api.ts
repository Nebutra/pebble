import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  WorkspacePortAdvertisedUrlChangedEvent,
  WorkspacePortScanResult
} from '../../../packages/product-core/shared/workspace-ports'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'

type WorkspacePortsApi = PreloadApi['workspacePorts']
type RuntimeRpcResult = { handled: boolean; result?: unknown }
const advertisedUrlListeners = new Set<(event: WorkspacePortAdvertisedUrlChangedEvent) => void>()
let eventSubscriptionStarted = false

export function createPebbleWorkspacePortsApi(): WorkspacePortsApi {
  ensureAdvertisedUrlSubscription()
  return {
    scan: async ({ repoId } = {}) => {
      await ensurePebbleRuntimeProcess()
      return requestRuntimeJson<WorkspacePortScanResult>(
        `/v1/workspace-ports${repoId ? `?repoId=${encodeURIComponent(repoId)}` : ''}`,
        { method: 'GET' }
      )
    },
    kill: async (args) => {
      await ensurePebbleRuntimeProcess()
      return requestRuntimeJson('/v1/workspace-ports/kill', { method: 'POST', body: args })
    },
    onAdvertisedUrlChanged: (callback) => {
      advertisedUrlListeners.add(callback)
      return () => advertisedUrlListeners.delete(callback)
    }
  }
}

export async function callTauriWorkspacePortsRuntimeRpc(
  method: string,
  params: unknown,
  workspacePortsApi?: Pick<WorkspacePortsApi, 'scan' | 'kill'>
): Promise<RuntimeRpcResult> {
  if (method === 'workspacePorts.scan') {
    const input = readOptionalRecord(params)
    const repoId = readOptionalString(input.repoId, 'repoId')
    return {
      handled: true,
      result: await requireWorkspacePortsApi(workspacePortsApi).scan(repoId ? { repoId } : {})
    }
  }
  if (method === 'workspacePorts.kill') {
    const input = requireRecord(params)
    return {
      handled: true,
      result: await requireWorkspacePortsApi(workspacePortsApi).kill({
        repoId: requireString(input.repoId, 'repoId'),
        pid: requirePositiveInteger(input.pid, 'pid'),
        port: requirePort(input.port)
      })
    }
  }
  return { handled: false }
}

function requireWorkspacePortsApi(
  api?: Pick<WorkspacePortsApi, 'scan' | 'kill'>
): Pick<WorkspacePortsApi, 'scan' | 'kill'> {
  // Why: unrelated runtime calls can arrive before the preload surface is fully assembled.
  return api ?? window.api.workspacePorts
}

function readOptionalRecord(value: unknown): Record<string, unknown> {
  return value === undefined || value === null ? {} : requireRecord(value)
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workspace port parameters must be an object.')
  }
  return value as Record<string, unknown>
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  return requireString(value, field)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Workspace port ${field} must be a non-empty string.`)
  }
  return value.trim()
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Workspace port ${field} must be a positive integer.`)
  }
  return value as number
}

function requirePort(value: unknown): number {
  const port = requirePositiveInteger(value, 'port')
  if (port > 65_535) {
    throw new Error('Workspace port must be at most 65535.')
  }
  return port
}

function ensureAdvertisedUrlSubscription(): void {
  if (eventSubscriptionStarted) {
    return
  }
  eventSubscriptionStarted = true
  void subscribeRuntimeEventPush((entry) => {
    if (entry.topic !== 'workspace-port.advertised-url-changed') {
      return
    }
    const event = readAdvertisedUrlEvent(entry.data)
    if (!event) {
      return
    }
    for (const listener of advertisedUrlListeners) {
      listener(event)
    }
  })
}

function readAdvertisedUrlEvent(data: string): WorkspacePortAdvertisedUrlChangedEvent | null {
  let value: unknown
  try {
    const envelope = JSON.parse(data) as { payload?: unknown }
    value = envelope.payload
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const event = value as Record<string, unknown>
  if (typeof event.worktreeId !== 'string' || !Number.isInteger(event.port)) {
    return null
  }
  return { worktreeId: event.worktreeId, port: event.port as number }
}
