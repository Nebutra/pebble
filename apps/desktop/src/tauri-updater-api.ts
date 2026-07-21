import { invoke } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import type { Update } from '@tauri-apps/plugin-updater'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import {
  PEBBLE_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
  PEBBLE_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../../../packages/product-core/shared/updater-renderer-events'
import type {
  UpdateCheckOptions,
  UpdateStatus
} from '../../../packages/product-core/shared/types'
import { createTauriUpdateDownloadProgressHandler } from './tauri-updater-download-progress'
import {
  fetchTauriChangelog,
  readCurrentAppVersion,
  resetTauriUpdaterAppVersionForTests
} from './tauri-updater-app-version'
import {
  describeTauriUpdaterUnavailable,
  releaseUrlForVersion
} from './tauri-updater-release-url'
import { TauriUpdaterNudgeState } from './tauri-updater-nudge-state'
import { TauriUpdaterOperationState } from './tauri-updater-operation-state'
import {
  checkDefaultTauriUpdate,
  checkTaggedTauriUpdate,
  resetTauriUpdaterReleaseCheckForTests,
  requiresTaggedReleaseCheck,
  resolvePebbleRelease
} from './tauri-updater-release-check'

const updaterStatusListeners = new Set<(status: UpdateStatus) => void>()
const updaterClearDismissalListeners = new Set<() => void>()
const updaterOperations = new TauriUpdaterOperationState()
const TAURI_UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000
let currentUpdaterStatus: UpdateStatus = { state: 'idle' }
let pendingTauriUpdate: Update | null = null
let installedTauriUpdateVersion: string | null = null
let pendingReleaseUrl: string | null = null
let pendingReleaseTag: string | null = null
const updaterNudges = new TauriUpdaterNudgeState({
  development: import.meta.env.DEV,
  fetchNudge: () => invoke<unknown>('updater_fetch_nudge'),
  readVersion: readCurrentAppVersion,
  readUi: () => window.api.ui.get(),
  writeUi: (patch) => window.api.ui.set(patch),
  readStatus: () => currentUpdaterStatus,
  startCheck: (operation) => updaterOperations.startCheck(operation),
  performCheck: (activeNudgeId) => performTauriOrReleaseUpdateCheck({}, activeNudgeId),
  clearDismissal: () => {
    for (const listener of updaterClearDismissalListeners) {
      listener()
    }
  }
})

export function installTauriUpdaterApi(): void {
  if (!hasTauriInternals()) {
    return
  }

  window.api.updater = {
    ...window.api.updater,
    getVersion: readCurrentAppVersion,
    getStatus: () => Promise.resolve(currentUpdaterStatus),
    check: (options) => startManualTauriUpdateCheck(options),
    download: downloadTauriUpdate,
    quitAndInstall: quitAndInstallTauriUpdate,
    dismissNudge: () => updaterNudges.dismiss(),
    onStatus: (callback) => {
      updaterStatusListeners.add(callback)
      return () => {
        updaterStatusListeners.delete(callback)
      }
    },
    onClearDismissal: (callback) => {
      updaterClearDismissalListeners.add(callback)
      return () => updaterClearDismissalListeners.delete(callback)
    }
  } satisfies PreloadApi['updater']
  updaterNudges.installPolling()
}

async function startManualTauriUpdateCheck(options?: UpdateCheckOptions): Promise<void> {
  const operation = updaterOperations.startCheck(async () => {
    emitUpdaterStatus({ state: 'checking', userInitiated: true })
    await performTauriOrReleaseUpdateCheck(options, undefined)
  })
  return operation.promise
}

async function performTauriOrReleaseUpdateCheck(
  options?: UpdateCheckOptions,
  activeNudgeId?: string
): Promise<void> {
  const currentVersion = await readCurrentAppVersion()
  if (requiresTaggedReleaseCheck(currentVersion, options)) {
    await checkPebbleReleaseFeed(options, undefined, activeNudgeId)
    return
  }
  try {
    const update = await checkDefaultTauriUpdate()
    if (update) {
      setPendingTauriUpdate(update)
      await emitAvailableUpdate(update.version, releaseUrlForVersion(update.version), activeNudgeId)
      return
    }
  } catch (error) {
    await checkPebbleReleaseFeed(
      options,
      {
        pluginError: error instanceof Error ? error.message : String(error)
      },
      activeNudgeId
    )
    return
  }

  await checkPebbleReleaseFeed(options, undefined, activeNudgeId)
}

async function checkPebbleReleaseFeed(
  options?: UpdateCheckOptions,
  nativeFailure?: { pluginError: string },
  activeNudgeId?: string
): Promise<void> {
  try {
    const currentVersion = await readCurrentAppVersion()
    const result = await resolvePebbleRelease(currentVersion, options)
    if (result.state === 'available' && result.version && result.tag) {
      pendingReleaseUrl = result.releaseUrl ?? releaseUrlForVersion(result.version)
      pendingReleaseTag = result.tag
      const update = await checkTaggedTauriUpdate(result.tag)
      if (!update) {
        throw new Error(`Signed Tauri updater manifest did not offer ${result.tag}.`)
      }
      setPendingTauriUpdate(update)
      pendingReleaseTag = result.tag
      await emitAvailableUpdate(update.version, pendingReleaseUrl, activeNudgeId)
      return
    }
    if (result.state === 'not-available') {
      await settleNudgeCheck(activeNudgeId)
      emitUpdaterStatus({ state: 'not-available', userInitiated: !activeNudgeId })
      return
    }
    await settleNudgeCheck(activeNudgeId)
    emitUpdaterStatus({
      state: 'error',
      message: nativeFailure
        ? describeTauriUpdaterUnavailable(nativeFailure.pluginError, result.message)
        : (result.message ?? 'Could not check Pebble releases.'),
      userInitiated: !activeNudgeId,
      ...(activeNudgeId ? { activeNudgeId } : {})
    })
  } catch (error) {
    await settleNudgeCheck(activeNudgeId)
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
      userInitiated: !activeNudgeId,
      ...(activeNudgeId ? { activeNudgeId } : {})
    })
  }
}

async function downloadTauriUpdate(): Promise<void> {
  return updaterOperations.startDownload(performTauriUpdateDownload).promise
}

async function performTauriUpdateDownload(): Promise<void> {
  try {
    const update =
      pendingTauriUpdate ??
      (pendingReleaseTag
        ? await checkTaggedTauriUpdate(pendingReleaseTag)
        : await checkDefaultTauriUpdate())
    if (!update) {
      throw new Error(
        'Signed Tauri updater package is not available for this release yet. Use Download Manually for now.'
      )
    }
    setPendingTauriUpdate(update)
    const version = update.version
    const releaseUrl = currentReleaseUrl() ?? releaseUrlForVersion(version)
    pendingReleaseUrl = releaseUrl
    if (navigator.userAgent.toLowerCase().includes('linux')) {
      const installKind = await invoke<string>('app_linux_install_kind')
      if (installKind !== 'appimage') {
        throw new Error(
          `Automatic updates are available for AppImage installs. Update this system package through your package manager or download it from ${releaseUrl}.`
        )
      }
    }
    emitUpdaterStatus(withActiveNudge({ state: 'downloading', percent: 0, version }))
    await update.download(
      createTauriUpdateDownloadProgressHandler(version, (progress) => {
        emitUpdaterStatus(withActiveNudge({ state: 'downloading', ...progress }))
      }),
      {
        timeout: TAURI_UPDATE_DOWNLOAD_TIMEOUT_MS
      }
    )
    await update.install()
    installedTauriUpdateVersion = version
    emitUpdaterStatus(withActiveNudge({ state: 'downloaded', version, releaseUrl }))
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
  return updaterOperations.startRelaunch(async () => {
    window.dispatchEvent(new Event(PEBBLE_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT))
    try {
      await relaunch()
    } catch (error) {
      window.dispatchEvent(new Event(PEBBLE_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT))
      throw error
    }
  }).promise
}

function setPendingTauriUpdate(update: Update): void {
  if (pendingTauriUpdate && pendingTauriUpdate !== update) {
    void pendingTauriUpdate.close().catch(() => undefined)
  }
  pendingTauriUpdate = update
  installedTauriUpdateVersion = null
  pendingReleaseUrl = releaseUrlForVersion(update.version)
}

async function emitAvailableUpdate(
  version: string,
  releaseUrl: string | null,
  activeNudgeId?: string
): Promise<void> {
  const changelog = await fetchTauriChangelog(version)
  emitUpdaterStatus({
    state: 'available',
    version,
    releaseUrl: releaseUrl ?? undefined,
    changelog,
    ...(activeNudgeId ? { activeNudgeId } : {})
  })
}

async function settleNudgeCheck(activeNudgeId?: string): Promise<void> {
  if (!activeNudgeId) {
    return
  }
  await window.api.ui.set({ pendingUpdateNudgeId: null, dismissedUpdateNudgeId: activeNudgeId })
}

function withActiveNudge<T extends UpdateStatus>(status: T): T {
  if (!('activeNudgeId' in currentUpdaterStatus) || !currentUpdaterStatus.activeNudgeId) {
    return status
  }
  return { ...status, activeNudgeId: currentUpdaterStatus.activeNudgeId }
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

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function emitUpdaterStatus(status: UpdateStatus): void {
  currentUpdaterStatus = status
  for (const listener of updaterStatusListeners) {
    listener(status)
  }
}

export async function resetTauriUpdaterStateForTests(): Promise<void> {
  updaterOperations.reset()
  updaterStatusListeners.clear()
  updaterClearDismissalListeners.clear()
  if (pendingTauriUpdate) {
    await Promise.resolve(pendingTauriUpdate.close()).catch(() => undefined)
  }
  currentUpdaterStatus = { state: 'idle' }
  pendingTauriUpdate = null
  installedTauriUpdateVersion = null
  pendingReleaseUrl = null
  pendingReleaseTag = null
  resetTauriUpdaterAppVersionForTests()
  updaterNudges.resetForTests()
  resetTauriUpdaterReleaseCheckForTests()
}
