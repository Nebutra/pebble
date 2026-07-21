import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPebbleCodexUsageApi } from './tauri-codex-usage-api'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: vi.fn(),
  requestRuntimeJson: vi.fn()
}))

const request = vi.mocked(requestRuntimeJson)

describe('createPebbleCodexUsageApi', () => {
  beforeEach(() => request.mockReset())

  it('projects native events into scoped canonical usage snapshots', async () => {
    request.mockResolvedValue({
      scanState: {
        enabled: true,
        isScanning: false,
        lastScanStartedAt: 1,
        lastScanCompletedAt: 2,
        lastScanError: null,
        hasAnyCodexData: true
      },
      events: [
        {
          sessionId: 's1',
          timestamp: '2026-07-15T10:00:00Z',
          day: '2026-07-15',
          model: 'gpt-5.4',
          projectKey: 'worktree:wt-1',
          projectLabel: 'Pebble',
          repoId: 'repo-1',
          worktreeId: 'wt-1',
          hasInferredPricing: false,
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          totalTokens: 120
        },
        {
          sessionId: 's2',
          timestamp: '2026-07-15T11:00:00Z',
          day: '2026-07-15',
          projectKey: 'cwd:/tmp/outside',
          projectLabel: 'tmp/outside',
          hasInferredPricing: true,
          inputTokens: 7,
          cachedInputTokens: 0,
          outputTokens: 3,
          reasoningOutputTokens: 0,
          totalTokens: 10
        }
      ]
    })

    const snapshot = await createPebbleCodexUsageApi().getSnapshot({
      scope: 'pebble',
      range: '30d'
    })

    expect(snapshot.summary).toMatchObject({
      sessions: 1,
      events: 1,
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      totalTokens: 120,
      topModel: 'gpt-5.4',
      topProject: 'Pebble',
      hasAnyCodexData: true
    })
    expect(snapshot.summary.estimatedCostUsd).toBeCloseTo(0.00046, 8)
    expect(snapshot.daily).toEqual([
      {
        day: '2026-07-15',
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 120
      }
    ])
    expect(snapshot.recentSessions[0]).toMatchObject({
      sessionId: 's1',
      projectLabel: 'Pebble',
      events: 1
    })
  })

  it('preserves inferred pricing in project and session projections', async () => {
    request.mockResolvedValue({
      scanState: {
        enabled: true,
        isScanning: false,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null,
        hasAnyCodexData: true
      },
      events: [
        {
          sessionId: 'unknown-model',
          timestamp: '2026-07-15T10:00:00Z',
          day: '2026-07-15',
          projectKey: 'worktree:wt-1',
          projectLabel: 'Pebble',
          worktreeId: 'wt-1',
          hasInferredPricing: true,
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0,
          totalTokens: 2
        }
      ]
    })

    const snapshot = await createPebbleCodexUsageApi().getSnapshot({
      scope: 'all',
      range: 'all'
    })
    expect(snapshot.modelBreakdown[0].hasInferredPricing).toBe(true)
    expect(snapshot.projectBreakdown[0].hasInferredPricing).toBe(true)
    expect(snapshot.recentSessions[0].hasInferredPricing).toBe(true)
  })
})
