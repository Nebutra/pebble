import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import {
  cancelNativeEmulatorPermission,
  setNativeEmulatorPermission
} from './tauri-emulator-permissions-api'

function setTauriInternals(present: boolean): void {
  const target = globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }
  if (present) {
    target.window = { __TAURI_INTERNALS__: {} }
  } else {
    delete target.window
  }
}

describe('tauri-emulator-permissions-api', () => {
  beforeEach(() => invokeMock.mockReset())
  afterEach(() => setTauriInternals(false))

  it('forwards Android permission operations to the native bounded bridge', async () => {
    setTauriInternals(true)
    invokeMock.mockResolvedValue({ ok: true, operationId: 'permission-1' })

    await expect(
      setNativeEmulatorPermission({
        platform: 'android',
        operationId: 'permission-1',
        serial: 'emulator-5554',
        operation: 'grant',
        package: 'com.example.app',
        permission: 'android.permission.CAMERA',
        timeoutMs: 2_000
      })
    ).resolves.toEqual({ ok: true, operationId: 'permission-1' })
    expect(invokeMock).toHaveBeenCalledWith('emulator_android_permission_set', {
      input: {
        operationId: 'permission-1',
        serial: 'emulator-5554',
        operation: 'grant',
        package: 'com.example.app',
        permission: 'android.permission.CAMERA',
        timeoutMs: 2_000
      }
    })
  })

  it('cancels an active native permission operation by id', async () => {
    setTauriInternals(true)
    invokeMock.mockResolvedValue({ cancelled: true })
    await expect(cancelNativeEmulatorPermission('permission-1')).resolves.toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('emulator_android_permission_cancel', {
      operationId: 'permission-1'
    })
  })

  it('forwards iOS permission operations to the native simctl bridge', async () => {
    setTauriInternals(true)
    invokeMock.mockResolvedValue({ ok: true, operationId: 'permission-1' })
    await expect(
      setNativeEmulatorPermission({
        platform: 'ios',
        operationId: 'permission-1',
        serial: 'simulator-1',
        operation: 'grant',
        package: 'com.example.app',
        permission: 'camera'
      })
    ).resolves.toEqual({ ok: true, operationId: 'permission-1' })
    expect(invokeMock).toHaveBeenCalledWith('emulator_ios_permission_set', {
      input: {
        operationId: 'permission-1',
        serial: 'simulator-1',
        operation: 'grant',
        package: 'com.example.app',
        permission: 'camera',
        timeoutMs: undefined
      }
    })
  })

  it('cancels iOS permission operations through their native registry', async () => {
    setTauriInternals(true)
    invokeMock.mockResolvedValue({ cancelled: true })
    await expect(cancelNativeEmulatorPermission('permission-1', 'ios')).resolves.toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('emulator_ios_permission_cancel', {
      operationId: 'permission-1'
    })
  })

  it('returns typed unsupported outside the Tauri shell', async () => {
    const error = await setNativeEmulatorPermission({
      platform: 'android',
      operationId: 'permission-1',
      serial: 'emulator-5554',
      operation: 'reset'
    }).catch((value: unknown) => value)
    expect(error).toMatchObject({ code: 'emulator_unsupported', platform: 'android' })
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
