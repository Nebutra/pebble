import { describe, expect, it } from 'vitest'
import {
  compareReleaseVersions,
  isValidReleaseVersion,
  selectChangelogData
} from './updater-changelog-selection'

describe('release version comparison', () => {
  it('orders prereleases before their stable release', () => {
    expect(compareReleaseVersions('1.4.128-rc.8', '1.4.128')).toBeLessThan(0)
    expect(compareReleaseVersions('1.4.128', '1.4.128-rc.8')).toBeGreaterThan(0)
  })

  it('uses SemVer identifier ordering and ignores build metadata', () => {
    expect(compareReleaseVersions('v1.4.128-rc.10', '1.4.128-rc.2')).toBeGreaterThan(0)
    expect(compareReleaseVersions('1.4.128+macos', '1.4.128+windows')).toBe(0)
  })

  it('rejects incomplete and malformed versions', () => {
    expect(isValidReleaseVersion('1.4')).toBe(false)
    expect(isValidReleaseVersion('latest')).toBe(false)
    expect(isValidReleaseVersion('1.4.128')).toBe(true)
  })

  it('canonicalizes Pebble product release notes to the matching GitHub release', () => {
    const changelog = selectChangelogData(
      [
        {
          version: '1.4.128',
          title: 'Pebble 1.4.128',
          description: 'Release notes',
          mediaUrl: 'https://pebble.nebutra.com/media/release-popup.gif',
          releaseNotesUrl: 'https://pebble.nebutra.com/changelog/1.4.128'
        }
      ],
      '1.4.128',
      '1.4.127'
    )

    expect(changelog?.release.releaseNotesUrl).toBe(
      'https://github.com/nebutra/pebble/releases/tag/v1.4.128'
    )
  })
})
