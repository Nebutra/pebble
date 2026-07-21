import { detectAgentStatusFromTitle, isClaudeAgent } from '@/lib/agent-status'

export function shouldSeedCacheTimerOnInitialTitle(args: {
  rawTitle: string
  allowInitialIdleSeed: boolean
  existingTimerStartedAt: number | null | undefined
  promptCacheTimerEnabled: boolean | null
}): boolean {
  const { rawTitle, allowInitialIdleSeed, existingTimerStartedAt, promptCacheTimerEnabled } = args

  if (!allowInitialIdleSeed || !isClaudeAgent(rawTitle)) {
    return false
  }

  const status = detectAgentStatusFromTitle(rawTitle)
  if (status === null || status === 'working') {
    return false
  }

  if (existingTimerStartedAt != null) {
    return false
  }

  // Why: the initial idle-title seed exists only for PTYs reattached during
  // session restore. Fresh Claude launches also start idle before the first
  // prompt, but no server-side prompt cache exists yet, so showing a TTL
  // countdown there is incorrect.
  return promptCacheTimerEnabled !== false
}
