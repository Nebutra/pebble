import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEnqueueResult,
  GitHubPRRefreshEvent,
  GitHubPRRefreshReason,
  PRInfo,
  PRRefreshOutcome
} from '../../../packages/product-core/shared/types'
import { fetchGitHubPRForBranch } from './tauri-provider-review-bridge'

type RuntimePostJson = <T>(
  path: string,
  options: { method: 'POST'; body?: unknown; timeoutMs?: number }
) => Promise<T>

type QueueEntry = {
  key: string
  candidate: GitHubPRRefreshCandidate
  aliases: Map<string, GitHubPRRefreshAlias>
  reason: GitHubPRRefreshReason
  priority: number
  dueAt: number
}

const MAX_CONCURRENT_REFRESHES = 2
const FRESH_BACKGROUND_AGE_MS = 60_000
const POST_PUSH_DELAY_MS = 2_500
const ERROR_BACKOFF_BASE_MS = 60_000
const ERROR_BACKOFF_MAX_MS = 15 * 60_000

export function createTauriGitHubPRRefreshCoordinator(requestJson: RuntimePostJson) {
  const listeners = new Set<(event: GitHubPRRefreshEvent) => void>()
  const queue = new Map<string, QueueEntry>()
  const visibleKeys = new Set<string>()
  const backoff = new Map<string, { failures: number; retryAt: number }>()
  let visibleGeneration = -1
  let sequence = 0
  let active = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const emit = (event: GitHubPRRefreshEvent): void => {
    for (const listener of listeners) {
      listener(event)
    }
  }

  const schedule = (): void => {
    if (timer || active >= MAX_CONCURRENT_REFRESHES || queue.size === 0) {
      return
    }
    const nextDueAt = Math.min(...Array.from(queue.values(), (entry) => entry.dueAt))
    timer = setTimeout(
      () => {
        timer = null
        void drain()
      },
      Math.max(0, nextDueAt - Date.now())
    )
  }

  const run = async (entry: QueueEntry): Promise<void> => {
    active += 1
    const requestSequence = ++sequence
    const aliases = Array.from(entry.aliases.values())
    const requestStartedAt = Date.now()
    emit({
      sequence: requestSequence,
      reason: entry.reason,
      aliases,
      status: 'in-flight',
      requestStartedAt
    })
    try {
      const pr = await fetchGitHubPRForBranch(requestJson, candidateLookupParams(entry.candidate))
      backoff.delete(entry.key)
      emit({
        sequence: requestSequence,
        reason: entry.reason,
        aliases,
        requestStartedAt,
        outcome: pr
          ? { kind: 'found', pr, fetchedAt: Date.now() }
          : { kind: 'no-pr', fetchedAt: Date.now() }
      })
    } catch (error) {
      const previous = backoff.get(entry.key)?.failures ?? 0
      const failures = previous + 1
      backoff.set(entry.key, {
        failures,
        retryAt:
          Date.now() + Math.min(ERROR_BACKOFF_MAX_MS, ERROR_BACKOFF_BASE_MS * 2 ** (failures - 1))
      })
      emit({
        sequence: requestSequence,
        reason: entry.reason,
        aliases,
        requestStartedAt,
        outcome: upstreamError(error)
      })
    } finally {
      active -= 1
      schedule()
    }
  }

  const drain = async (): Promise<void> => {
    while (active < MAX_CONCURRENT_REFRESHES) {
      const ready = Array.from(queue.values())
        .filter((entry) => entry.dueAt <= Date.now())
        .sort((left, right) => right.priority - left.priority || left.dueAt - right.dueAt)[0]
      if (!ready) {
        break
      }
      queue.delete(ready.key)
      void run(ready)
    }
    schedule()
  }

  const enqueue = async (args: {
    candidate: GitHubPRRefreshCandidate
    reason: GitHubPRRefreshReason
    priority?: number
  }): Promise<GitHubPRRefreshEnqueueResult | false> => {
    const skipped = validateCandidate(args.candidate)
    const alias = aliasFromCandidate(args.candidate)
    const requestSequence = ++sequence
    if (skipped) {
      emit({
        sequence: requestSequence,
        reason: args.reason,
        aliases: [alias],
        status: 'skipped',
        skippedReason: skipped
      })
      return false
    }
    if (isFreshBackground(args.candidate, args.reason)) {
      emit({
        sequence: requestSequence,
        reason: args.reason,
        aliases: [alias],
        status: 'skipped',
        skippedReason: 'fresh'
      })
      return { kind: 'skipped', skippedReason: 'validation-denied' }
    }
    const key = refreshKey(args.candidate)
    const existing = queue.get(key)
    const aliases = new Map(existing?.aliases ?? [])
    aliases.set(alias.cacheKey, alias)
    const backoffUntil = backoff.get(key)?.retryAt ?? 0
    const dueAt = Math.max(
      existing?.dueAt ?? 0,
      backoffUntil,
      args.reason === 'post-push' ? Date.now() + POST_PUSH_DELAY_MS : Date.now()
    )
    queue.set(key, {
      key,
      candidate: args.candidate,
      aliases,
      reason: strongerReason(existing?.reason, args.reason),
      priority: Math.max(existing?.priority ?? 0, args.priority ?? 0),
      dueAt
    })
    emit({
      sequence: requestSequence,
      reason: args.reason,
      aliases: Array.from(aliases.values()),
      status: 'queued'
    })
    schedule()
    return { kind: 'queued' }
  }

  return {
    prForBranch: (args: Parameters<typeof fetchGitHubPRForBranch>[1]): Promise<PRInfo | null> =>
      fetchGitHubPRForBranch(requestJson, args),
    refreshPRNow: async (args: {
      candidate: GitHubPRRefreshCandidate
    }): Promise<PRRefreshOutcome> => {
      try {
        const pr = await fetchGitHubPRForBranch(requestJson, candidateLookupParams(args.candidate))
        return pr
          ? { kind: 'found', pr, fetchedAt: Date.now() }
          : { kind: 'no-pr', fetchedAt: Date.now() }
      } catch (error) {
        return upstreamError(error)
      }
    },
    enqueuePRRefresh: enqueue,
    reportVisiblePRRefreshCandidates: async (args: {
      candidates: GitHubPRRefreshCandidate[]
      generation: number
    }): Promise<boolean> => {
      if (args.generation < visibleGeneration) {
        return false
      }
      visibleGeneration = args.generation
      visibleKeys.clear()
      for (const candidate of args.candidates) {
        visibleKeys.add(refreshKey(candidate))
      }
      for (const [key, entry] of queue) {
        if (entry.reason === 'visible' && !visibleKeys.has(key)) {
          queue.delete(key)
        }
      }
      for (const candidate of args.candidates) {
        await enqueue({ candidate, reason: 'visible', priority: 40 })
      }
      return true
    },
    onPRRefreshEvent: (callback: (event: GitHubPRRefreshEvent) => void): (() => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
}

function refreshKey(candidate: GitHubPRRefreshCandidate): string {
  return `${candidate.executionHostId ?? candidate.connectionId ?? 'local'}::${candidate.repoId}::${candidate.linkedPRNumber ?? candidate.branch}`
}

function aliasFromCandidate(candidate: GitHubPRRefreshCandidate): GitHubPRRefreshAlias {
  return {
    cacheKey: candidate.cacheKey,
    repoId: candidate.repoId,
    repoPath: candidate.repoPath,
    branch: candidate.branch,
    worktreeId: candidate.worktreeId,
    connectionId: candidate.connectionId,
    executionHostId: candidate.executionHostId,
    linkedPRNumber: candidate.linkedPRNumber,
    fallbackPRNumber: candidate.fallbackPRNumber,
    fallbackPRSource: candidate.fallbackPRSource
  }
}

function candidateLookupParams(candidate: GitHubPRRefreshCandidate): Record<string, unknown> {
  return {
    repo: candidate.repoId,
    worktreeId: candidate.worktreeId,
    branch: candidate.branch,
    linkedPRNumber: candidate.linkedPRNumber,
    fallbackPRNumber: candidate.fallbackPRNumber,
    acceptMergedFallbackPR:
      candidate.linkedPRNumber == null &&
      candidate.fallbackPRNumber != null &&
      candidate.fallbackPRSource != null,
    currentHeadOid: candidate.currentHeadOid
  }
}

function validateCandidate(
  candidate: GitHubPRRefreshCandidate
): 'not-git' | 'bare' | 'archived' | 'disconnected' | null {
  if (candidate.repoKind !== 'git') {
    return 'not-git'
  }
  if (candidate.isBare) {
    return 'bare'
  }
  if (candidate.isArchived) {
    return 'archived'
  }
  if (candidate.connectionId && candidate.connectionState !== 'connected') {
    return 'disconnected'
  }
  return null
}

function isFreshBackground(
  candidate: GitHubPRRefreshCandidate,
  reason: GitHubPRRefreshReason
): boolean {
  return (
    (reason === 'visible' || reason === 'swr') &&
    typeof candidate.cachedFetchedAt === 'number' &&
    Date.now() - candidate.cachedFetchedAt < FRESH_BACKGROUND_AGE_MS
  )
}

function strongerReason(
  current: GitHubPRRefreshReason | undefined,
  next: GitHubPRRefreshReason
): GitHubPRRefreshReason {
  const rank: Record<GitHubPRRefreshReason, number> = {
    visible: 1,
    swr: 2,
    active: 3,
    'post-push': 4,
    manual: 5
  }
  return !current || rank[next] > rank[current] ? next : current
}

function upstreamError(error: unknown): PRRefreshOutcome {
  return {
    kind: 'upstream-error',
    errorType: 'unknown',
    message: error instanceof Error ? error.message : String(error),
    fetchedAt: Date.now()
  }
}
