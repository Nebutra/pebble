/** Synchronous string key/value backend for renderer-owned persistence blobs
 *  (settings, onboarding, keybindings). The web build uses localStorage; the
 *  Tauri build overrides specific keys with a native file-backed store that
 *  primes a synchronous in-memory cache so the read/write call sites stay sync
 *  (settings writes fire on input handlers and must never block on IO). */
export type PersistentSettingsBackend = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  /** Subscribe to external changes to `key` (e.g. another tab, or a native
   *  file-watch). Returns an unsubscribe. Mirrors the `storage` event shape. */
  subscribe(key: string, listener: () => void): () => void
}

const overrides = new Map<string, PersistentSettingsBackend>()

/** Route a storage key through a custom backend. Keys left unregistered keep
 *  using localStorage, so plain-web mode is unchanged. */
export function registerPersistentSettingsBackend(
  key: string,
  backend: PersistentSettingsBackend
): void {
  overrides.set(key, backend)
}

/** Test/teardown hook so a registered backend never leaks across suites. */
export function clearPersistentSettingsBackends(): void {
  overrides.clear()
}

export function readPersistentSettingsRaw(key: string): string | null {
  const backend = overrides.get(key)
  if (backend) {
    return backend.getItem(key)
  }
  return window.localStorage.getItem(key)
}

export function writePersistentSettingsRaw(key: string, value: string): void {
  const backend = overrides.get(key)
  if (backend) {
    backend.setItem(key, value)
    return
  }
  window.localStorage.setItem(key, value)
}

/** Subscribe to changes for a key across whichever backend owns it. For
 *  localStorage-backed keys this is the cross-tab `storage` event; a native
 *  backend supplies its own change source. */
export function subscribePersistentSettings(key: string, listener: () => void): () => void {
  const backend = overrides.get(key)
  if (backend) {
    return backend.subscribe(key, listener)
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key === key) {
      listener()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
