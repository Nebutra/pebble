import type { GlobalSettings } from '../../../packages/product-core/shared/types'

type SettingsChangeListener = (updates: Partial<GlobalSettings>) => void

const listeners = new Set<SettingsChangeListener>()

export function subscribeToTauriSettingsChanges(listener: SettingsChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitTauriSettingsChanges(updates: Partial<GlobalSettings>): void {
  for (const listener of listeners) {
    try {
      listener(updates)
    } catch (error) {
      // Why: an observer must not turn a successfully persisted setting into a
      // rejected write for unrelated renderer consumers.
      console.error('[tauri-settings] change listener failed', error)
    }
  }
}

export function resetTauriSettingsChangeListenersForTests(): void {
  listeners.clear()
}
