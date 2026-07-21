import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { GlobalSettings, PersistedUIState } from '../../../packages/product-core/shared/types'

type TauriActivateWorktreeEvent = Parameters<
  Parameters<PreloadApi['ui']['onActivateWorktree']>[0]
>[0]
type TauriOpenFileFromMobileEvent = Parameters<
  Parameters<PreloadApi['ui']['onOpenFileFromMobile']>[0]
>[0]
type TauriOpenDiffFromMobileEvent = Parameters<
  Parameters<PreloadApi['ui']['onOpenDiffFromMobile']>[0]
>[0]

const settingsChangedListeners = new Set<(updates: Partial<GlobalSettings>) => void>()
const uiStateChangedListeners = new Set<(ui: PersistedUIState) => void>()
const activateWorktreeListeners = new Set<(data: TauriActivateWorktreeEvent) => void>()
const openFileFromMobileListeners = new Set<(data: TauriOpenFileFromMobileEvent) => void>()
const openDiffFromMobileListeners = new Set<(data: TauriOpenDiffFromMobileEvent) => void>()

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
    },
    onActivateWorktree: (callback) => {
      activateWorktreeListeners.add(callback)
      return () => {
        activateWorktreeListeners.delete(callback)
      }
    },
    onOpenFileFromMobile: (callback) => {
      openFileFromMobileListeners.add(callback)
      return () => {
        openFileFromMobileListeners.delete(callback)
      }
    },
    onOpenDiffFromMobile: (callback) => {
      openDiffFromMobileListeners.add(callback)
      return () => {
        openDiffFromMobileListeners.delete(callback)
      }
    }
  } satisfies PreloadApi['ui']
}

export function emitTauriActivateWorktree(data: TauriActivateWorktreeEvent): void {
  for (const listener of activateWorktreeListeners) {
    listener(data)
  }
}

export function emitTauriOpenFileFromMobile(data: TauriOpenFileFromMobileEvent): void {
  for (const listener of openFileFromMobileListeners) {
    listener(data)
  }
}

export function emitTauriOpenDiffFromMobile(data: TauriOpenDiffFromMobileEvent): void {
  for (const listener of openDiffFromMobileListeners) {
    listener(data)
  }
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
