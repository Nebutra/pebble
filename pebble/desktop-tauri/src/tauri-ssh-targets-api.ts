import type { PreloadApi } from '../../../src/preload/api-types'
import type { SshConnectionState, SshTarget } from '../../../src/shared/ssh-types'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-runtime-http-bridge'

/** Runtime probe result mirroring go-runtime SshProbeResult. */
type SshProbeResult = {
  success: boolean
  error?: string
  status: string
}

type SshApi = NonNullable<Partial<PreloadApi>['ssh']>

// Why: the SSH relay/connect/port-forward/credential stack is not part of the
// embedded Go runtime, so those methods stay explicitly unsupported rather than
// silently pretending to connect. AGENTS.md mandates the SSH use case, so the
// durable pieces the desktop needs — target CRUD, ~/.ssh/config import, and a
// bounded connectivity probe — are implemented natively against the runtime.
const RELAY_UNSUPPORTED =
  'SSH relay sessions are not available in the Tauri shell yet; only target management and connectivity checks are supported.'

async function listTargets(): Promise<SshTarget[]> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<SshTarget[]>('/v1/ssh-targets', { method: 'GET' }).catch(() => [])
}

async function addTarget(args: { target: Omit<SshTarget, 'id'> }): Promise<SshTarget> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<SshTarget>('/v1/ssh-targets', {
    method: 'POST',
    body: args.target
  })
}

async function updateTarget(args: {
  id: string
  updates: Partial<Omit<SshTarget, 'id'>>
}): Promise<SshTarget> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<SshTarget>(`/v1/ssh-targets/${encodeURIComponent(args.id)}`, {
    method: 'PATCH',
    body: args.updates
  })
}

async function removeTarget(args: { id: string }): Promise<void> {
  await ensurePebbleRuntimeProcess()
  await requestRuntimeJson<SshTarget>(`/v1/ssh-targets/${encodeURIComponent(args.id)}`, {
    method: 'DELETE'
  })
}

async function importConfig(): Promise<SshTarget[]> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<SshTarget[]>('/v1/ssh-targets/import', { method: 'POST' }).catch(
    () => []
  )
}

async function testConnection(args: {
  targetId: string
}): Promise<{ success: boolean; error?: string; state?: SshConnectionState }> {
  await ensurePebbleRuntimeProcess()
  // The probe is bounded and non-interactive (BatchMode=yes) on the runtime; a
  // failure returns { success: false, error } rather than throwing.
  const result = await requestRuntimeJson<SshProbeResult>(
    `/v1/ssh-targets/${encodeURIComponent(args.targetId)}/probe`,
    { method: 'POST', timeoutMs: 15_000 }
  ).catch((error: unknown) => ({
    success: false,
    status: 'error',
    error: error instanceof Error ? error.message : String(error)
  }))
  return {
    success: result.success,
    ...(result.error ? { error: result.error } : {}),
    state: {
      targetId: args.targetId,
      status: result.success ? 'connected' : (result.status as SshConnectionState['status']),
      error: result.error ?? null,
      reconnectAttempt: 0
    }
  }
}

/** Overlay the natively-supported SSH methods onto the web base so relay flows
 *  keep their existing explicit-unsupported behavior. */
export function createPebbleSshApi(base: SshApi): SshApi {
  return {
    ...base,
    listTargets,
    addTarget,
    updateTarget,
    removeTarget,
    importConfig,
    testConnection,
    connect: () => Promise.reject(new Error(RELAY_UNSUPPORTED)),
    disconnect: () => Promise.resolve(),
    terminateSessions: () => Promise.resolve(),
    resetRelay: () => Promise.resolve(),
    getState: () => Promise.resolve(null),
    needsPassphrasePrompt: () => Promise.resolve(false)
  }
}
