import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearPersistentSettingsBackends,
  readPersistentSettingsRaw,
  registerPersistentSettingsBackend,
  subscribePersistentSettings,
  writePersistentSettingsRaw,
  type PersistentSettingsBackend
} from './persistent-settings-backend'

class MemoryStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe('persistent settings backend registry', () => {
  beforeEach(() => {
    const storage = new MemoryStorage()
    vi.stubGlobal('window', {
      localStorage: storage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    clearPersistentSettingsBackends()
  })
  afterEach(() => {
    clearPersistentSettingsBackends()
    vi.unstubAllGlobals()
  })

  it('defaults unregistered keys to localStorage', () => {
    writePersistentSettingsRaw('pebble.web.ui.v1', '{"x":1}')
    expect(readPersistentSettingsRaw('pebble.web.ui.v1')).toBe('{"x":1}')
    // The raw value must have reached the actual localStorage object.
    expect(window.localStorage.getItem('pebble.web.ui.v1')).toBe('{"x":1}')
  })

  it('routes a registered key through its override and bypasses localStorage', () => {
    const store = new Map<string, string>()
    const backend: PersistentSettingsBackend = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value)
      },
      subscribe: () => () => {}
    }
    registerPersistentSettingsBackend('pebble.web.settings.v1', backend)

    writePersistentSettingsRaw('pebble.web.settings.v1', '{"native":true}')
    expect(readPersistentSettingsRaw('pebble.web.settings.v1')).toBe('{"native":true}')
    // The override owns the value; localStorage stays empty for this key.
    expect(window.localStorage.getItem('pebble.web.settings.v1')).toBeNull()
    expect(store.get('pebble.web.settings.v1')).toBe('{"native":true}')
  })

  it('subscribes through the override when one is registered', () => {
    const listeners = new Set<() => void>()
    const backend: PersistentSettingsBackend = {
      getItem: () => null,
      setItem: () => {},
      subscribe: (_key, listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    registerPersistentSettingsBackend('pebble.web.keybindings.v1', backend)
    const listener = vi.fn()
    const unsubscribe = subscribePersistentSettings('pebble.web.keybindings.v1', listener)
    listeners.forEach((fn) => fn())
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    expect(listeners.size).toBe(0)
  })
})
