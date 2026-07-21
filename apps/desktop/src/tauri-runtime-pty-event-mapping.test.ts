import { describe, expect, it } from 'vitest'
import type { RuntimeEventStreamEntry } from './runtime-command-shapes'
import {
  mapRuntimeBrowserDriverEntry,
  mapRuntimePtyOutputEntry,
  mapRuntimePtyStatusEntry,
  mapRuntimeSessionDriverEntry
} from './tauri-runtime-pty-event-mapping'

function entry(topic: string, payload: unknown): RuntimeEventStreamEntry {
  return { id: 'evt-1', topic, data: JSON.stringify({ topic, payload }) }
}

describe('mapRuntimeBrowserDriverEntry', () => {
  it('maps mobile and desktop browser ownership events', () => {
    expect(
      mapRuntimeBrowserDriverEntry(
        entry('browser.driver', {
          browserPageId: 'page-1',
          driver: { kind: 'mobile', clientId: 'phone-1' }
        })
      )
    ).toEqual({
      browserPageId: 'page-1',
      driver: { kind: 'mobile', clientId: 'phone-1' }
    })
    expect(
      mapRuntimeBrowserDriverEntry(
        entry('browser.driver', { browserPageId: 'page-1', driver: { kind: 'desktop' } })
      )
    ).toEqual({ browserPageId: 'page-1', driver: { kind: 'desktop' } })
  })

  it('rejects malformed browser ownership events', () => {
    expect(
      mapRuntimeBrowserDriverEntry(
        entry('browser.driver', { browserPageId: 'page-1', driver: { kind: 'mobile' } })
      )
    ).toBeNull()
    expect(
      mapRuntimeBrowserDriverEntry(
        entry('browser.driver', { browserPageId: '', driver: { kind: 'idle' } })
      )
    ).toBeNull()
  })
})

function nativeEntry(topic: string, payload: unknown): RuntimeEventStreamEntry {
  return { id: 'evt-native-1', topic, data: JSON.stringify(payload) }
}

describe('mapRuntimePtyOutputEntry', () => {
  it('maps a coalesced session.output event onto the pty.onData shape', () => {
    const output = mapRuntimePtyOutputEntry(
      entry('session.output', {
        session: { id: 'sess-1', status: 'running' },
        chunk: { at: '2026-07-10T00:00:00Z', stream: 'stdout', content: 'a\nb\n' },
        coalescedChunks: 2
      })
    )
    expect(output).toMatchObject({
      sessionId: 'sess-1',
      content: 'a\nb\n',
      coalescedChunks: 2,
      droppedBytes: 0
    })
  })

  it('surfaces droppedBytes so consumers know the event is a bounded tail', () => {
    const output = mapRuntimePtyOutputEntry(
      entry('session.output', {
        session: { id: 'sess-1', status: 'running' },
        chunk: { stream: 'stdout', content: 'tail' },
        coalescedChunks: 40,
        droppedBytes: 1024
      })
    )
    expect(output?.droppedBytes).toBe(1024)
    expect(output?.coalescedChunks).toBe(40)
  })

  it('defaults chunk accounting for pre-coalescing runtime events', () => {
    const output = mapRuntimePtyOutputEntry(
      entry('session.output', {
        session: { id: 'sess-1', status: 'running' },
        chunk: { stream: 'stdout', content: 'line\n' }
      })
    )
    expect(output?.coalescedChunks).toBe(1)
    expect(output?.droppedBytes).toBe(0)
  })

  it('maps native SSE entries whose data is the direct event payload', () => {
    expect(
      mapRuntimePtyOutputEntry(
        nativeEntry('session.output', {
          session: { id: 'sess-native', status: 'running' },
          chunk: { stream: 'stdout', content: 'prompt> ' }
        })
      )
    ).toMatchObject({ sessionId: 'sess-native', content: 'prompt> ' })
    expect(
      mapRuntimePtyStatusEntry(
        nativeEntry('session.status', { id: 'sess-native', status: 'exited' })
      )?.status
    ).toBe('exited')
  })

  it('rejects wrong topics, empty content, and malformed JSON', () => {
    expect(
      mapRuntimePtyOutputEntry(entry('session.status', { session: { id: 'sess-1' } }))
    ).toBeNull()
    expect(
      mapRuntimePtyOutputEntry(
        entry('session.output', { session: { id: 'sess-1' }, chunk: { content: '' } })
      )
    ).toBeNull()
    expect(
      mapRuntimePtyOutputEntry({ id: null, topic: 'session.output', data: 'not-json' })
    ).toBeNull()
  })
})

describe('mapRuntimePtyStatusEntry', () => {
  it('reads the session from a wrapped or bare payload', () => {
    expect(
      mapRuntimePtyStatusEntry(
        entry('session.status', { session: { id: 'sess-1', status: 'exited' } })
      )?.status
    ).toBe('exited')
    expect(
      mapRuntimePtyStatusEntry(entry('session.status', { id: 'sess-2', status: 'running' }))?.id
    ).toBe('sess-2')
  })

  it('ignores other topics', () => {
    expect(mapRuntimePtyStatusEntry(entry('session.output', { id: 'sess-1' }))).toBeNull()
  })
})

describe('mapRuntimeSessionDriverEntry', () => {
  it('maps mobile floor-taking with the acting client id', () => {
    expect(
      mapRuntimeSessionDriverEntry(
        entry('session.driver', {
          sessionId: 'sess-1',
          driver: { kind: 'mobile', clientId: 'device-1' }
        })
      )
    ).toEqual({ sessionId: 'sess-1', driver: { kind: 'mobile', clientId: 'device-1' } })
  })

  it('maps desktop reclaim and idle transitions', () => {
    expect(
      mapRuntimeSessionDriverEntry(
        entry('session.driver', { sessionId: 'sess-1', driver: { kind: 'desktop' } })
      )?.driver
    ).toEqual({ kind: 'desktop' })
    expect(
      mapRuntimeSessionDriverEntry(
        entry('session.driver', { sessionId: 'sess-1', driver: { kind: 'idle' } })
      )?.driver
    ).toEqual({ kind: 'idle' })
  })

  it('rejects mobile drivers without a client id and unknown kinds', () => {
    expect(
      mapRuntimeSessionDriverEntry(
        entry('session.driver', { sessionId: 'sess-1', driver: { kind: 'mobile' } })
      )
    ).toBeNull()
    expect(
      mapRuntimeSessionDriverEntry(
        entry('session.driver', { sessionId: 'sess-1', driver: { kind: 'martian' } })
      )
    ).toBeNull()
  })
})
