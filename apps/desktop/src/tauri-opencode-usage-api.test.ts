import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPebbleOpenCodeUsageApi } from './tauri-opencode-usage-api'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: vi.fn(),
  requestRuntimeJson: vi.fn()
}))

const request = vi.mocked(requestRuntimeJson)
// Why: these fixtures pinned a literal day and asserted it fell inside a "30d"
// range. That is true only until the day is 30 days old — on 2026-08-14 the
// 2026-07-15 fixture aged out and every desktop build failed at once. Anchor the
// fixture to the run instead, so it stays inside the window it is asserting on.
const usageFixtureDay = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

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
          timestamp: `${usageFixtureDay}T10:00:00Z`,
          day: usageFixtureDay,
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
          timestamp: `${usageFixtureDay}T11:00:00Z`,
          day: usageFixtureDay,
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
