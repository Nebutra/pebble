import { invoke } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import {
  check as checkTauriUpdate,
  type DownloadEvent,
  type Update
} from '@tauri-apps/plugin-updater'
import type { PreloadApi } from '../../../src/preload/api-types'
import {
  PEBBLE_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
  PEBBLE_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../../../src/shared/updater-renderer-events'
import type { UpdateCheckOptions, UpdateStatus } from '../../../src/shared/types'
import rootPackage from '../../../package.json'

const updaterStatusListeners = new Set<(status: UpdateStatus) => void>()
const TAURI_UPDATE_CHECK_TIMEOUT_MS = 15_000
const TAURI_UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000
let currentUpdaterStatus: UpdateStatus = { state: 'idle' }
let pendingTauriUpdate: Update | null = null
let installedTauriUpdateVersion: string | null = null
let pendingReleaseUrl: string | null = null

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
      await checkForTauriOrReleaseUpdate(options)
    },
    download: downloadTauriUpdate,
    quitAndInstall: quitAndInstallTauriUpdate,
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

async function checkForTauriOrReleaseUpdate(options?: UpdateCheckOptions): Promise<void> {
  try {
    const update = await checkNativeTauriUpdate()
    if (update) {
      setPendingTauriUpdate(update)
      emitAvailableUpdate(update.version, releaseUrlForVersion(update.version))
      return
    }
  } catch (error) {
    await checkPebbleReleaseFeed(options, {
      pluginError: error instanceof Error ? error.message : String(error)
    })
    return
  }

  await checkPebbleReleaseFeed(options)
}

async function checkNativeTauriUpdate(): Promise<Update | null> {
  return checkTauriUpdate({
    allowDowngrades: false,
    timeout: TAURI_UPDATE_CHECK_TIMEOUT_MS
  })
}

async function checkPebbleReleaseFeed(
  options?: UpdateCheckOptions,
  nativeFailure?: { pluginError: string }
): Promise<void> {
  try {
    const result = await invoke<TauriReleaseCheckResult>('updater_check_latest_release', {
      input: {
        currentVersion: rootPackage.version,
        includePrerelease: options?.includePrerelease ?? isPrereleaseVersion(rootPackage.version),
        includePerfPrerelease: options?.includePerfPrerelease ?? false
      }
    })
    if (result.state === 'available' && result.version) {
      pendingReleaseUrl = result.releaseUrl ?? releaseUrlForVersion(result.version)
      emitAvailableUpdate(result.version, pendingReleaseUrl)
      return
    }
    if (result.state === 'not-available') {
      emitUpdaterStatus({ state: 'not-available', userInitiated: true })
      return
    }
    emitUpdaterStatus({
      state: 'error',
      message: nativeFailure
        ? describeTauriUpdaterUnavailable(nativeFailure.pluginError, result.message)
        : (result.message ?? 'Could not check Pebble releases.'),
      userInitiated: true
    })
  } catch (error) {
    emitUpdaterStatus({
      state: 'error',
      message: nativeFailure
        ? describeTauriUpdaterUnavailable(
            nativeFailure.pluginError,
            error instanceof Error ? error.message : String(error)
          )
        : error instanceof Error
          ? error.message
          : String(error),
      userInitiated: true
    })
  }
}

async function downloadTauriUpdate(): Promise<void> {
  try {
    const update = pendingTauriUpdate ?? (await checkNativeTauriUpdate())
    if (!update) {
      throw new Error(
        'Signed Tauri updater package is not available for this release yet. Use Download Manually for now.'
      )
    }
    setPendingTauriUpdate(update)
    const version = update.version
    const releaseUrl = currentReleaseUrl() ?? releaseUrlForVersion(version)
    pendingReleaseUrl = releaseUrl
    emitUpdaterStatus({ state: 'downloading', percent: 0, version })
    await update.download(createDownloadProgressHandler(version), {
      timeout: TAURI_UPDATE_DOWNLOAD_TIMEOUT_MS
    })
    await update.install()
    installedTauriUpdateVersion = version
    emitUpdaterStatus({ state: 'downloaded', version, releaseUrl })
  } catch (error) {
    emitUpdaterStatus({
      state: 'error',
      message: error instanceof Error ? error.message : String(error),
      userInitiated: true
    })
  }
}

async function quitAndInstallTauriUpdate(): Promise<void> {
  if (!installedTauriUpdateVersion) {
    throw new Error('No downloaded Tauri update is ready to install.')
  }
  window.dispatchEvent(new Event(PEBBLE_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT))
  try {
    await relaunch()
  } catch (error) {
    window.dispatchEvent(new Event(PEBBLE_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT))
    throw error
  }
}

function createDownloadProgressHandler(version: string): (event: DownloadEvent) => void {
  let downloadedBytes = 0
  let totalBytes: number | undefined
  return (event) => {
    if (event.event === 'Started') {
      downloadedBytes = 0
      totalBytes = event.data.contentLength
      emitUpdaterStatus({ state: 'downloading', percent: 0, version })
      return
    }
    if (event.event === 'Progress') {
      downloadedBytes += event.data.chunkLength
      const percent = totalBytes
        ? Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100))
        : 0
      emitUpdaterStatus({ state: 'downloading', percent, version })
      return
    }
    emitUpdaterStatus({ state: 'downloading', percent: 100, version })
  }
}

function setPendingTauriUpdate(update: Update): void {
  if (pendingTauriUpdate && pendingTauriUpdate !== update) {
    void pendingTauriUpdate.close().catch(() => undefined)
  }
  pendingTauriUpdate = update
  installedTauriUpdateVersion = null
  pendingReleaseUrl = releaseUrlForVersion(update.version)
}

function emitAvailableUpdate(version: string, releaseUrl: string | null): void {
  emitUpdaterStatus({
    state: 'available',
    version,
    releaseUrl: releaseUrl ?? undefined,
    changelog: null
  })
}

function currentReleaseUrl(): string | null {
  if ('releaseUrl' in currentUpdaterStatus && currentUpdaterStatus.releaseUrl) {
    return currentUpdaterStatus.releaseUrl
  }
  if (pendingReleaseUrl) {
    return pendingReleaseUrl
  }
  if ('version' in currentUpdaterStatus && currentUpdaterStatus.version) {
    return releaseUrlForVersion(currentUpdaterStatus.version)
  }
  return null
}

function releaseUrlForVersion(version: string): string {
  return `https://github.com/nebutra/pebble/releases/tag/v${version}`
}

function describeTauriUpdaterUnavailable(pluginError: string, releaseMessage?: string): string {
  const details = releaseMessage ? ` Release feed status: ${releaseMessage}` : ''
  return `Signed Tauri updater is not ready: ${pluginError}.${details}`
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
