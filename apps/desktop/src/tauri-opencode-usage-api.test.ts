import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPebbleOpenCodeUsageApi } from './tauri-opencode-usage-api'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: vi.fn(),
  requestRuntimeJson: vi.fn()
}))

const request = vi.mocked(requestRuntimeJson)

describe('createPebbleOpenCodeUsageApi', () => {
  beforeEach(() => request.mockReset())

  it('projects scoped native SQLite events and preserves provider cost', async () => {
    request.mockResolvedValue({
      scanState: {
        enabled: true,
        isScanning: false,
        lastScanStartedAt: 1,
        lastScanCompletedAt: 2,
        lastScanError: null,
        hasAnyOpenCodeData: true
      },
      events: [
        {
          sessionId: 's1',
          timestamp: '2026-07-15T10:00:00Z',
          day: '2026-07-15',
          model: 'openai/gpt-5.4',
          projectKey: 'worktree:wt-1',
          projectLabel: 'Pebble',
          worktreeId: 'wt-1',
          estimatedCostUsd: 0.25,
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          totalTokens: 125
        },
        {
          sessionId: 'outside',
          timestamp: '2026-07-15T11:00:00Z',
          day: '2026-07-15',
          projectKey: 'cwd:/tmp/outside',
          projectLabel: 'tmp/outside',
          estimatedCostUsd: null,
          inputTokens: 2,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0,
          totalTokens: 3
        }
      ]
    })

    const snapshot = await createPebbleOpenCodeUsageApi().getSnapshot({
      scope: 'pebble',
      range: '30d'
    })

    expect(snapshot.summary).toMatchObject({
      sessions: 1,
      events: 1,
      totalTokens: 125,
      estimatedCostUsd: 0.25,
      topModel: 'openai/gpt-5.4',
      topProject: 'Pebble',
      hasAnyOpenCodeData: true
    })
    expect(snapshot.modelBreakdown[0]).toMatchObject({ sessions: 1, estimatedCostUsd: 0.25 })
    expect(snapshot.recentSessions[0]).toMatchObject({ sessionId: 's1', events: 1 })
  })
})
