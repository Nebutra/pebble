import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPebbleClaudeUsageApi } from './tauri-claude-usage-api'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: vi.fn(),
  requestRuntimeJson: vi.fn()
}))
const request = vi.mocked(requestRuntimeJson)

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
          timestamp: '2026-07-15T10:00:00Z',
          day: '2026-07-15',
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
          timestamp: '2026-07-15T11:00:00Z',
          day: '2026-07-15',
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
        day: '2026-07-15',
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
