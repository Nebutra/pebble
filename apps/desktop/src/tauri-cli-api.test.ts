// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { CliInstallStatus } from '../../../packages/product-core/shared/cli-install-types'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

import { createPebbleCliApi } from './tauri-cli-api'

function status(state: CliInstallStatus['state']): CliInstallStatus {
  return {
    platform: 'darwin',
    commandName: 'pebble',
    commandPath: '/Users/test/.local/bin/pebble',
    pathDirectory: '/Users/test/.local/bin',
    pathConfigured: true,
    launcherPath: '/Applications/Pebble.app/Contents/MacOS/Pebble',
    installMethod: 'symlink',
    supported: true,
    state,
    currentTarget: '/Applications/Pebble.app/Contents/MacOS/Pebble',
    unsupportedReason: null,
    detail: 'Registered a user-scoped symlink in ~/.local/bin.'
  }
}

describe('createPebbleCliApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  })

  it('routes CLI status, install, and remove through native Tauri commands', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'cli_install_status') {
        return status('not_installed')
      }
      if (command === 'cli_install') {
        return status('installed')
      }
      if (command === 'cli_remove') {
        return status('not_installed')
      }
      throw new Error(`unexpected command: ${command}`)
    })

    const api = createPebbleCliApi({} as PreloadApi['cli'])

    await expect(api.getInstallStatus()).resolves.toMatchObject({ state: 'not_installed' })
    await expect(api.install()).resolves.toMatchObject({ state: 'installed' })
    await expect(api.remove()).resolves.toMatchObject({ state: 'not_installed' })

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'cli_install_status',
      'cli_install',
      'cli_remove'
    ])
  })

  it('does not report native success when the Tauri command bridge is absent', async () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    invokeMock.mockResolvedValue(status('installed'))

    const api = createPebbleCliApi({} as PreloadApi['cli'])

    await expect(api.install()).resolves.toMatchObject({
      supported: false,
      state: 'unsupported',
      unsupportedReason: 'launch_mode_unavailable'
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('preserves native bridge failures instead of misreporting platform support', async () => {
    invokeMock.mockRejectedValue(new Error('invoke channel closed'))
    const api = createPebbleCliApi({} as PreloadApi['cli'])

    await expect(api.install()).rejects.toThrow('invoke channel closed')
    await expect(api.installWsl({ distro: 'Ubuntu' })).rejects.toThrow('invoke channel closed')
  })

  it('routes WSL registration through native commands with the selected distro', async () => {
    invokeMock.mockImplementation(async (command: string) => ({
      ...status(command === 'cli_wsl_remove' ? 'not_installed' : 'installed'),
      platform: 'linux',
      commandName: 'pebble'
    }))
    const api = createPebbleCliApi({} as PreloadApi['cli'])

    await expect(api.getWslInstallStatus({ distro: ' Ubuntu ' })).resolves.toMatchObject({
      platform: 'linux',
      commandName: 'pebble',
      state: 'installed'
    })
    await expect(api.installWsl({ distro: null })).resolves.toMatchObject({ state: 'installed' })
    await expect(api.removeWsl()).resolves.toMatchObject({ state: 'not_installed' })
    expect(invokeMock.mock.calls).toEqual([
      ['cli_wsl_install_status', { input: { distro: 'Ubuntu' } }],
      ['cli_wsl_install', { input: { distro: null } }],
      ['cli_wsl_remove', { input: { distro: null } }]
    ])
  })
})
