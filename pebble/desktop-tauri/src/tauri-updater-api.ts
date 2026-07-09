import type { PreloadApi } from '../../../src/preload/api-types'
import type { UpdateStatus } from '../../../src/shared/types'
import rootPackage from '../../../package.json'

const updaterStatusListeners = new Set<(status: UpdateStatus) => void>()
let currentUpdaterStatus: UpdateStatus = { state: 'idle' }

export function installTauriUpdaterApi(): void {
  if (!hasTauriInternals()) {
    return
  }

  window.api.updater = {
    ...window.api.updater,
    getVersion: () => Promise.resolve(rootPackage.version),
    getStatus: () => Promise.resolve(currentUpdaterStatus),
    check: async () => {
      emitUpdaterStatus({ state: 'checking', userInitiated: true })
      emitUpdaterStatus({
        state: 'error',
        message: 'Tauri updater is not configured yet.',
        userInitiated: true
      })
    },
    download: async () => {
      throw new Error('Tauri updater download is not configured yet.')
    },
    quitAndInstall: async () => {
      throw new Error('Tauri updater install is not configured yet.')
    },
    dismissNudge: () => Promise.resolve(),
    onStatus: (callback) => {
      updaterStatusListeners.add(callback)
      return () => {
        updaterStatusListeners.delete(callback)
      }
    },
    onClearDismissal: () => () => {}
  } satisfies PreloadApi['updater']
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function emitUpdaterStatus(status: UpdateStatus): void {
  currentUpdaterStatus = status
  for (const listener of updaterStatusListeners) {
    listener(status)
  }
}
