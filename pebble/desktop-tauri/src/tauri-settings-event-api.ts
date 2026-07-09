import type { PreloadApi } from '../../../src/preload/api-types'
import type { GlobalSettings, PersistedUIState } from '../../../src/shared/types'

const settingsChangedListeners = new Set<(updates: Partial<GlobalSettings>) => void>()
const uiStateChangedListeners = new Set<(ui: PersistedUIState) => void>()

export function installTauriSettingsEventApi(): void {
  if (!hasTauriInternals()) {
    return
  }

  const settingsBase = window.api.settings
  window.api.settings = {
    ...settingsBase,
    set: async (updates) => {
      const next = await settingsBase.set(updates)
      emitSettingsChanged(updates)
      return next
    },
    onChanged: (callback) => {
      settingsChangedListeners.add(callback)
      return () => {
        settingsChangedListeners.delete(callback)
      }
    }
  } satisfies PreloadApi['settings']

  const uiBase = window.api.ui
  window.api.ui = {
    ...uiBase,
    set: async (updates) => {
      await uiBase.set(updates)
      emitUiStateChanged(await uiBase.get())
    },
    recordFeatureInteraction: async (id) => {
      const next = await uiBase.recordFeatureInteraction(id)
      emitUiStateChanged(next)
      return next
    },
    onStateChanged: (callback) => {
      uiStateChangedListeners.add(callback)
      return () => {
        uiStateChangedListeners.delete(callback)
      }
    }
  } satisfies PreloadApi['ui']
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function emitSettingsChanged(updates: Partial<GlobalSettings>): void {
  for (const listener of settingsChangedListeners) {
    listener(updates)
  }
}

function emitUiStateChanged(ui: PersistedUIState): void {
  for (const listener of uiStateChangedListeners) {
    listener(ui)
  }
}
