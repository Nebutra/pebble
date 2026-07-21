import { describe, expect, it } from 'vitest'
import { nextRuntimePollDelay } from './runtime-poll-backoff'

describe('runtime PTY output fallback polling', () => {
  it('backs off quickly while capping terminal echo latency', () => {
    expect(nextRuntimePollDelay(16, 16, 250)).toBe(32)
    expect(nextRuntimePollDelay(128, 16, 250)).toBe(250)
    expect(nextRuntimePollDelay(250, 16, 250)).toBe(250)
  })
})
