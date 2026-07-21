import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-runtime-http-bridge'

export type SshAgentHookBootstrapResult = {
  success: boolean
  status: string
  output?: string
  error?: string
}

export async function bootstrapSshAgentHooks(
  targetId: string,
  script: string
): Promise<SshAgentHookBootstrapResult> {
  await ensurePebbleRuntimeProcess()
  // Why: the runtime endpoint is purpose-scoped and versioned so this bridge
  // cannot silently become an arbitrary remote-command API.
  return requestRuntimeJson<SshAgentHookBootstrapResult>(
    `/v1/ssh-targets/${encodeURIComponent(targetId)}/agent-hooks/bootstrap`,
    {
      method: 'POST',
      timeoutMs: 50_000,
      body: { version: 1, script }
    }
  )
}

export function managedAgentHookWorkerScript(): string {
  return `#!/bin/sh
set -eu
worker="\${PEBBLE_RELAY_WORKER:-}"
if [ -z "$worker" ]; then worker=$(command -v pebble-relay-worker || true); fi
if [ -z "$worker" ] || [ ! -x "$worker" ]; then
  printf '%s\n' 'pebble-relay-worker is not installed on the SSH host' >&2
  exit 127
fi
exec "$worker" agent-hooks-install --home "$HOME"
`
}

export function installSshManagedAgentHooks(
  targetId: string
): Promise<SshAgentHookBootstrapResult> {
  return bootstrapSshAgentHooks(targetId, managedAgentHookWorkerScript())
}
