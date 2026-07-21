import { describe, expect, it, vi } from 'vitest'

const { requestRuntimeJsonMock } = vi.hoisted(() => ({ requestRuntimeJsonMock: vi.fn() }))
vi.mock('./pebble-tauri-runtime-transport', () => ({ requestRuntimeJson: requestRuntimeJsonMock }))

import { callTauriStatsRuntimeRpc } from './tauri-stats-runtime-rpc'

describe('callTauriStatsRuntimeRpc', () => {
  it('returns the persisted Go runtime summary', async () => {
    requestRuntimeJsonMock.mockResolvedValue({
      totalAgentsSpawned: 12,
      totalPRsCreated: 3,
      totalAgentTimeMs: 45_000,
      firstEventAt: 1_700_000_000_000
    })
    await expect(callTauriStatsRuntimeRpc('stats.summary')).resolves.toEqual({
      handled: true,
      result: {
        totalAgentsSpawned: 12,
        totalPRsCreated: 3,
        totalAgentTimeMs: 45_000,
        firstEventAt: 1_700_000_000_000
      }
    })
  })

  it('normalizes a fresh runtime first event to null', async () => {
    requestRuntimeJsonMock.mockResolvedValue({
      totalAgentsSpawned: 0,
      totalPRsCreated: 0,
      totalAgentTimeMs: 0
    })
    await expect(callTauriStatsRuntimeRpc('stats.summary')).resolves.toMatchObject({
      handled: true,
      result: { firstEventAt: null }
    })
  })
})
