import { describe, expect, it } from 'vitest'
import type { DownloadEvent } from '@tauri-apps/plugin-updater'
import { createTauriUpdateDownloadProgressHandler } from './tauri-updater-download-progress'

type Progress = { percent: number; version: string; bytesPerSecond?: number; etaSeconds?: number }

function harness(startTime = 0) {
  const emitted: Progress[] = []
  let currentTime = startTime
  const handle = createTauriUpdateDownloadProgressHandler(
    '1.4.150',
    (progress) => emitted.push(progress),
    () => currentTime
  )
  return {
    emitted,
    advance: (ms: number) => {
      currentTime += ms
    },
    send: (event: DownloadEvent) => handle(event)
  }
}

describe('createTauriUpdateDownloadProgressHandler', () => {
  it('reports the percentage against the announced content length', () => {
    const h = harness()
    h.send({ event: 'Started', data: { contentLength: 1_000 } } as DownloadEvent)
    h.send({ event: 'Progress', data: { chunkLength: 250 } } as DownloadEvent)
    expect(h.emitted.at(-1)?.percent).toBe(25)
  })

  // Why: the first chunks arrive before the connection settles, and a rate
  // derived from them swings far enough to be worse than saying nothing.
  it('withholds the rate until the connection has settled', () => {
    const h = harness()
    h.send({ event: 'Started', data: { contentLength: 1_000_000 } } as DownloadEvent)
    h.advance(500)
    h.send({ event: 'Progress', data: { chunkLength: 1_000 } } as DownloadEvent)
    expect(h.emitted.at(-1)?.bytesPerSecond).toBeUndefined()
    expect(h.emitted.at(-1)?.etaSeconds).toBeUndefined()
  })

  // The reported case: ~34 KB/s against a large bundle downloads silently for
  // over an hour when the card shows only a percentage.
  it('surfaces a crawling download as a rate and a remaining time', () => {
    const h = harness()
    h.send({ event: 'Started', data: { contentLength: 100_000_000 } } as DownloadEvent)
    h.advance(10_000)
    h.send({ event: 'Progress', data: { chunkLength: 340_000 } } as DownloadEvent)
    const latest = h.emitted.at(-1)
    expect(latest?.bytesPerSecond).toBe(34_000)
    expect(latest?.etaSeconds).toBe(Math.round((100_000_000 - 340_000) / 34_000))
  })

  it('reports the rate without an eta when the total size is unknown', () => {
    const h = harness()
    h.send({ event: 'Started', data: { contentLength: undefined } } as DownloadEvent)
    h.advance(10_000)
    h.send({ event: 'Progress', data: { chunkLength: 340_000 } } as DownloadEvent)
    expect(h.emitted.at(-1)?.bytesPerSecond).toBe(34_000)
    expect(h.emitted.at(-1)?.etaSeconds).toBeUndefined()
  })

  it('finishes at 100', () => {
    const h = harness()
    h.send({ event: 'Started', data: { contentLength: 1_000 } } as DownloadEvent)
    h.send({ event: 'Finished' } as DownloadEvent)
    expect(h.emitted.at(-1)?.percent).toBe(100)
  })
})
