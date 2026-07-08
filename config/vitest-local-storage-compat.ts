type MemoryStorageRecord = Record<string, string>

function createMemoryStorage(): Storage {
  const entries: MemoryStorageRecord = {}

  return {
    get length() {
      return Object.keys(entries).length
    },
    clear() {
      for (const key of Object.keys(entries)) {
        delete entries[key]
      }
    },
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null
    },
    key(index: number) {
      return Object.keys(entries)[index] ?? null
    },
    removeItem(key: string) {
      delete entries[key]
    },
    setItem(key: string, value: string) {
      entries[key] = String(value)
    }
  }
}

// Why: Node 26 exposes a global localStorage accessor that Vitest 4 does not
// copy from happy-dom, leaving window.localStorage undefined in DOM tests.
if (typeof window !== 'undefined' && typeof window.localStorage === 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: createMemoryStorage()
  })
}
