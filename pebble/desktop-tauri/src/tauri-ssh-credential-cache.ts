import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-runtime-http-bridge'

/** Mirrors go-runtime SshCredentialStatus: booleans only, never the secret. */
export type SshCredentialStatus = {
  cached: boolean
  promptRequired: boolean
}

export type SshCredentialKind = 'passphrase' | 'password'

function credentialRoute(targetId: string): string {
  return `/v1/ssh-targets/${encodeURIComponent(targetId)}/credential`
}

export async function fetchSshCredentialStatus(targetId: string): Promise<SshCredentialStatus> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<SshCredentialStatus>(credentialRoute(targetId), { method: 'GET' })
}

/** Seed the runtime's memory-only credential cache after a successful prompt so
 *  auto-connect gating (needsPassphrasePrompt) stops re-prompting. Best-effort:
 *  a seeding failure must never fail the prompt flow that already succeeded. */
export async function seedSshCredential(
  targetId: string,
  kind: SshCredentialKind,
  value: string
): Promise<void> {
  await ensurePebbleRuntimeProcess()
  await requestRuntimeJson<SshCredentialStatus>(credentialRoute(targetId), {
    method: 'POST',
    body: { kind, value }
  })
}

/** Explicit invalidation: called on disconnect and auth failure, matching
 *  Electron SshConnection.disconnect() nulling its cached credential. */
export async function clearSshCredential(targetId: string): Promise<void> {
  await ensurePebbleRuntimeProcess()
  await requestRuntimeJson<SshCredentialStatus>(credentialRoute(targetId), { method: 'DELETE' })
}

// Prompt flows resolve credentials by requestId (ssh.submitCredential), so the
// bridge tracks requestId -> target/kind from onCredentialRequest to know where
// a submitted value should be seeded. Values themselves are never stored here.
const pendingCredentialRequests = new Map<string, { targetId: string; kind: SshCredentialKind }>()

export function trackSshCredentialRequest(data: {
  requestId: string
  targetId: string
  kind: SshCredentialKind
}): void {
  pendingCredentialRequests.set(data.requestId, { targetId: data.targetId, kind: data.kind })
}

export async function seedSshCredentialFromSubmission(args: {
  requestId: string
  value: string | null
}): Promise<void> {
  const pending = pendingCredentialRequests.get(args.requestId)
  pendingCredentialRequests.delete(args.requestId)
  // A cancelled prompt (null value) must not poison the cache.
  if (!pending || args.value == null || args.value === '') {
    return
  }
  await seedSshCredential(pending.targetId, pending.kind, args.value).catch(() => {
    // Why: seeding is an optimization; the credential already reached the
    // consumer. Swallow (never log) so the secret cannot leak via errors.
  })
}

/** Electron ssh:needsPassphrasePrompt parity: prompt only when the target has
 *  historically required a passphrase AND no credential is cached runtime-side. */
export async function sshNeedsPassphrasePrompt(
  targetId: string,
  fallbackLastRequiredPassphrase: () => Promise<boolean>
): Promise<boolean> {
  try {
    const status = await fetchSshCredentialStatus(targetId)
    if (typeof status.promptRequired !== 'boolean') {
      throw new Error('malformed credential status')
    }
    return status.promptRequired
  } catch {
    // Why: if the runtime cache route is unreachable, fall back to the persisted
    // flag alone — a surprising prompt beats silently auto-firing a connect.
    return fallbackLastRequiredPassphrase().catch(() => false)
  }
}
