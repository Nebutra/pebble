import { describe, expect, it } from 'vitest'
import { requiresTaggedReleaseCheck } from './tauri-updater-release-check'

describe('requiresTaggedReleaseCheck', () => {
  it('uses GitHub tag manifests for explicit RC and perf channels', () => {
    expect(requiresTaggedReleaseCheck('1.4.124', { includePrerelease: true })).toBe(true)
    expect(requiresTaggedReleaseCheck('1.4.124', { includePerfPrerelease: true })).toBe(true)
  })

  it('keeps prerelease installations on their tagged channel by default', () => {
    expect(requiresTaggedReleaseCheck('1.4.124-rc.8')).toBe(true)
    expect(requiresTaggedReleaseCheck('1.4.124-rc.8', {})).toBe(true)
  })

  it('uses the stable updater endpoint when prereleases are explicitly disabled', () => {
    expect(requiresTaggedReleaseCheck('1.4.124')).toBe(false)
    expect(requiresTaggedReleaseCheck('1.4.124-rc.8', { includePrerelease: false })).toBe(false)
  })
})
