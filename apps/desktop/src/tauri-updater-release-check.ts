import { invoke } from '@tauri-apps/api/core'
import { check as checkTauriUpdate, Update } from '@tauri-apps/plugin-updater'
import type { UpdateCheckOptions } from '../../../packages/product-core/shared/types'

const TAURI_UPDATE_CHECK_TIMEOUT_MS = 15_000
let updaterInstallReadinessPromise: Promise<void> | null = null

export type TauriReleaseCheckResult = {
  state: 'available' | 'not-available' | 'not-ready' | 'unavailable'
  version?: string
  tag?: string
  releaseUrl?: string
  message?: string
  lastGoodTag?: string
}

type TauriUpdateMetadata = {
  rid: number
  currentVersion: string
  version: string
  date?: string
  body?: string
  rawJson: Record<string, unknown>
}

export async function checkDefaultTauriUpdate(): Promise<Update | null> {
  await assertTauriUpdaterInstallReady()
  return checkTauriUpdate({
    allowDowngrades: false,
    timeout: TAURI_UPDATE_CHECK_TIMEOUT_MS
  })
}

export async function checkTaggedTauriUpdate(tag: string): Promise<Update | null> {
  await assertTauriUpdaterInstallReady()
  const metadata = await invoke<TauriUpdateMetadata | null>('updater_check_release_tag', {
    input: { tag }
  })
  return metadata ? new Update(metadata) : null
}

async function assertTauriUpdaterInstallReady(): Promise<void> {
  // Why: the checked-in key is intentionally non-production; only release CI
  // injects the verification key that makes native update installation safe.
  updaterInstallReadinessPromise ??= invoke<void>('updater_assert_install_ready').catch((error) => {
    updaterInstallReadinessPromise = null
    throw error
  })
  return updaterInstallReadinessPromise
}

export function resetTauriUpdaterReleaseCheckForTests(): void {
  updaterInstallReadinessPromise = null
}

export async function resolvePebbleRelease(
  currentVersion: string,
  options?: UpdateCheckOptions
): Promise<TauriReleaseCheckResult> {
  return invoke<TauriReleaseCheckResult>('updater_check_latest_release', {
    input: {
      currentVersion,
      includePrerelease: options?.includePrerelease ?? isPrereleaseVersion(currentVersion),
      includePerfPrerelease: options?.includePerfPrerelease ?? false
    }
  })
}

export function requiresTaggedReleaseCheck(
  currentVersion: string,
  options?: UpdateCheckOptions
): boolean {
  return (
    options?.includePrerelease === true ||
    options?.includePerfPrerelease === true ||
    (options?.includePrerelease === undefined && isPrereleaseVersion(currentVersion))
  )
}

function isPrereleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version.replace(/^v/i, ''))
}
