import { net } from 'electron'
import type { ChangelogData } from '../shared/types'
import { selectChangelogData } from '../shared/updater-changelog-selection'

/**
 * Fetches the remote changelog and finds the best entry to show the user.
 *
 * 1. If the incoming version has an exact match with rich content, use it.
 * 2. Otherwise, find the most recent entry that has rich content. If the user's
 *    local version is behind that entry, show it anyway — demoing an older
 *    highlight is better than showing nothing. In this fallback case the
 *    release notes link points to the generic changelog page instead of a
 *    version-specific URL.
 *
 * Why net.fetch instead of fetch: Electron's `net` module respects the app's
 * proxy/certificate settings and has no CORS restrictions.
 */
export async function fetchChangelog(
  incomingVersion: string,
  localVersion: string
): Promise<ChangelogData | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const res = await net.fetch('https://www.nebutra.com/pebble/whats-new/changelog.json', {
      signal: controller.signal
    })
    if (!res.ok) {
      return null
    }
    const json: unknown = await res.json()

    return selectChangelogData(json, incomingVersion, localVersion)
  } finally {
    clearTimeout(timeout)
  }
}
