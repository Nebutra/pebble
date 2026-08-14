import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPebbleClaudeUsageApi } from './tauri-claude-usage-api'
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

describe('createPebbleClaudeUsageApi', () => {
  beforeEach(() => request.mockReset())

  it('projects native turns into scoped canonical usage snapshots', async () => {
    request.mockResolvedValue({
      scanState: {
        enabled: true,
        isScanning: false,
        lastScanStartedAt: 1,
        lastScanCompletedAt: 2,
        lastScanError: null,
        hasAnyClaudeData: true
      },
      turns: [
        {
          sessionId: 's1',
          timestamp: `${usageFixtureDay}T10:00:00Z`,
          day: usageFixtureDay,
          model: 'claude-sonnet-4-6',
          projectKey: 'wt-1',
          projectLabel: 'Pebble',
          repoId: 'repo-1',
          worktreeId: 'wt-1',
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 50,
          cacheWriteTokens: 10
        },
        {
          sessionId: 's2',
          timestamp: `${usageFixtureDay}T11:00:00Z`,
          day: usageFixtureDay,
          model: 'claude-haiku-3',
          projectKey: '/outside',
          projectLabel: 'tmp/outside',
          inputTokens: 7,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        }
      ]
    })
    const snapshot = await createPebbleClaudeUsageApi().getSnapshot({
      scope: 'pebble',
      range: '30d'
    })
    expect(snapshot.summary).toMatchObject({
      sessions: 1,
      turns: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      topProject: 'Pebble',
      hasAnyClaudeData: true
    })
    expect(snapshot.daily).toEqual([
      {
        day: usageFixtureDay,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheWriteTokens: 10
      }
    ])
    expect(snapshot.recentSessions[0]).toMatchObject({
      sessionId: 's1',
      projectLabel: 'Pebble',
      turns: 1
    })
    expect(snapshot.summary.estimatedCostUsd).toBeCloseTo(0.000645)
  })
})
