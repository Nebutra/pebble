import type { PreloadApi } from '../../../src/preload/api-types'
import type {
  SshConnectionState,
  SshConnectionStatus,
  SshTarget
} from '../../../src/shared/ssh-types'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-runtime-http-bridge'
import {
  clearSshCredential,
  seedSshCredentialFromSubmission,
  sshNeedsPassphrasePrompt,
  trackSshCredentialRequest
} from './tauri-ssh-credential-cache'

/** Runtime probe result mirroring go-runtime SshProbeResult. */
type SshProbeResult = {
  success: boolean
  error?: string
  status: string
}

type SshApi = NonNullable<Partial<PreloadApi>['ssh']>
type SshStateChangedEvent = Parameters<Parameters<PreloadApi['ssh']['onStateChanged']>[0]>[0]

const sshStateByTargetId = new Map<string, SshConnectionState>()
const sshStateListeners = new Set<(data: SshStateChangedEvent) => void>()

// Why: the SSH relay/port-forward/credential stack is not part of the embedded
// Go runtime yet. Keep remote execution explicit while still giving the UI real
// target CRUD, ~/.ssh/config import, bounded probes, and connection state.

async function listTargets(): Promise<SshTarget[]> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<SshTarget[]>('/v1/ssh-targets', { method: 'GET' })
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
  return requestRuntimeJson<SshTarget[]>('/v1/ssh-targets/import', { method: 'POST' })
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
    state: makeState(
      args.targetId,
      result.success ? 'connected' : normalizeProbeStatus(result.status),
      result.error ?? null
    )
  }
}

async function connect(args: { targetId: string }): Promise<SshConnectionState> {
  emitSshState(makeState(args.targetId, 'connecting', null))
  const result = await testConnection(args)
  const state =
    result.state ??
    makeState(
      args.targetId,
      result.success ? 'connected' : 'error',
      result.error ?? 'SSH connectivity probe failed.'
    )
  emitSshState(state)
  return state
}

async function disconnect(args: { targetId: string }): Promise<void> {
  // Electron parity: SshConnection.disconnect() drops its in-memory cached
  // passphrase/password, so the runtime-side cache is invalidated too.
  await clearSshCredential(args.targetId).catch(() => {})
  emitSshState(makeState(args.targetId, 'disconnected', null))
}

async function resetRelay(args: { targetId: string }): Promise<void> {
  // Tauri does not own a relay process yet; clearing state is the only honest local action.
  emitSshState(makeState(args.targetId, 'disconnected', null))
}

function getState(args: { targetId: string }): Promise<SshConnectionState | null> {
  return Promise.resolve(sshStateByTargetId.get(args.targetId) ?? null)
}

async function needsPassphrasePrompt(args: { targetId: string }): Promise<boolean> {
  const state = sshStateByTargetId.get(args.targetId)
  if (state?.status === 'connected' || state?.status === 'connecting') {
    return false
  }
  // Prompt gating consults the runtime's memory-only credential cache so a
  // target the user already unlocked this runtime lifetime never re-prompts;
  // the persisted lastRequiredPassphrase flag stays the unreachable fallback.
  return sshNeedsPassphrasePrompt(args.targetId, async () => {
    const targets = await listTargets()
    return targets.some(
      (candidate) => candidate.id === args.targetId && candidate.lastRequiredPassphrase === true
    )
  })
}

function onStateChanged(callback: (data: SshStateChangedEvent) => void): () => void {
  sshStateListeners.add(callback)
  return () => {
    sshStateListeners.delete(callback)
  }
}

function emitSshState(state: SshConnectionState): void {
  sshStateByTargetId.set(state.targetId, state)
  const event = { targetId: state.targetId, state }
  for (const listener of sshStateListeners) {
    listener(event)
  }
}

function makeState(
  targetId: string,
  status: SshConnectionStatus,
  error: string | null
): SshConnectionState {
  return { targetId, status, error, reconnectAttempt: 0 }
}

function normalizeProbeStatus(status: string): SshConnectionStatus {
  if (status === 'auth-failed' || status === 'reconnection-failed') {
    return status
  }
  if (status === 'connected' || status === 'connecting' || status === 'disconnected') {
    return status
  }
  return 'error'
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
    connect,
    disconnect,
    terminateSessions: () => Promise.resolve(),
    resetRelay,
    getState,
    needsPassphrasePrompt,
    onStateChanged,
    // Track prompt requests so a submitted credential can seed the runtime
    // cache; the base implementation still owns the actual prompt plumbing.
    onCredentialRequest: (callback) =>
      base.onCredentialRequest((data) => {
        trackSshCredentialRequest(data)
        callback(data)
      }),
    submitCredential: async (args: { requestId: string; value: string | null }) => {
      await base.submitCredential(args)
      await seedSshCredentialFromSubmission(args)
    }
  }
}
