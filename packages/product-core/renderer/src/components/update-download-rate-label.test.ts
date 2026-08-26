import { describe, expect, it } from 'vitest'
import {
  describeDownloadRate,
  formatDownloadEta,
  formatDownloadRate,
  isSlowDownload
} from './update-download-rate-label'

describe('formatDownloadRate', () => {
  it('scales the unit to the rate', () => {
    expect(formatDownloadRate(6_800_000)).toBe('6.8 MB/s')
    expect(formatDownloadRate(34_000)).toBe('34 KB/s')
    expect(formatDownloadRate(512)).toBe('512 B/s')
  })
})

describe('formatDownloadEta', () => {
  it('scales the unit to the remaining time', () => {
    expect(formatDownloadEta(45)).toBe('about 45 sec left')
    expect(formatDownloadEta(600)).toBe('about 10 min left')
    expect(formatDownloadEta(3_600)).toBe('about 1 hr left')
    expect(formatDownloadEta(5_400)).toBe('about 1.5 hr left')
    expect(formatDownloadEta(7_200)).toBe('about 2 hr left')
  })
})

describe('isSlowDownload', () => {
  // Why: the reported case was 34 KB/s against a bundle large enough to take
  // over an hour. The card showed only a percentage, so it looked identical to
  // a healthy download that happened to be early.
  it('flags a download that would take over an hour', () => {
    expect(isSlowDownload(4_000)).toBe(true)
  })

  it('leaves a healthy download unflagged', () => {
    expect(isSlowDownload(90)).toBe(false)
  })

  it('says nothing before the rate is known', () => {
    expect(isSlowDownload(undefined)).toBe(false)
  })
})

describe('describeDownloadRate', () => {
  it('returns null while the rate is still unknown', () => {
    expect(describeDownloadRate({})).toBeNull()
  })

  it('reports the rate alone when the total size is unknown', () => {
    expect(describeDownloadRate({ bytesPerSecond: 34_000 })).toBe('34 KB/s')
  })

  it('reports rate and remaining time together', () => {
    expect(describeDownloadRate({ bytesPerSecond: 34_000, etaSeconds: 3_600 })).toBe(
      '34 KB/s · about 1 hr left'
    )
  })
})
