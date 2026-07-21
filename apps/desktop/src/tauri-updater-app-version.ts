import { invoke } from '@tauri-apps/api/core'
import { getVersion as getTauriAppVersion } from '@tauri-apps/api/app'
import type { ChangelogData } from '../../../packages/product-core/shared/types'
import { selectChangelogData } from '../../../packages/product-core/shared/updater-changelog-selection'

// The current app version is cached once per session; split out of
// tauri-updater-api.ts alongside changelog selection which depends on it.
let currentAppVersionPromise: Promise<string> | null = null

export function readCurrentAppVersion(): Promise<string> {
  currentAppVersionPromise ??= getTauriAppVersion()
  return currentAppVersionPromise
}

export async function fetchTauriChangelog(incomingVersion: string): Promise<ChangelogData | null> {
  try {
    const currentVersion = await readCurrentAppVersion()
    const json = await invoke<unknown>('updater_fetch_changelog_entries')
    return selectChangelogData(json, incomingVersion, currentVersion)
  } catch {
    return null
  }
}

export function resetTauriUpdaterAppVersionForTests(): void {
  currentAppVersionPromise = null
}
