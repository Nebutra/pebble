import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../src/preload/api-types'
import type { UpdateCheckOptions, UpdateStatus } from '../../../src/shared/types'
import rootPackage from '../../../package.json'

const updaterStatusListeners = new Set<(status: UpdateStatus) => void>()
let currentUpdaterStatus: UpdateStatus = { state: 'idle' }

type TauriReleaseCheckResult = {
  state: 'available' | 'not-available' | 'not-ready' | 'unavailable'
  version?: string
  tag?: string
  releaseUrl?: string
  message?: string
  lastGoodTag?: string
}

export function installTauriUpdaterApi(): void {
  if (!hasTauriInternals()) {
    return
  }

  window.api.updater = {
    ...window.api.updater,
    getVersion: () => Promise.resolve(rootPackage.version),
    getStatus: () => Promise.resolve(currentUpdaterStatus),
    check: async (options) => {
      emitUpdaterStatus({ state: 'checking', userInitiated: true })
      await checkPebbleReleaseFeed(options)
    },
    download: async () => {
      const releaseUrl = currentReleaseUrl()
      if (releaseUrl) {
        await window.api.shell.openUrl(releaseUrl)
      }
      emitUpdaterStatus({
        state: 'error',
        message: releaseUrl
          ? 'Automatic Tauri update download is not wired yet. Opened the Pebble release page.'
          : 'Automatic Tauri update download is not wired yet.',
        userInitiated: true
      })
    },
    quitAndInstall: async () => {
      emitUpdaterStatus({
        state: 'error',
        message: 'Automatic Tauri update install is not wired yet.',
        userInitiated: true
      })
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

async function checkPebbleReleaseFeed(options?: UpdateCheckOptions): Promise<void> {
  try {
    const result = await invoke<TauriReleaseCheckResult>('updater_check_latest_release', {
      input: {
        currentVersion: rootPackage.version,
        includePrerelease: options?.includePrerelease ?? isPrereleaseVersion(rootPackage.version),
        includePerfPrerelease: options?.includePerfPrerelease ?? false
      }
    })
    if (result.state === 'available' && result.version) {
      emitUpdaterStatus({
        state: 'available',
        version: result.version,
        releaseUrl: result.releaseUrl,
        changelog: null
      })
      return
    }
    if (result.state === 'not-available') {
      emitUpdaterStatus({ state: 'not-available', userInitiated: true })
      return
    }
    emitUpdaterStatus({
      state: 'error',
      message: result.message ?? 'Could not check Pebble releases.',
      userInitiated: true
    })
  } catch (error) {
    emitUpdaterStatus({
      state: 'error',
      message: error instanceof Error ? error.message : String(error),
      userInitiated: true
    })
  }
}

function currentReleaseUrl(): string | null {
  if ('releaseUrl' in currentUpdaterStatus && currentUpdaterStatus.releaseUrl) {
    return currentUpdaterStatus.releaseUrl
  }
  if ('version' in currentUpdaterStatus && currentUpdaterStatus.version) {
    return `https://github.com/nebutra/pebble/releases/tag/v${currentUpdaterStatus.version}`
  }
  return null
}

function isPrereleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version.replace(/^v/i, ''))
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
