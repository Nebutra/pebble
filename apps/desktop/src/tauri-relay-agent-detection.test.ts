import { describe, expect, it, vi } from 'vitest'

import { readRelayDetectedRemoteAgents } from './tauri-relay-agent-detection'

describe('readRelayDetectedRemoteAgents', () => {
  it('reads the relay-fed detection for the connection host id', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      hostId: 'host-1',
      agents: ['claude', 'codex', 'claude', 7]
    })
    const agents = await readRelayDetectedRemoteAgents(fetcher, 'host-1')
    expect(agents).toEqual(['claude', 'codex'])
    expect(fetcher).toHaveBeenCalledWith(
      '/v1/remote-hosts/agent-detections?hostId=host-1',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('encodes host ids in the query string', async () => {
    const fetcher = vi.fn().mockResolvedValue({ agents: [] })
    await readRelayDetectedRemoteAgents(fetcher, 'host/with spaces')
    expect(fetcher).toHaveBeenCalledWith(
      '/v1/remote-hosts/agent-detections?hostId=host%2Fwith%20spaces',
      expect.anything()
    )
  })

  it('returns an empty list when no relay probe exists (runtime 404)', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('404'))
    await expect(readRelayDetectedRemoteAgents(fetcher, 'host-1')).resolves.toEqual([])
  })

  it('returns an empty list for blank connection ids without fetching', async () => {
    const fetcher = vi.fn()
    await expect(readRelayDetectedRemoteAgents(fetcher, '  ')).resolves.toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('ignores malformed detection payloads', async () => {
    const fetcher = vi.fn().mockResolvedValue({ agents: 'claude' })
    await expect(readRelayDetectedRemoteAgents(fetcher, 'host-1')).resolves.toEqual([])
  })
})
