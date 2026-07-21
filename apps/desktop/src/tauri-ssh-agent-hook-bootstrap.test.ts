import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureRuntimeMock, requestRuntimeJsonMock } = vi.hoisted(() => ({
  ensureRuntimeMock: vi.fn(),
  requestRuntimeJsonMock: vi.fn()
}))

vi.mock('./pebble-runtime-http-bridge', () => ({
  ensurePebbleRuntimeProcess: ensureRuntimeMock,
  requestRuntimeJson: requestRuntimeJsonMock
}))

import {
  bootstrapSshAgentHooks,
  installSshManagedAgentHooks,
  managedAgentHookWorkerScript
} from './tauri-ssh-agent-hook-bootstrap'

describe('bootstrapSshAgentHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requestRuntimeJsonMock.mockResolvedValue({
      success: true,
      status: 'installed'
    })
  })

  it('uses only the versioned purpose-scoped runtime route', async () => {
    await expect(bootstrapSshAgentHooks('ssh/a b', '#!/bin/sh\ntrue\n')).resolves.toEqual({
      success: true,
      status: 'installed'
    })
    expect(ensureRuntimeMock).toHaveBeenCalledOnce()
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/ssh-targets/ssh%2Fa%20b/agent-hooks/bootstrap',
      {
        method: 'POST',
        timeoutMs: 50_000,
        body: { version: 1, script: '#!/bin/sh\ntrue\n' }
      }
    )
  })

  it('invokes only the relay worker managed-hook subcommand', async () => {
    const script = managedAgentHookWorkerScript()
    expect(script).toContain('command -v pebble-relay-worker')
    expect(script).toContain('agent-hooks-install --home "$HOME"')
    expect(script).not.toContain('eval ')

    await installSshManagedAgentHooks('ssh-1')
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/ssh-targets/ssh-1/agent-hooks/bootstrap',
      expect.objectContaining({ body: { version: 1, script } })
    )
  })
})
