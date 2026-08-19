import { describe, expect, it } from 'vitest'
import { sampleFrameCadence } from './terminal-frame-cadence'

function framesAt(intervals: readonly number[]): (cb: (t: number) => void) => void {
  let index = 0
  let clock = 1000
  return (callback) => {
    const step = intervals[Math.min(index, intervals.length - 1)] ?? 16
    if (index > 0) {
      clock += step
    }
    index += 1
    queueMicrotask(() => callback(clock))
  }
}

describe('frame cadence sampling', () => {
  it('reports a steady display as steady', async () => {
    const summary = await sampleFrameCadence(framesAt([16.7]), 10)
    expect(summary.frames).toBe(9)
    expect(summary.p50Ms).toBeCloseTo(16.7, 1)
    expect(summary.maxMs).toBeCloseTo(16.7, 1)
  })

  it('separates a stalled tail from a healthy median', async () => {
    // Why: this is the distinction the whole file exists for — frames drawn on
    // time but presented late look exactly like this.
    const intervals = [16.7, 16.7, 16.7, 16.7, 16.7, 16.7, 16.7, 16.7, 400]
    const summary = await sampleFrameCadence(framesAt(intervals), intervals.length + 1)
    expect(summary.p50Ms).toBeCloseTo(16.7, 1)
    expect(summary.maxMs).toBeGreaterThan(300)
  })

  it('always samples enough frames to produce a gap', async () => {
    const summary = await sampleFrameCadence(framesAt([16.7]), 1)
    expect(summary.frames).toBeGreaterThanOrEqual(1)
  })
})
