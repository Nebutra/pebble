// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearPersistentSettingsBackends,
  readPersistentSettingsRaw,
  writePersistentSettingsRaw
} from '@/web/persistent-settings-backend'
import {
  MOBILE_AUTO_RESTORE_FIT_MAX_MS,
  MOBILE_AUTO_RESTORE_FIT_MIN_MS,
  readTauriMobileAutoRestoreFitMs,
  writeTauriMobileAutoRestoreFitMs
} from './tauri-mobile-fit-preference'
import { callTauriTerminalDisplayRuntimeRpc } from './tauri-terminal-display-runtime-rpc'

const SETTINGS_KEY = 'pebble.web.settings.v1'
const unusedDisplayDeps = {
  hasPty: async () => true,
  resizeMobile: async () => {},
  hasFitOverride: () => false,
  setMobileFit: () => {},
  setMobileDriver: () => {},
  restoreDesktopFit: async () => ({ restored: false })
}

describe('Tauri mobile fit preference', () => {
  beforeEach(() => {
    clearPersistentSettingsBackends()
    window.localStorage.clear()
  })

  it('uses null as the indefinite default', async () => {
    expect(readTauriMobileAutoRestoreFitMs()).toBeNull()
    await expect(
      callTauriTerminalDisplayRuntimeRpc('terminal.getAutoRestoreFit', {}, unusedDisplayDeps)
    ).resolves.toEqual({ handled: true, result: { ms: null } })
  })

  it('clamps finite values to the Electron range and preserves unrelated settings', () => {
    writePersistentSettingsRaw(SETTINGS_KEY, JSON.stringify({ theme: 'dark' }))

    expect(writeTauriMobileAutoRestoreFitMs(1)).toBe(MOBILE_AUTO_RESTORE_FIT_MIN_MS)
    expect(readTauriMobileAutoRestoreFitMs()).toBe(MOBILE_AUTO_RESTORE_FIT_MIN_MS)
    expect(writeTauriMobileAutoRestoreFitMs(Number.MAX_SAFE_INTEGER)).toBe(
      MOBILE_AUTO_RESTORE_FIT_MAX_MS
    )
    expect(JSON.parse(readPersistentSettingsRaw(SETTINGS_KEY) ?? '{}')).toMatchObject({
      theme: 'dark',
      mobileAutoRestoreFitMs: MOBILE_AUTO_RESTORE_FIT_MAX_MS
    })
  })

  it('persists null and rejects non-number RPC values', async () => {
    await expect(
      callTauriTerminalDisplayRuntimeRpc(
        'terminal.setAutoRestoreFit',
        { ms: null },
        unusedDisplayDeps
      )
    ).resolves.toEqual({ handled: true, result: { ms: null } })
    await expect(
      callTauriTerminalDisplayRuntimeRpc(
        'terminal.setAutoRestoreFit',
        { ms: 'soon' },
        unusedDisplayDeps
      )
    ).rejects.toThrow('invalid_auto_restore_fit_ms')
  })
})
