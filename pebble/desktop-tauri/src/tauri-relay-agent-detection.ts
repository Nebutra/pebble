type RuntimeJsonFetcher = <T>(
  path: string,
  options: { method: 'GET'; timeoutMs?: number }
) => Promise<T>

// The detection is a cached snapshot the relay worker already posted, so the
// read is a local runtime lookup; keep the bound tight.
const RELAY_AGENT_DETECTION_TIMEOUT_MS = 3000

/**
 * Read the relay-fed remote agent detection for an SSH connection.
 *
 * Relay-only SSH connections (a relay worker but no paired runtime
 * environment) cannot answer `preflight.detectAgents` over runtime-environment
 * RPC. The Go runtime caches the `pebble-relay-worker agent-detect` PATH probe
 * per host id — and for SSH projects the connection id is the host id — so
 * this fallback preserves Electron's detectRemoteAgents contract. Returns an
 * empty list when no relay probe has been posted for the host.
 */
export async function readRelayDetectedRemoteAgents(
  fetchRuntimeJson: RuntimeJsonFetcher,
  connectionId: string
): Promise<string[]> {
  const hostId = connectionId.trim()
  if (!hostId) {
    return []
  }
  try {
    const detection = await fetchRuntimeJson<{ agents?: unknown }>(
      `/v1/remote-hosts/agent-detections?hostId=${encodeURIComponent(hostId)}`,
      { method: 'GET', timeoutMs: RELAY_AGENT_DETECTION_TIMEOUT_MS }
    )
    if (!Array.isArray(detection.agents)) {
      return []
    }
    return [...new Set(detection.agents.filter((entry): entry is string => typeof entry === 'string'))]
  } catch {
    return []
  }
}
