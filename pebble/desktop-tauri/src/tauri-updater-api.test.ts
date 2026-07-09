import { beforeEach, describe, expect, it, vi } from 'vitest'

const { checkMock, invokeMock, relaunchMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  invokeMock: vi.fn(),
  relaunchMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: checkMock
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: relaunchMock
}))

import { installTauriUpdaterApi } from './tauri-updater-api'

describe('installTauriUpdaterApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkMock.mockResolvedValue(null)
    globalThis.window = {
      __TAURI_INTERNALS__: {},
      api: {
        updater: {}
      }
    } as unknown as Window & typeof globalThis
  })

  it('attaches Nebutra changelog data to available release statuses', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'updater_check_latest_release') {
        return {
          state: 'available',
          version: '1.4.128',
          tag: 'v1.4.128',
          releaseUrl: 'https://github.com/nebutra/pebble/releases/tag/v1.4.128'
        }
      }
      if (command === 'updater_fetch_changelog_entries') {
        return [
          {
            version: '1.4.128',
            title: 'Release popup polish',
            description: 'Update cards keep session state visible.',
            mediaUrl: 'https://www.nebutra.com/pebble/media/release-popup.gif',
            releaseNotesUrl: 'https://www.nebutra.com/pebble/changelog/1.4.128'
          },
          { version: '1.4.127', title: 'Previous', description: '', releaseNotesUrl: '#' }
        ]
      }
      throw new Error(`unexpected invoke ${command}`)
    })

    installTauriUpdaterApi()
    const statuses: unknown[] = []
    window.api.updater.onStatus((status) => statuses.push(status))

    await window.api.updater.check({})

    expect(invokeMock).toHaveBeenCalledWith('updater_fetch_changelog_entries')
    expect(statuses).toContainEqual({
      state: 'available',
      version: '1.4.128',
      releaseUrl: 'https://github.com/nebutra/pebble/releases/tag/v1.4.128',
      changelog: {
        release: {
          title: 'Release popup polish',
          description: 'Update cards keep session state visible.',
          mediaUrl: 'https://www.nebutra.com/pebble/media/release-popup.gif',
          releaseNotesUrl: 'https://github.com/nebutra/pebble/releases/tag/v1.4.128'
        },
        releasesBehind: null
      }
    })
  })
})
