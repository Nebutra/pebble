import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, hasTauriInternalsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  hasTauriInternalsMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

vi.mock('./pebble-runtime-http-bridge', () => ({
  hasTauriInternals: hasTauriInternalsMock
}))

import {
  startEmulatorIosProvider,
  stopEmulatorIosProvider
} from './tauri-emulator-ios-provider-api'

describe('tauri-emulator-ios-provider-api', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    hasTauriInternalsMock.mockReset()
  })

  it('reports an honest gap without invoking Tauri when internals are absent', async () => {
    hasTauriInternalsMock.mockReturnValue(false)

    const result = await startEmulatorIosProvider()

    expect(result).toEqual({
      supported: false,
      platform: 'unknown',
      providerId: null,
      unsupportedReason: 'the iOS Simulator provider requires the Tauri desktop shell'
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('is a no-op stop when internals are absent', async () => {
    hasTauriInternalsMock.mockReturnValue(false)

    await stopEmulatorIosProvider()

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('forwards start to the Rust command when Tauri internals are present', async () => {
    hasTauriInternalsMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      supported: true,
      platform: 'macos',
      providerId: 'emulator:tauri-ios-simctl'
    })

    const result = await startEmulatorIosProvider({ runtimeUrl: 'http://127.0.0.1:17777' })

    expect(invokeMock).toHaveBeenCalledWith('start_emulator_ios_provider', {
      input: { runtimeUrl: 'http://127.0.0.1:17777', bearerToken: undefined }
    })
    expect(result.supported).toBe(true)
    expect(result.providerId).toBe('emulator:tauri-ios-simctl')
  })

  it('forwards stop to the Rust command when Tauri internals are present', async () => {
    hasTauriInternalsMock.mockReturnValue(true)
    invokeMock.mockResolvedValue(undefined)

    await stopEmulatorIosProvider()

    expect(invokeMock).toHaveBeenCalledWith('stop_emulator_ios_provider')
  })
})
