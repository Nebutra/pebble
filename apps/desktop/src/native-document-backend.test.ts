import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NativeDocumentBackend, type NativeDocumentIo } from './native-document-backend'

const KEY = 'pebble.web.settings.v1'
const DOC = 'settings'

/** In-memory native store + legacy store standing in for the Rust file store
 *  and localStorage. Records writes so debounce/coalescing is observable. */
function createIo(overrides?: Partial<NativeDocumentIo>): {
  io: NativeDocumentIo
  nativeFiles: Map<string, string>
  legacy: Map<string, string>
  writes: string[]
} {
  const nativeFiles = new Map<string, string>()
  const legacy = new Map<string, string>()
  const writes: string[] = []
  const io: NativeDocumentIo = {
    read: async (name) => nativeFiles.get(name) ?? null,
    write: async (name, contents) => {
      writes.push(contents)
      nativeFiles.set(name, contents)
    },
    readLegacy: (key) => legacy.get(key) ?? null,
    ...overrides
  }
  return { io, nativeFiles, legacy, writes }
}

describe('NativeDocumentBackend', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('seeds the cache synchronously from the legacy store before priming', () => {
    const { io, legacy } = createIo()
    legacy.set(KEY, '{"seed":true}')
    const backend = new NativeDocumentBackend(KEY, DOC, io)
    // Reads must be correct immediately, before the async prime resolves.
    expect(backend.getItem(KEY)).toBe('{"seed":true}')
  })

  it('migrates legacy data into the native store once and leaves legacy intact', async () => {
    const { io, nativeFiles, legacy, writes } = createIo()
    legacy.set(KEY, '{"migrated":1}')
    const backend = new NativeDocumentBackend(KEY, DOC, io)
    await backend.prime()
    expect(nativeFiles.get(DOC)).toBe('{"migrated":1}')
    // Rollback safety: the legacy blob is never deleted.
    expect(legacy.get(KEY)).toBe('{"migrated":1}')
    expect(writes).toEqual(['{"migrated":1}'])
  })

  it('does not migrate when the native file already exists (native wins)', async () => {
    const { io, nativeFiles, legacy, writes } = createIo()
    legacy.set(KEY, '{"legacy":true}')
    nativeFiles.set(DOC, '{"native":true}')
    const backend = new NativeDocumentBackend(KEY, DOC, io)
    await backend.prime()
    expect(backend.getItem(KEY)).toBe('{"native":true}')
    // No write: the existing native file is authoritative.
    expect(writes).toEqual([])
  })

  it('recovers a synchronous write-ahead session over a stale native document', async () => {
    const { io, nativeFiles, legacy, writes } = createIo()
    io.writeLegacy = (key, contents) => legacy.set(key, contents)
    nativeFiles.set(DOC, '{"native":"stale"}')
    legacy.set(KEY, '{"session":"latest"}')
    const backend = new NativeDocumentBackend(KEY, DOC, io, 1_000, true)

    await backend.prime()

    expect(backend.getItem(KEY)).toBe('{"session":"latest"}')
    expect(nativeFiles.get(DOC)).toBe('{"session":"latest"}')
    expect(writes).toEqual(['{"session":"latest"}'])
  })

  it('writes session state to the synchronous mirror before native debounce', () => {
    const { io, legacy, writes } = createIo()
    io.writeLegacy = (key, contents) => legacy.set(key, contents)
    const backend = new NativeDocumentBackend(KEY, DOC, io, 1_000, true)

    backend.setItem(KEY, '{"session":"closing"}')

    expect(legacy.get(KEY)).toBe('{"session":"closing"}')
    expect(writes).toEqual([])
  })

  it('notifies subscribers when priming replaces the seeded value', async () => {
    const { io, nativeFiles } = createIo()
    nativeFiles.set(DOC, '{"native":true}')
    const backend = new NativeDocumentBackend(KEY, DOC, io)
    const listener = vi.fn()
    backend.subscribe(KEY, listener)
    await backend.prime()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not overwrite a renderer mutation with a stale startup read', async () => {
    let resolveRead: (value: string | null) => void = () => {}
    const read = new Promise<string | null>((resolve) => {
      resolveRead = resolve
    })
    const { io } = createIo({ read: () => read })
    const backend = new NativeDocumentBackend(KEY, DOC, io, 1_000)

    const priming = backend.prime()
    backend.setItem(KEY, '{"renderer":"new"}')
    resolveRead('{"native":"stale"}')
    await priming

    expect(backend.getItem(KEY)).toBe('{"renderer":"new"}')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(backend.getItem(KEY)).toBe('{"renderer":"new"}')
  })

  it('serves writes from the synchronous cache and debounces the native write', async () => {
    const { io, writes } = createIo()
    const backend = new NativeDocumentBackend(KEY, DOC, io, 1_000)
    backend.setItem(KEY, '{"a":1}')
    // Cache reflects the write immediately; no IO yet.
    expect(backend.getItem(KEY)).toBe('{"a":1}')
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writes).toEqual(['{"a":1}'])
  })

  it('coalesces a burst of writes into a single native write', async () => {
    const { io, writes } = createIo()
    const backend = new NativeDocumentBackend(KEY, DOC, io, 1_000)
    backend.setItem(KEY, '{"n":1}')
    backend.setItem(KEY, '{"n":2}')
    backend.setItem(KEY, '{"n":3}')
    await vi.advanceTimersByTimeAsync(1_000)
    // Only the last value is persisted, exactly once.
    expect(writes).toEqual(['{"n":3}'])
  })

  it('retries a coalesced write after a failed native write', async () => {
    let failNext = true
    const persisted: string[] = []
    const io: NativeDocumentIo = {
      read: async () => null,
      write: async (_name, contents) => {
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
        persisted.push(contents)
      },
      readLegacy: () => null
    }
    const backend = new NativeDocumentBackend(KEY, DOC, io, 1_000)
    backend.setItem(KEY, '{"v":1}')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(persisted).toEqual([])
    // Cache retains the value; the retry lands on the next debounce window.
    expect(backend.getItem(KEY)).toBe('{"v":1}')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(persisted).toEqual(['{"v":1}'])
  })

  it('keeps a newer queued value when an older in-flight write fails', async () => {
    let rejectFirst: (error: Error) => void = () => {}
    const firstWrite = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject
    })
    const persisted: string[] = []
    let writeCount = 0
    const { io } = createIo({
      write: async (_name, contents) => {
        writeCount += 1
        if (writeCount === 1) {
          return firstWrite
        }
        persisted.push(contents)
      }
    })
    const backend = new NativeDocumentBackend(KEY, DOC, io, 1_000)
    backend.setItem(KEY, '{"value":"A"}')
    await vi.advanceTimersByTimeAsync(1_000)

    backend.setItem(KEY, '{"value":"B"}')
    rejectFirst(new Error('disk full'))
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(persisted).toEqual(['{"value":"B"}'])
    expect(backend.getItem(KEY)).toBe('{"value":"B"}')
  })

  it('keeps the legacy-seeded cache when the native read throws', async () => {
    const { legacy } = createIo()
    legacy.set(KEY, '{"fallback":true}')
    const io: NativeDocumentIo = {
      read: async () => {
        throw new Error('bridge unavailable')
      },
      write: async () => {},
      readLegacy: (key) => legacy.get(key) ?? null
    }
    const backend = new NativeDocumentBackend(KEY, DOC, io)
    await backend.prime()
    expect(backend.getItem(KEY)).toBe('{"fallback":true}')
  })
})
