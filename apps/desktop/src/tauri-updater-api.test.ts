import { beforeEach, describe, expect, it, vi } from 'vitest'

const { checkMock, getVersionMock, invokeMock, relaunchMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  getVersionMock: vi.fn(() => Promise.resolve('1.4.124')),
  invokeMock: vi.fn(),
  relaunchMock: vi.fn()
}))

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: getVersionMock
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: checkMock,
  Update: class {
    constructor(metadata: Record<string, unknown>) {
      Object.assign(this, metadata)
    }

    close(): Promise<void> {
      return Promise.resolve()
    }
  }
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: relaunchMock
}))

import { installTauriUpdaterApi, resetTauriUpdaterStateForTests } from './tauri-updater-api'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('installTauriUpdaterApi', () => {
  beforeEach(async () => {
    await resetTauriUpdaterStateForTests()
    vi.clearAllMocks()
    checkMock.mockResolvedValue(null)
    globalThis.window = Object.assign(new EventTarget(), {
      __TAURI_INTERNALS__: {},
      api: {
        updater: {}
      }
    }) as unknown as Window & typeof globalThis
  })

  it('attaches Nebutra changelog data to available release statuses', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'updater_assert_install_ready') {
        return undefined
      }
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
      if (command === 'updater_check_release_tag') {
        return {
          rid: 128,
          currentVersion: '1.4.124',
          version: '1.4.128',
          rawJson: {}
        }
      }
      throw new Error(`unexpected invoke ${command}`)
    })

    installTauriUpdaterApi()
    const statuses: unknown[] = []
    window.api.updater.onStatus((status) => statuses.push(status))

    await window.api.updater.check({})

    expect(invokeMock).toHaveBeenCalledWith('updater_fetch_changelog_entries')
    expect(invokeMock).toHaveBeenCalledWith('updater_check_latest_release', {
      input: {
        currentVersion: '1.4.124',
        includePrerelease: false,
        includePerfPrerelease: false
      }
    })
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

  it('falls back to the Nebutra release feed when the signed updater check fails', async () => {
    checkMock.mockRejectedValue(new Error('signature endpoint unavailable'))
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'updater_assert_install_ready') {
        return undefined
      }
      if (command === 'updater_check_latest_release') {
        return {
          state: 'available',
          version: '1.4.129',
          tag: 'v1.4.129',
          releaseUrl: 'https://github.com/nebutra/pebble/releases/tag/v1.4.129'
        }
      }
      if (command === 'updater_fetch_changelog_entries') {
        return []
      }
      if (command === 'updater_check_release_tag') {
        return {
          rid: 129,
          currentVersion: '1.4.124',
          version: '1.4.129',
          rawJson: {}
        }
      }
      throw new Error(`unexpected invoke ${command}`)
    })
    installTauriUpdaterApi()
    const statuses: unknown[] = []
    window.api.updater.onStatus((status) => statuses.push(status))

    await window.api.updater.check({})

    expect(statuses).toContainEqual(
      expect.objectContaining({ state: 'available', version: '1.4.129' })
    )
  })

  it('reports an error when both signed updater and release feed checks fail', async () => {
    checkMock.mockRejectedValue(new Error('signature endpoint unavailable'))
    invokeMock.mockRejectedValue(new Error('GitHub release feed unavailable'))
    installTauriUpdaterApi()
    const statuses: unknown[] = []
    window.api.updater.onStatus((status) => statuses.push(status))

    await window.api.updater.check({})

    expect(statuses.at(-1)).toEqual(
      expect.objectContaining({
        state: 'error',
        message: expect.stringContaining('GitHub release feed unavailable')
      })
    )
  })

  it('reports a missing production updater key before starting a native download check', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'updater_assert_install_ready') {
        throw new Error(
          'This Pebble build has no production updater public key; signed updates cannot be installed.'
        )
      }
      if (command === 'updater_check_latest_release') {
        return {
          state: 'available',
          version: '1.4.129',
          tag: 'v1.4.129',
          releaseUrl: 'https://github.com/nebutra/pebble/releases/tag/v1.4.129'
        }
      }
      throw new Error(`unexpected invoke ${command}`)
    })
    installTauriUpdaterApi()

    await window.api.updater.check({})

    expect(checkMock).not.toHaveBeenCalled()
    expect(await window.api.updater.getStatus()).toEqual(
      expect.objectContaining({
        state: 'error',
        message: expect.stringContaining('no production updater public key')
      })
    )
  })

  it('prefers a signed native package without consulting the release fallback', async () => {
    checkMock.mockResolvedValue({ version: '1.4.130', close: vi.fn() })
    invokeMock.mockResolvedValue([])
    installTauriUpdaterApi()
    const statuses: unknown[] = []
    window.api.updater.onStatus((status) => statuses.push(status))

    await window.api.updater.check({})

    expect(statuses).toContainEqual(
      expect.objectContaining({ state: 'available', version: '1.4.130' })
    )
    expect(invokeMock).not.toHaveBeenCalledWith('updater_check_latest_release', expect.anything())
  })

  it('uses a tag-scoped signed manifest for explicit prerelease checks', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'updater_assert_install_ready') {
        return undefined
      }
      if (command === 'updater_check_latest_release') {
        return {
          state: 'available',
          version: '1.4.130-rc.2',
          tag: 'v1.4.130-rc.2',
          releaseUrl: 'https://github.com/nebutra/pebble/releases/tag/v1.4.130-rc.2'
        }
      }
      if (command === 'updater_check_release_tag') {
        return {
          rid: 130,
          currentVersion: '1.4.124',
          version: '1.4.130-rc.2',
          rawJson: {}
        }
      }
      if (command === 'updater_fetch_changelog_entries') {
        return []
      }
      throw new Error(`unexpected invoke ${command}`)
    })
    installTauriUpdaterApi()

    await window.api.updater.check({ includePrerelease: true })

    expect(checkMock).not.toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledWith('updater_check_release_tag', {
      input: { tag: 'v1.4.130-rc.2' }
    })
    expect(await window.api.updater.getStatus()).toEqual(
      expect.objectContaining({ state: 'available', version: '1.4.130-rc.2' })
    )
  })

  it('joins duplicate checks instead of starting competing updater resources', async () => {
    const nativeCheck = deferred<null>()
    checkMock.mockReturnValue(nativeCheck.promise)
    invokeMock.mockResolvedValue({ state: 'not-available' })
    installTauriUpdaterApi()

    const first = window.api.updater.check({})
    const second = window.api.updater.check({})

    await vi.waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1))
    nativeCheck.resolve(null)
    await Promise.all([first, second])
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it('serializes download behind a check and ignores duplicate download requests', async () => {
    const nativeCheck = deferred<{
      version: string
      download: ReturnType<typeof vi.fn>
      install: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
    }>()
    const download = deferred<void>()
    const update = {
      version: '1.4.131',
      download: vi.fn(() => download.promise),
      install: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    }
    checkMock.mockReturnValue(nativeCheck.promise)
    invokeMock.mockResolvedValue([])
    installTauriUpdaterApi()

    const check = window.api.updater.check({})
    const firstDownload = window.api.updater.download()
    const secondDownload = window.api.updater.download()
    nativeCheck.resolve(update)
    await check

    expect(update.download).toHaveBeenCalledTimes(1)
    download.resolve()
    await Promise.all([firstDownload, secondDownload])
    expect(update.install).toHaveBeenCalledTimes(1)
    expect(await window.api.updater.getStatus()).toEqual(
      expect.objectContaining({ state: 'downloaded', version: '1.4.131' })
    )
  })

  it('does not replace download progress with a concurrent manual check', async () => {
    const download = deferred<void>()
    const update = {
      version: '1.4.132',
      download: vi.fn(() => download.promise),
      install: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    }
    checkMock.mockResolvedValue(update)
    invokeMock.mockResolvedValue([])
    installTauriUpdaterApi()
    await window.api.updater.check({})

    const pendingDownload = window.api.updater.download()
    await window.api.updater.check({ includePrerelease: true })

    expect(checkMock).toHaveBeenCalledTimes(1)
    expect(await window.api.updater.getStatus()).toEqual(
      expect.objectContaining({ state: 'downloading', version: '1.4.132' })
    )
    download.resolve()
    await pendingDownload
  })

  it('latches a successful relaunch so duplicate install requests are ignored', async () => {
    const update = {
      version: '1.4.133',
      download: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    }
    checkMock.mockResolvedValue(update)
    invokeMock.mockResolvedValue([])
    relaunchMock.mockResolvedValue(undefined)
    installTauriUpdaterApi()
    await window.api.updater.check({})
    await window.api.updater.download()

    await Promise.all([window.api.updater.quitAndInstall(), window.api.updater.quitAndInstall()])

    expect(relaunchMock).toHaveBeenCalledTimes(1)
  })

  it('allows relaunch retry after the native process plugin rejects', async () => {
    const update = {
      version: '1.4.134',
      download: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    }
    checkMock.mockResolvedValue(update)
    invokeMock.mockResolvedValue([])
    relaunchMock.mockRejectedValueOnce(new Error('relaunch denied')).mockResolvedValue(undefined)
    installTauriUpdaterApi()
    await window.api.updater.check({})
    await window.api.updater.download()

    await expect(window.api.updater.quitAndInstall()).rejects.toThrow('relaunch denied')
    await expect(window.api.updater.quitAndInstall()).resolves.toBeUndefined()

    expect(relaunchMock).toHaveBeenCalledTimes(2)
  })
})
