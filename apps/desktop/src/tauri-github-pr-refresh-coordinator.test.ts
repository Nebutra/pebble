import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEvent
} from '../../../packages/product-core/shared/types'
import { createTauriGitHubPRRefreshCoordinator } from './tauri-github-pr-refresh-coordinator'

function candidate(overrides: Partial<GitHubPRRefreshCandidate> = {}): GitHubPRRefreshCandidate {
  return {
    cacheKey: 'cache-1',
    repoKind: 'git',
    repoId: 'repo-1',
    repoPath: '/repo',
    branch: 'feature',
    worktreeId: 'wt-1',
    connectionState: 'connected',
    ...overrides
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Tauri GitHub PR refresh coordinator', () => {
  it('rejects invalid candidates and emits the canonical skipped event', async () => {
    const requestJson = vi.fn()
    const coordinator = createTauriGitHubPRRefreshCoordinator(requestJson)
    const events: GitHubPRRefreshEvent[] = []
    coordinator.onPRRefreshEvent((event) => events.push(event))

    await expect(
      coordinator.enqueuePRRefresh({
        candidate: candidate({ repoKind: 'folder' }),
        reason: 'active',
        priority: 80
      })
    ).resolves.toBe(false)
    expect(requestJson).not.toHaveBeenCalled()
    expect(events).toEqual([
      expect.objectContaining({ status: 'skipped', skippedReason: 'not-git', reason: 'active' })
    ])
  })

  it('coalesces aliases and broadcasts one native lookup outcome', async () => {
    vi.useFakeTimers()
    const requestJson = vi.fn().mockResolvedValue({
      pr: { number: 42, title: 'Fix', state: 'open', url: 'https://x/42' }
    })
    const coordinator = createTauriGitHubPRRefreshCoordinator(requestJson)
    const events: GitHubPRRefreshEvent[] = []
    coordinator.onPRRefreshEvent((event) => events.push(event))

    await coordinator.enqueuePRRefresh({ candidate: candidate(), reason: 'visible', priority: 40 })
    await coordinator.enqueuePRRefresh({
      candidate: candidate({ cacheKey: 'cache-2', worktreeId: 'wt-2' }),
      reason: 'active',
      priority: 80
    })
    await vi.runAllTimersAsync()

    expect(requestJson).toHaveBeenCalledTimes(1)
    const outcome = events.find((event) => 'outcome' in event)
    expect(outcome).toMatchObject({ reason: 'active', outcome: { kind: 'found' } })
    expect(outcome?.aliases.map((alias) => alias.cacheKey)).toEqual(['cache-1', 'cache-2'])
  })

  it('delays post-push refreshes and ignores stale visible generations', async () => {
    vi.useFakeTimers()
    const requestJson = vi.fn().mockResolvedValue({ pr: null })
    const coordinator = createTauriGitHubPRRefreshCoordinator(requestJson)

    await coordinator.enqueuePRRefresh({
      candidate: candidate(),
      reason: 'post-push',
      priority: 90
    })
    await vi.advanceTimersByTimeAsync(2_499)
    expect(requestJson).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(requestJson).toHaveBeenCalledTimes(1)

    await expect(
      coordinator.reportVisiblePRRefreshCandidates({ candidates: [], generation: 10 })
    ).resolves.toBe(true)
    await expect(
      coordinator.reportVisiblePRRefreshCandidates({ candidates: [candidate()], generation: 9 })
    ).resolves.toBe(false)
  })
})
