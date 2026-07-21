import type {
  SshConnectionState,
  SshConnectionStatus,
  SshTarget
} from '../../../packages/product-core/shared/ssh-types'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-runtime-http-bridge'
import {
  clearSshCredential,
  seedSshCredentialFromSubmission,
  sshNeedsPassphrasePrompt,
  trackSshCredentialRequest
} from './tauri-ssh-credential-cache'
import { installSshManagedAgentHooks } from './tauri-ssh-agent-hook-bootstrap'
import {
  type SshApi,
  type SshStateChangedEvent,
  sshStateByTargetId,
  sshStateListeners,
  resetRelayByTargetId,
  portForwardListeners,
  detectedPortListeners,
  detectedPortPollers,
  credentialRequestListeners,
  credentialResolvedListeners
} from './tauri-ssh-runtime-registry'
import {
  restorePortForwards,
  terminatePortForwards,
  addPortForward,
  updatePortForward,
  removePortForward,
  listPortForwards,
  listDetectedPorts,
  startDetectedPortPolling,
  stopDetectedPortPolling
} from './tauri-ssh-port-forward-runtime'
import { requestSshCredential, resolvePendingCredential } from './tauri-ssh-credential-prompt'

/** Runtime probe result mirroring go-runtime SshProbeResult. */
type SshProbeResult = {
  success: boolean
  error?: string
  status: string
}

// Why: SSH lifecycle is native Go/system-OpenSSH now; keep the adapter aligned
// with the renderer contract while remaining independent of Electron IPC.

export async function listTargets(): Promise<SshTarget[]> {
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
  // Why: Go atomically tears down target-owned sessions and forwards before
  // deletion; discard renderer-lifetime state only after that succeeds.
  stopDetectedPortPolling(args.id)
  sshStateByTargetId.delete(args.id)
}

async function importConfig(): Promise<SshTarget[]> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<SshTarget[]>('/v1/ssh-targets/import', {
    method: 'POST'
  })
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
  let prompted = false
  let finalResult = result
  if (!result.success && result.state?.status === 'auth-failed') {
    const targetResult = await listTargets().catch(() => [])
    const targets = Array.isArray(targetResult) ? targetResult : []
    const target = targets.find((candidate) => candidate.id === args.targetId)
    if (target) {
      const kind = target.identityFile ? 'passphrase' : 'password'
      const detail = target.identityFile || target.host || target.label
      const credential = await requestSshCredential(args.targetId, kind, detail)
      if (credential === null) {
        const cancelled = makeState(args.targetId, 'disconnected', null)
        emitSshState(cancelled)
        return cancelled
      }
      prompted = true
      finalResult = await testConnection(args)
      if (!finalResult.success) {
        await clearSshCredential(args.targetId).catch(() => {})
      }
    }
  }
  const state =
    finalResult.state ??
    makeState(
      args.targetId,
      finalResult.success ? 'connected' : 'error',
      finalResult.error ?? 'SSH connectivity probe failed.'
    )
  emitSshState(state)
  if (state.status === 'connected') {
    await updateTarget({
      id: args.targetId,
      updates: { lastRequiredPassphrase: prompted }
    }).catch(() => {})
    // Why: Electron treats remote hook installation as best effort; a broken
    // agent config must not take the SSH workspace itself offline.
    void installSshManagedAgentHooks(args.targetId).catch(() => {})
    // Why: saved forwards are durable configuration, but their ssh processes
    // are runtime-local and must be recreated after a reconnect or app launch.
    void restorePortForwards(args.targetId).catch(() => {})
    startDetectedPortPolling(args.targetId)
  }
  return state
}

async function disconnect(args: { targetId: string }): Promise<void> {
  // Electron parity: SshConnection.disconnect() drops its in-memory cached
  // passphrase/password, so the runtime-side cache is invalidated too.
  await Promise.all([
    clearSshCredential(args.targetId).catch(() => {}),
    terminatePortForwards(args.targetId).catch(() => {})
  ])
  stopDetectedPortPolling(args.targetId)
  emitSshState(makeState(args.targetId, 'disconnected', null))
}

async function resetRelay(args: { targetId: string }): Promise<void> {
  const active = resetRelayByTargetId.get(args.targetId)
  if (active) {
    return active
  }
  const reset = (async () => {
    await Promise.all([terminateSessions(args), terminatePortForwards(args.targetId)])
    await clearSshCredential(args.targetId).catch(() => {})
    emitSshState(makeState(args.targetId, 'disconnected', null))
  })().finally(() => {
    if (resetRelayByTargetId.get(args.targetId) === reset) {
      resetRelayByTargetId.delete(args.targetId)
    }
  })
  resetRelayByTargetId.set(args.targetId, reset)
  return reset
}

async function terminateSessions(args: { targetId: string }): Promise<void> {
  const result = await requestRuntimeJson<{ failedIds?: string[] }>(
    `/v1/ssh-targets/${encodeURIComponent(args.targetId)}/sessions/terminate`,
    { method: 'POST', timeoutMs: 15_000 }
  )
  if (result.failedIds?.length) {
    throw new Error(`Could not terminate remote sessions: ${result.failedIds.join(', ')}`)
  }
}

async function browseDir(args: { targetId: string; dirPath: string }): Promise<{
  entries: { name: string; isDirectory: boolean }[]
  resolvedPath: string
}> {
  return requestRuntimeJson(`/v1/ssh-targets/${encodeURIComponent(args.targetId)}/browse`, {
    method: 'POST',
    body: { path: args.dirPath },
    timeoutMs: 20_000
  })
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
    terminateSessions,
    resetRelay,
    getState,
    needsPassphrasePrompt,
    onStateChanged,
    addPortForward,
    updatePortForward,
    removePortForward,
    listPortForwards,
    listDetectedPorts,
    onPortForwardsChanged: (callback) => {
      portForwardListeners.add(callback)
      return () => portForwardListeners.delete(callback)
    },
    onDetectedPortsChanged: (callback) => {
      detectedPortListeners.add(callback)
      for (const [targetId, state] of sshStateByTargetId) {
        if (state.status === 'connected') {
          startDetectedPortPolling(targetId)
        }
      }
      return () => {
        detectedPortListeners.delete(callback)
        if (detectedPortListeners.size === 0) {
          for (const targetId of detectedPortPollers.keys()) {
            stopDetectedPortPolling(targetId)
          }
        }
      }
    },
    browseDir,
    onCredentialRequest: (callback) => {
      credentialRequestListeners.add(callback)
      const unsubscribeBase = base.onCredentialRequest((data) => {
        trackSshCredentialRequest(data)
        callback(data)
      })
      return () => {
        credentialRequestListeners.delete(callback)
        unsubscribeBase()
      }
    },
    onCredentialResolved: (callback) => {
      credentialResolvedListeners.add(callback)
      const unsubscribeBase = base.onCredentialResolved(callback)
      return () => {
        credentialResolvedListeners.delete(callback)
        unsubscribeBase()
      }
    },
    submitCredential: async (args: { requestId: string; value: string | null }) => {
      await base.submitCredential(args)
      await seedSshCredentialFromSubmission(args)
      resolvePendingCredential(args.requestId, args.value)
    }
  }
}
