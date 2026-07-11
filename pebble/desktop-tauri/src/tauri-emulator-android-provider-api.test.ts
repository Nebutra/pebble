import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, getRuntimeResourceJsonMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  getRuntimeResourceJsonMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

vi.mock('./runtime-bridge', () => ({
  createRuntimeResourceGetCommand: (input: { path: string; timeoutMs?: number }) => ({
    runtimeUrl: 'http://127.0.0.1:17777',
    path: input.path,
    bearerToken: null,
    timeoutMs: input.timeoutMs ?? 1500
  }),
  getRuntimeResourceJson: getRuntimeResourceJsonMock
}))

import {
  listRuntimeEmulatorDevices,
  startEmulatorAndroidProvider,
  stopEmulatorAndroidProvider
} from './tauri-emulator-android-provider-api'

// Why: this vitest project runs with `environment: 'node'` (no jsdom), so
// `window` is not a pre-existing global like it would be in a browser or
// jsdom test — stub a minimal object rather than assuming one exists.
function setTauriInternalsPresent(present: boolean): void {
  const globalWithWindow = globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }
  if (!present) {
    delete globalWithWindow.window
    return
  }
  globalWithWindow.window = { __TAURI_INTERNALS__: {} }
}

describe('tauri-emulator-android-provider-api', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    getRuntimeResourceJsonMock.mockReset()
  })

  afterEach(() => {
    setTauriInternalsPresent(false)
  })

  it('reports an honest gap without invoking Tauri when internals are absent', async () => {
    setTauriInternalsPresent(false)

    const result = await startEmulatorAndroidProvider()

    expect(result).toEqual({
      supported: false,
      platform: 'unknown',
      providerId: null,
      unsupportedReason: 'the Android adapter requires the Tauri desktop shell'
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('is a no-op stop when internals are absent', async () => {
    setTauriInternalsPresent(false)

    await stopEmulatorAndroidProvider()

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('forwards start to the Rust command when Tauri internals are present', async () => {
    setTauriInternalsPresent(true)
    invokeMock.mockResolvedValue({
      supported: true,
      platform: 'linux',
      providerId: 'emulator:tauri-android-adb'
    })

    const result = await startEmulatorAndroidProvider({ runtimeUrl: 'http://127.0.0.1:17777' })

    expect(invokeMock).toHaveBeenCalledWith('start_emulator_android_provider', {
      input: { runtimeUrl: 'http://127.0.0.1:17777', bearerToken: undefined }
    })
    expect(result.supported).toBe(true)
    expect(result.providerId).toBe('emulator:tauri-android-adb')
  })

  it('surfaces a missing-toolchain gap forwarded from the Rust command', async () => {
    setTauriInternalsPresent(true)
    invokeMock.mockResolvedValue({
      supported: false,
      platform: 'linux',
      providerId: null,
      unsupportedReason:
        'the Android adapter requires the Android SDK command-line tools (adb, emulator) on PATH; install Android Studio\'s SDK platform-tools and emulator packages, or add them to PATH manually'
    })

    const result = await startEmulatorAndroidProvider()

    expect(result.supported).toBe(false)
    expect(result.unsupportedReason).toContain('adb')
  })

  it('forwards stop to the Rust command when Tauri internals are present', async () => {
    setTauriInternalsPresent(true)
    invokeMock.mockResolvedValue(undefined)

    await stopEmulatorAndroidProvider()

    expect(invokeMock).toHaveBeenCalledWith('stop_emulator_android_provider')
  })

  it('reads the persisted device list from the runtime resource bridge', async () => {
    getRuntimeResourceJsonMock.mockResolvedValue({
      runtimeUrl: 'http://127.0.0.1:17777',
      requestPath: '/v1/emulator/devices',
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify([
        {
          id: 'emu_2',
          name: 'Pixel_API_37',
          platform: 'android',
          status: 'running',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z'
        }
      ]),
      error: null
    })

    const devices = await listRuntimeEmulatorDevices()

    expect(devices).toHaveLength(1)
    expect(devices[0]?.id).toBe('emu_2')
    expect(devices[0]?.platform).toBe('android')
  })

  it('returns an empty list when the runtime resource body is absent', async () => {
    getRuntimeResourceJsonMock.mockResolvedValue({
      runtimeUrl: 'http://127.0.0.1:17777',
      requestPath: '/v1/emulator/devices',
      transport: 'unreachable',
      httpStatus: null,
      body: null,
      error: 'connection refused'
    })

    const devices = await listRuntimeEmulatorDevices()

    expect(devices).toEqual([])
  })
})
