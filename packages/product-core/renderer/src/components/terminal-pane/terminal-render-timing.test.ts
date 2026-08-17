import { beforeEach, describe, expect, it } from 'vitest'
import {
  recordRenderTiming,
  resetRenderTimingForTests,
  summariseRenderTiming
} from './terminal-render-timing'

describe('terminal render timing', () => {
  beforeEach(() => resetRenderTimingForTests())

  it('reports nothing before anything was measured', () => {
    expect(summariseRenderTiming('chunk')).toBeNull()
  })

  it('separates a fast median from a slow tail', () => {
    // Why: the tail is the interesting part. A p50 that looks fine while p95 is
    // tens of milliseconds is exactly what "usually fine, sometimes awful" is.
    for (let i = 0; i < 99; i += 1) {
      recordRenderTiming('chunk', 0.2)
    }
    recordRenderTiming('chunk', 90)

    const summary = summariseRenderTiming('chunk')
    expect(summary?.count).toBe(100)
    expect(summary?.p50Ms).toBeLessThanOrEqual(0.25)
    expect(summary?.maxMs).toBe(90)
  })

  it('keeps memory bounded no matter how much output arrives', () => {
    // Why: a histogram, not a sample list — the measurement must not become the
    // slow thing it is measuring.
    for (let i = 0; i < 50_000; i += 1) {
      recordRenderTiming('chunk', i % 10)
    }
    expect(summariseRenderTiming('chunk')?.count).toBe(50_000)
  })

  it('ignores nonsense durations', () => {
    recordRenderTiming('chunk', Number.NaN)
    recordRenderTiming('chunk', -5)
    expect(summariseRenderTiming('chunk')).toBeNull()
  })
})
