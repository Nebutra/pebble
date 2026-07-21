import type { PersistentSettingsBackend } from '@/web/persistent-settings-backend'

/** IO the backend needs, injected so the cache/debounce/migration state machine
 *  is testable without a running Tauri shell. */
export type NativeDocumentIo = {
  read(documentName: string): Promise<string | null>
  write(documentName: string, contents: string): Promise<void>
  /** Synchronous legacy source for the seed + one-time migration (localStorage
   *  in production). */
  readLegacy(key: string): string | null
  writeLegacy?(key: string, contents: string): void
}

// Why: mirror Electron persistence's 1s SAVE_DEBOUNCE_MS so bursts of setting
// changes on input handlers coalesce into one atomic native write.
export const NATIVE_WRITE_DEBOUNCE_MS = 1_000

/** One synchronous-facing cache + debounced async writer for a single native
 *  document. The cache is what the renderer's synchronous read/write call sites
 *  see; the native file is reconciled in the background. */
export class NativeDocumentBackend implements PersistentSettingsBackend {
  private readonly key: string
  private readonly documentName: string
  private readonly io: NativeDocumentIo
  private readonly debounceMs: number
  private readonly legacyWriteThrough: boolean
  private cache: string | null
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private pending: string | null = null
  private mutationGeneration = 0
  private readonly listeners = new Set<() => void>()

  constructor(
    key: string,
    documentName: string,
    io: NativeDocumentIo,
    debounceMs = NATIVE_WRITE_DEBOUNCE_MS,
    legacyWriteThrough = false
  ) {
    this.key = key
    this.documentName = documentName
    this.io = io
    this.debounceMs = debounceMs
    this.legacyWriteThrough = legacyWriteThrough
    // Seed synchronously from the legacy store so reads before the async prime
    // are correct and migration has a source. The legacy store is left in place
    // for rollback safety.
    this.cache = io.readLegacy(key)
  }

  /** Reconcile the cache with the native file. If the file exists it wins; if
   *  it is absent but the legacy store has data, migrate that data into the
   *  file once (leaving the legacy store untouched). */
  async prime(): Promise<void> {
    const generation = this.mutationGeneration
    let native: string | null = null
    try {
      native = await this.io.read(this.documentName)
    } catch {
      // Native read unavailable: keep the legacy-seeded cache.
      return
    }
    // Why: a renderer write made while native IO was pending is newer than the
    // startup snapshot and must remain visible and queued for persistence.
    if (generation !== this.mutationGeneration) {
      return
    }
    if (native !== null) {
      const writeAhead = this.legacyWriteThrough ? this.io.readLegacy(this.key) : null
      if (writeAhead !== null && writeAhead !== native) {
        // Why: workspace shutdown cannot await Tauri IPC. Its synchronous
        // write-ahead mirror is authoritative until native storage catches up.
        this.cache = writeAhead
        try {
          await this.io.write(this.documentName, writeAhead)
        } catch {
          this.pending = writeAhead
          this.scheduleWrite()
        }
        return
      }
      const changed = native !== this.cache
      this.cache = native
      if (changed) {
        this.notify()
      }
      return
    }
    const legacy = this.io.readLegacy(this.key)
    if (legacy !== null) {
      // One-time migration: import the existing legacy blob into the native
      // store, but do not delete it (rollback safety).
      try {
        await this.io.write(this.documentName, legacy)
      } catch {
        // Migration best-effort; the cache already holds the legacy value.
      }
    }
  }

  getItem(key: string): string | null {
    return key === this.key ? this.cache : null
  }

  setItem(key: string, value: string): void {
    if (key !== this.key) {
      return
    }
    this.cache = value
    this.mutationGeneration += 1
    if (this.legacyWriteThrough) {
      this.io.writeLegacy?.(this.key, value)
    }
    this.pending = value
    this.scheduleWrite()
    this.notify()
  }

  subscribe(key: string, listener: () => void): () => void {
    if (key !== this.key) {
      return () => {}
    }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== null) {
      return
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.flush()
    }, this.debounceMs)
  }

  private async flush(): Promise<void> {
    if (this.pending === null) {
      return
    }
    const payload = this.pending
    this.pending = null
    try {
      await this.io.write(this.documentName, payload)
    } catch {
      // Retry the coalesced write on the next tick; the in-memory cache and
      // untouched legacy store both still hold the latest value.
      if (this.pending === null) {
        this.pending = payload
        this.scheduleWrite()
      }
    }
  }
}
