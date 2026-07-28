/**
 * Formats a remote-runtime transport failure so the user can tell a moved address apart
 * from a stopped runtime apart from a blocked network. Mirrors `describe_dial_failure` in
 * `apps/desktop/src-tauri/src/commands/remote_runtime_rpc.rs` so the desktop and Node
 * transports surface the same wording.
 */

// Why: `remote-runtime-tailscale-hint.ts` regex-matches this phrase, so detail is appended
// after a colon to keep the prefix byte-identical and the hint firing.
const DIAL_FAILURE_PREFIX = 'Could not connect to the remote Pebble runtime'

const CAUSE_BY_SYSCALL_CODE: Record<string, string> = {
  ECONNREFUSED: 'connection refused — the address is reachable but nothing is listening',
  EHOSTUNREACH: 'no route to host — the machine is not on this network',
  ENETUNREACH: 'no route to host — the machine is not on this network',
  ENETDOWN: 'no route to host — the machine is not on this network',
  ETIMEDOUT: 'timed out — no response from the address',
  ENOTFOUND: 'the address could not be resolved',
  EAI_AGAIN: 'the address could not be resolved'
}

function readSyscallCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

export function describeRemoteRuntimeDialCause(error: unknown): string {
  const code = readSyscallCode(error)
  const mapped = code ? CAUSE_BY_SYSCALL_CODE[code] : undefined
  if (mapped) {
    return mapped
  }
  // Why: Node's raw message ("connect ECONNREFUSED 10.0.0.4:6768") already names the cause
  // and carries no credential, so it is the best fallback for unmapped transport errors.
  if (error instanceof Error && error.message) {
    return error.message
  }
  return code ?? 'the connection failed'
}

/**
 * Produces `Could not connect to the remote Pebble runtime: <cause> (<endpoint>)`.
 * The endpoint is a bare `ws://host:port` URL and carries no credential; never interpolate
 * the device token here.
 */
export function describeRemoteRuntimeDialFailure(
  endpoint: string | null | undefined,
  error: unknown
): string {
  const cause = describeRemoteRuntimeDialCause(error)
  return endpoint
    ? `${DIAL_FAILURE_PREFIX}: ${cause} (${endpoint})`
    : `${DIAL_FAILURE_PREFIX}: ${cause}`
}
