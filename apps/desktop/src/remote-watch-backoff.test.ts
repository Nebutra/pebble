import { describe, expect, it } from 'vitest'
import { remoteWatchRetryDelayMs } from './remote-watch-backoff'

describe('remoteWatchRetryDelayMs', () => {
  it('recovers a short outage quickly', () => {
    expect(remoteWatchRetryDelayMs(0)).toBe(1_000)
    expect(remoteWatchRetryDelayMs(1)).toBe(2_000)
    expect(remoteWatchRetryDelayMs(3)).toBe(8_000)
  })

  it('caps a long outage so reconnect fan-out stays bounded', () => {
    expect(remoteWatchRetryDelayMs(5)).toBe(30_000)
    expect(remoteWatchRetryDelayMs(64)).toBe(30_000)
    expect(remoteWatchRetryDelayMs(Number.POSITIVE_INFINITY)).toBe(1_000)
  })

  it('treats a missing or negative attempt as the first one', () => {
    expect(remoteWatchRetryDelayMs(-1)).toBe(1_000)
    expect(remoteWatchRetryDelayMs(Number.NaN)).toBe(1_000)
  })
})
