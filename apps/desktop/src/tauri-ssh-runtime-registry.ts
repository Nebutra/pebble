import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  SshConnectionState,
  PortForwardEntry,
  EnrichedDetectedPort
} from '../../../packages/product-core/shared/ssh-types'

export type SshApi = NonNullable<Partial<PreloadApi>['ssh']>
export type SshStateChangedEvent = Parameters<Parameters<PreloadApi['ssh']['onStateChanged']>[0]>[0]
export type SshCredentialRequestEvent = Parameters<
  Parameters<PreloadApi['ssh']['onCredentialRequest']>[0]
>[0]
export type SshCredentialResolvedEvent = Parameters<
  Parameters<PreloadApi['ssh']['onCredentialResolved']>[0]
>[0]

// Why: SSH lifecycle is native Go/system-OpenSSH now; these renderer-lifetime
// collections back the adapter without any Electron IPC dependency.
export const sshStateByTargetId = new Map<string, SshConnectionState>()
export const sshStateListeners = new Set<(data: SshStateChangedEvent) => void>()
export const resetRelayByTargetId = new Map<string, Promise<void>>()
export const portForwardListeners = new Set<
  (data: { targetId: string; forwards: PortForwardEntry[] }) => void
>()
export const detectedPortListeners = new Set<
  (data: { targetId: string; ports: EnrichedDetectedPort[] }) => void
>()
export const detectedPortPollers = new Map<string, ReturnType<typeof setInterval>>()
export const credentialRequestListeners = new Set<(data: SshCredentialRequestEvent) => void>()
export const credentialResolvedListeners = new Set<(data: SshCredentialResolvedEvent) => void>()
export const pendingCredentials = new Map<
  string,
  { resolve: (value: string | null) => void; timeout: ReturnType<typeof setTimeout> }
>()
export const CREDENTIAL_TIMEOUT_MS = 120_000
