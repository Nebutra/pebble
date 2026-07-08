import { createHash } from 'node:crypto'

export function hashRelayInstanceId(relayInstanceId: string): string {
  // Why: Pebble's longer remote directory name can push macOS Unix socket
  // paths over sun_path; 12 hex chars keeps per-target sockets compact.
  return createHash('sha256').update(relayInstanceId).digest('hex').slice(0, 12)
}

export function relaySocketNameForInstanceId(relayInstanceId: string | undefined): string {
  return relayInstanceId ? `relay-${hashRelayInstanceId(relayInstanceId)}.sock` : 'relay.sock'
}
