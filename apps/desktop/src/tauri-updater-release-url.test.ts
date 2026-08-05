import { describe, expect, it } from 'vitest'
import {
  describeTauriUpdaterUnavailable,
  PEBBLE_DOWNLOAD_PAGE_URL,
  releaseUrlForVersion
} from './tauri-updater-release-url'

describe('tauri-updater-release-url', () => {
  it('builds canonical release tag URLs', () => {
    expect(releaseUrlForVersion('1.4.130')).toBe(
      'https://github.com/nebutra/pebble/releases/tag/v1.4.130'
    )
  })

  it('adds a network recovery hint when request transport fails', () => {
    const message = describeTauriUpdaterUnavailable(
      'error sending request for url (https://github.com/nebutra/pebble/releases/latest/download/latest.json)',
      'Could not fetch Pebble release feed: error sending request for url (https://github.com/nebutra/pebble/releases.atom)'
    )
    expect(message).toContain('Signed Tauri updater is not ready')
    expect(message).toContain('Release feed status:')
    expect(message).toContain(PEBBLE_DOWNLOAD_PAGE_URL)
    expect(message).toMatch(/system proxy|TUN|Network/i)
  })

  it('keeps non-network failures free of the download-page hint', () => {
    const message = describeTauriUpdaterUnavailable(
      'This Pebble build has no production updater public key; signed updates cannot be installed.'
    )
    expect(message).not.toContain(PEBBLE_DOWNLOAD_PAGE_URL)
  })
})
