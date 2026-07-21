import { trackSshCredentialRequest } from './tauri-ssh-credential-cache'
import {
  credentialRequestListeners,
  credentialResolvedListeners,
  pendingCredentials,
  CREDENTIAL_TIMEOUT_MS
} from './tauri-ssh-runtime-registry'

export function requestSshCredential(
  targetId: string,
  kind: 'passphrase' | 'password',
  detail: string
): Promise<string | null> {
  const requestId = crypto.randomUUID()
  return new Promise((resolve) => {
    const timeout = setTimeout(
      () => resolvePendingCredential(requestId, null),
      CREDENTIAL_TIMEOUT_MS
    )
    pendingCredentials.set(requestId, { resolve, timeout })
    const event = { requestId, targetId, kind, detail }
    trackSshCredentialRequest(event)
    for (const listener of credentialRequestListeners) {
      listener(event)
    }
  })
}

export function resolvePendingCredential(requestId: string, value: string | null): void {
  const pending = pendingCredentials.get(requestId)
  if (!pending) {
    return
  }
  pendingCredentials.delete(requestId)
  clearTimeout(pending.timeout)
  pending.resolve(value)
  for (const listener of credentialResolvedListeners) {
    listener({ requestId })
  }
}
