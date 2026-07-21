import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import {
  getTauriBrowserDeviceAccessCapabilities,
  resolveTauriBrowserDeviceSelection
} from './tauri-browser-device-access'

describe('Tauri browser device access', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports native hook capabilities without treating engine support as selection support', async () => {
    invokeMock.mockResolvedValue({
      platform: 'macos',
      persistentOverrides: true,
      webauthnEngine: 'native-platform-dependent',
      hidPermissionHook: 'unavailable',
      hidSelectionHook: 'unavailable',
      webauthnAccountSelectionHook: 'unavailable',
      reason: 'WKWebView does not expose selection hooks'
    })

    await expect(getTauriBrowserDeviceAccessCapabilities()).resolves.toMatchObject({
      webauthnEngine: 'native-platform-dependent',
      hidSelectionHook: 'unavailable'
    })
    expect(invokeMock).toHaveBeenCalledWith('browser_device_access_capabilities')
  })

  it('normalizes bounded device candidates for the native fail-closed resolver', async () => {
    invokeMock.mockResolvedValue({
      status: 'unsupported',
      code: 'native_selection_hook_unavailable'
    })

    await expect(
      resolveTauriBrowserDeviceSelection({
        profileId: 'bprof_security',
        origin: 'https://login.example.test',
        kind: 'hid',
        candidates: [{ id: 'security-key-1', usagePages: [0xf1d0] }, { id: 'unknown' }]
      })
    ).resolves.toEqual({
      status: 'unsupported',
      code: 'native_selection_hook_unavailable'
    })
    expect(invokeMock).toHaveBeenCalledWith('browser_device_selection_resolve', {
      input: {
        profileId: 'bprof_security',
        origin: 'https://login.example.test',
        kind: 'hid',
        candidates: [
          { id: 'security-key-1', usagePages: [0xf1d0] },
          { id: 'unknown', usagePages: [] }
        ]
      }
    })
  })

  it('never upgrades a typed denial into a selected result', async () => {
    invokeMock.mockResolvedValue({ status: 'denied', code: 'explicit_grant_required' })

    const result = await resolveTauriBrowserDeviceSelection({
      origin: 'https://login.example.test',
      kind: 'webauthn-account',
      candidates: [{ id: 'credential-1' }]
    })

    expect(result.status).toBe('denied')
    expect(result.selectedId).toBeUndefined()
  })
})
