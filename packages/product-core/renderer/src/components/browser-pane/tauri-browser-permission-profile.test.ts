// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PEBBLE_BROWSER_PARTITION } from '../../../../shared/constants'
import {
  ensureTauriBrowserPermissionProfile,
  tauriBrowserPermissionProfileId,
  type TauriBrowserPermissionWindow
} from './tauri-browser-permission-profile'

describe('Tauri browser permission profiles', () => {
  afterEach(() => {
    delete (window as TauriBrowserPermissionWindow).__pebbleTauriBrowserPermissionOverrides
  })

  it('maps the default and runtime profile partitions to Go profile ids', () => {
    expect(tauriBrowserPermissionProfileId(PEBBLE_BROWSER_PARTITION)).toBe('')
    expect(tauriBrowserPermissionProfileId('persist:pebble-browser-session-bprof_123')).toBe(
      'bprof_123'
    )
    expect(tauriBrowserPermissionProfileId('persist:unrelated')).toBe('')
  })

  it('hydrates the profile before returning it to child WebView creation', async () => {
    const ensureProfile = vi.fn(async () => undefined)
    ;(window as TauriBrowserPermissionWindow).__pebbleTauriBrowserPermissionOverrides = {
      ensureProfile
    }

    await expect(
      ensureTauriBrowserPermissionProfile('persist:pebble-browser-session-bprof_456')
    ).resolves.toBe('bprof_456')
    expect(ensureProfile).toHaveBeenCalledWith('bprof_456')
  })

  it('retains safe native defaults when runtime hydration is unavailable', async () => {
    ;(window as TauriBrowserPermissionWindow).__pebbleTauriBrowserPermissionOverrides = {
      ensureProfile: vi.fn(async () => {
        throw new Error('runtime unavailable')
      })
    }

    await expect(ensureTauriBrowserPermissionProfile(PEBBLE_BROWSER_PARTITION)).resolves.toBe('')
  })
})
