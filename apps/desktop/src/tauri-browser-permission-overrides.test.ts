// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TauriBrowserPermissionWindow } from '@/components/browser-pane/tauri-browser-permission-profile'

const { invokeMock, requestRuntimeJsonMock, runtimePush, subscribeRuntimeEventPushMock } =
  vi.hoisted(() => {
    const runtimePush: { handler?: (entry: { topic: string; data: string }) => void } = {}
    return {
      invokeMock: vi.fn(),
      requestRuntimeJsonMock: vi.fn(),
      runtimePush,
      subscribeRuntimeEventPushMock: vi.fn(async (handler) => {
        runtimePush.handler = handler
        return { supported: true }
      })
    }
  })

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))
vi.mock('./tauri-runtime-event-push', () => ({
  subscribeRuntimeEventPush: subscribeRuntimeEventPushMock
}))
vi.mock('./runtime-bridge', () => ({
  createRuntimeEventStreamCommand: vi.fn((input) => input),
  readRuntimeEventStream: vi.fn()
}))
vi.mock('./tauri-browser-device-access', () => ({
  getTauriBrowserDeviceAccessCapabilities: vi.fn(),
  resolveTauriBrowserDeviceSelection: vi.fn()
}))

import {
  installTauriBrowserPermissionOverrideBridge,
  persistTauriBrowserPermissionOverride,
  readRuntimeBrowserPermissionOverride,
  syncTauriBrowserPermissionOverrideEvent
} from './tauri-browser-permission-overrides'

describe('Tauri browser permission override synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invokeMock.mockResolvedValue({ applied: 1, ignored: 0 })
    delete (window as TauriBrowserPermissionWindow).__pebbleTauriBrowserPermissionOverrides
  })

  it('hydrates persisted profile permissions into the native registry', async () => {
    const permission = {
      id: 'bperm_1',
      profileId: 'bprof_hydrate',
      origin: 'https://example.test',
      name: 'camera',
      state: 'denied',
      updatedAt: '2026-07-17T08:00:00Z'
    }
    requestRuntimeJsonMock.mockResolvedValue([permission, { state: 'invalid' }])
    installTauriBrowserPermissionOverrideBridge()

    await (
      window as TauriBrowserPermissionWindow
    ).__pebbleTauriBrowserPermissionOverrides?.ensureProfile('bprof_hydrate')

    expect(
      (window as TauriBrowserPermissionWindow).__pebbleTauriBrowserPermissionOverrides
        ?.deviceCapabilities
    ).toBeTypeOf('function')
    expect(
      (window as TauriBrowserPermissionWindow).__pebbleTauriBrowserPermissionOverrides
        ?.setPermission
    ).toBeTypeOf('function')
    expect(
      (window as TauriBrowserPermissionWindow).__pebbleTauriBrowserPermissionOverrides
        ?.resolveDeviceSelection
    ).toBeTypeOf('function')

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/browser/permissions?profileId=bprof_hydrate',
      { method: 'GET', timeoutMs: 5_000 }
    )
    expect(invokeMock).toHaveBeenCalledWith('browser_permission_overrides_sync', {
      input: {
        overrides: [
          {
            profileId: 'bprof_hydrate',
            origin: 'https://example.test',
            name: 'camera',
            state: 'denied',
            updatedAt: '2026-07-17T08:00:00Z'
          }
        ]
      }
    })
  })

  it('pushes valid browser.changed permission records immediately', async () => {
    installTauriBrowserPermissionOverrideBridge()
    await vi.waitFor(() => expect(runtimePush.handler).toBeTypeOf('function'))
    runtimePush.handler?.({
      topic: 'browser.changed',
      data: JSON.stringify({
        topic: 'browser.changed',
        payload: {
          origin: 'https://example.test',
          name: 'geolocation',
          state: 'granted',
          updatedAt: '2026-07-17T08:00:01Z'
        }
      })
    })

    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('browser_permission_overrides_sync', {
        input: {
          overrides: [
            {
              origin: 'https://example.test',
              name: 'geolocation',
              state: 'granted',
              updatedAt: '2026-07-17T08:00:01Z'
            }
          ]
        }
      })
    )
  })

  it('rejects malformed runtime records at the renderer boundary', () => {
    expect(readRuntimeBrowserPermissionOverride({ name: 'camera', state: 'granted' })).toBeNull()
    expect(syncTauriBrowserPermissionOverrideEvent({ origin: 'https://example.test' })).toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('persists an explicit device decision before applying it to native policy', async () => {
    const persisted = {
      profileId: 'bprof_security',
      origin: 'https://login.example.test',
      name: 'hid',
      state: 'granted',
      updatedAt: '2026-07-17T09:00:00Z'
    }
    requestRuntimeJsonMock.mockResolvedValue(persisted)

    await expect(
      persistTauriBrowserPermissionOverride({
        profileId: 'bprof_security',
        origin: 'https://login.example.test',
        name: 'hid',
        state: 'granted'
      })
    ).resolves.toEqual(persisted)

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/browser/permissions', {
      method: 'POST',
      body: {
        profileId: 'bprof_security',
        origin: 'https://login.example.test',
        name: 'hid',
        state: 'granted'
      },
      timeoutMs: 5_000
    })
    expect(invokeMock).toHaveBeenCalledWith('browser_permission_overrides_sync', {
      input: { overrides: [persisted] }
    })
  })

  it('does not apply a malformed persisted device decision', async () => {
    requestRuntimeJsonMock.mockResolvedValue({
      origin: 'https://login.example.test',
      name: 'camera',
      state: 'granted',
      updatedAt: '2026-07-17T09:00:00Z'
    })

    await expect(
      persistTauriBrowserPermissionOverride({
        origin: 'https://login.example.test',
        name: 'webauthn',
        state: 'denied'
      })
    ).rejects.toThrow('invalid browser permission')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('persists a profile and origin scoped media grant before native sync', async () => {
    const persisted = {
      profileId: 'bprof_calls',
      origin: 'https://meet.example.test',
      name: 'media',
      state: 'granted',
      updatedAt: '2026-07-17T09:05:00Z'
    }
    requestRuntimeJsonMock.mockResolvedValue(persisted)

    await expect(
      persistTauriBrowserPermissionOverride({
        profileId: 'bprof_calls',
        origin: 'https://meet.example.test',
        name: 'media',
        state: 'granted'
      })
    ).resolves.toEqual(persisted)

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/browser/permissions', {
      method: 'POST',
      body: {
        profileId: 'bprof_calls',
        origin: 'https://meet.example.test',
        name: 'media',
        state: 'granted'
      },
      timeoutMs: 5_000
    })
    expect(invokeMock).toHaveBeenCalledWith('browser_permission_overrides_sync', {
      input: { overrides: [persisted] }
    })
  })
})
