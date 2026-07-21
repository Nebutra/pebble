import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { requestRuntimeJsonMock, setPermissionMock, subscribeRuntimeEventPushMock } = vi.hoisted(
  () => ({
    requestRuntimeJsonMock: vi.fn(),
    setPermissionMock: vi.fn(),
    subscribeRuntimeEventPushMock: vi.fn()
  })
)

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))
vi.mock('./tauri-emulator-permissions-api', () => ({
  setNativeEmulatorPermission: setPermissionMock
}))
vi.mock('./tauri-runtime-event-push', () => ({
  subscribeRuntimeEventPush: subscribeRuntimeEventPushMock
}))

import { callTauriEmulatorRuntimeRpc } from './tauri-emulator-runtime-rpc'
import { resetTauriComputerActionWaiterForTests } from './tauri-computer-action-waiter'

const devices = [
  {
    id: 'emu-ios',
    nativeId: 'AAAAAAAA-0000-0000-0000-000000000001',
    name: 'iPhone 15',
    platform: 'ios',
    status: 'running'
  },
  {
    id: 'emu-android',
    nativeId: 'emulator-5554',
    name: 'Pixel',
    platform: 'android',
    status: 'running'
  }
]

describe('tauri-emulator-runtime-rpc', () => {
  beforeEach(() => {
    requestRuntimeJsonMock.mockReset().mockResolvedValue(devices)
    setPermissionMock.mockReset().mockResolvedValue({ ok: true, operationId: 'runtime-test' })
    subscribeRuntimeEventPushMock
      .mockReset()
      .mockImplementation(async (_onEvent: unknown, onState: (active: boolean) => void) => {
        onState(false)
        return { pushActive: false, supported: true, unsubscribe: vi.fn() }
      })
  })

  afterEach(() => resetTauriComputerActionWaiterForTests())

  it('lists authoritative devices and filters iOS simulators', async () => {
    await expect(callTauriEmulatorRuntimeRpc('emulator.listDevices', {})).resolves.toEqual({
      handled: true,
      result: devices
    })
    await expect(callTauriEmulatorRuntimeRpc('emulator.listSimulators', {})).resolves.toEqual({
      handled: true,
      result: [devices[0]]
    })
    await expect(callTauriEmulatorRuntimeRpc('emulator.availability', {})).resolves.toEqual({
      handled: true,
      result: expect.objectContaining({
        available: true,
        devices: [
          expect.objectContaining({ udid: devices[0].nativeId, state: 'Booted' }),
          expect.objectContaining({ udid: devices[1].nativeId, runtime: 'Android' })
        ],
        simctl: expect.objectContaining({ ok: true }),
        android: expect.objectContaining({ sdkFound: true })
      })
    })
  })

  it('lists authoritative Go emulator sessions', async () => {
    const sessions = [
      { id: 'session-1', deviceId: 'emu-ios', worktreeId: 'worktree-1', active: true }
    ]
    requestRuntimeJsonMock.mockResolvedValueOnce(sessions)

    await expect(callTauriEmulatorRuntimeRpc('emulator.list', {})).resolves.toEqual({
      handled: true,
      result: sessions
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/emulator/sessions', {
      method: 'GET'
    })
  })

  it('attaches a Go session and exposes the native Android video identity', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce(devices)
      .mockResolvedValueOnce({ id: 'session-1', deviceId: 'emu-android', active: true })

    await expect(
      callTauriEmulatorRuntimeRpc('emulator.attach', {
        device: 'emulator-5554',
        worktree: 'worktree-1'
      })
    ).resolves.toEqual({
      handled: true,
      result: expect.objectContaining({
        attached: true,
        info: expect.objectContaining({
          deviceUdid: 'emulator-5554',
          streamUrl: 'scrcpy://emulator-5554'
        })
      })
    })
    expect(requestRuntimeJsonMock).toHaveBeenLastCalledWith('/v1/emulator/sessions', {
      method: 'POST',
      body: { deviceId: 'emu-android', worktreeId: 'worktree-1' }
    })
  })

  it('queues controls against the active Go session and waits for native completion', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce([
        { id: 'session-1', deviceId: 'emu-android', worktreeId: 'worktree-1', active: true }
      ])
      .mockResolvedValueOnce({ id: 'action-1', status: 'queued' })
      .mockResolvedValueOnce([
        { id: 'action-1', kind: 'emulator.tap', status: 'completed', result: { ok: true } }
      ])

    await expect(
      callTauriEmulatorRuntimeRpc('emulator.tap', { worktree: 'worktree-1', x: 10, y: 20 })
    ).resolves.toEqual({ handled: true, result: { ok: true } })
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      2,
      '/v1/emulator/sessions/session-1/commands',
      {
        method: 'POST',
        body: {
          command: 'tap',
          payload: { worktree: 'worktree-1', x: 10, y: 20 }
        }
      }
    )
  })

  it('resolves a native device selector to its active runtime session', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce([
        { id: 'session-ios', deviceId: 'emu-ios', active: true },
        { id: 'session-android', deviceId: 'emu-android', active: true }
      ])
      .mockResolvedValueOnce(devices)
      .mockResolvedValueOnce({ id: 'action-1', status: 'queued' })
      .mockResolvedValueOnce([
        { id: 'action-1', kind: 'emulator.button', status: 'completed', result: { ok: true } }
      ])

    await callTauriEmulatorRuntimeRpc('emulator.button', {
      device: 'emulator-5554',
      name: 'home'
    })

    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      3,
      '/v1/emulator/sessions/session-android/commands',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('kills a provider session without shutting down its device', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce([
        { id: 'session-1', deviceId: 'emu-android', worktreeId: 'worktree-1', active: true }
      ])
      .mockResolvedValueOnce(devices)
      .mockResolvedValueOnce({ id: 'session-1', active: false })

    await expect(
      callTauriEmulatorRuntimeRpc('emulator.kill', { worktree: 'worktree-1' })
    ).resolves.toEqual({
      handled: true,
      result: { ok: true, deviceUdid: 'emulator-5554' }
    })
    expect(requestRuntimeJsonMock).toHaveBeenLastCalledWith('/v1/emulator/sessions/session-1', {
      method: 'DELETE'
    })
  })

  it('unregisters active sessions idempotently', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce([])

    await expect(
      callTauriEmulatorRuntimeRpc('emulator.unregisterActive', { worktree: 'missing' })
    ).resolves.toEqual({ handled: true, result: { ok: true } })
  })

  it('waits for native shutdown before detaching the Go session', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce([
        { id: 'session-1', deviceId: 'emu-android', worktreeId: 'worktree-1', active: true }
      ])
      .mockResolvedValueOnce(devices)
      .mockResolvedValueOnce({ id: 'action-1', status: 'queued' })
      .mockResolvedValueOnce([
        {
          id: 'action-1',
          kind: 'emulator.shutdown',
          status: 'completed',
          result: { deviceUdid: 'emulator-5554' }
        }
      ])
      .mockResolvedValueOnce({ id: 'session-1', active: false })

    await expect(
      callTauriEmulatorRuntimeRpc('emulator.shutdown', { worktree: 'worktree-1' })
    ).resolves.toEqual({
      handled: true,
      result: { deviceUdid: 'emulator-5554' }
    })
    expect(requestRuntimeJsonMock).toHaveBeenLastCalledWith('/v1/emulator/sessions/session-1', {
      method: 'DELETE'
    })
  })

  it('keeps managed-only shutdown idempotent when no session is active', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce([])

    await expect(
      callTauriEmulatorRuntimeRpc('emulator.shutdown', {
        worktree: 'missing',
        managedOnly: true
      })
    ).resolves.toEqual({ handled: true, result: { ok: true } })
  })

  it('resolves runtime device ids to native permission targets', async () => {
    await expect(
      callTauriEmulatorRuntimeRpc('emulator.permissions', {
        device: 'emu-ios',
        op: 'grant',
        package: 'com.example.app',
        permission: 'camera',
        timeoutMs: 2_000
      })
    ).resolves.toEqual({ handled: true, result: { ok: true } })
    expect(setPermissionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'ios',
        serial: 'AAAAAAAA-0000-0000-0000-000000000001',
        operation: 'grant',
        package: 'com.example.app',
        permission: 'camera',
        timeoutMs: 2_000
      })
    )
  })

  it('refuses legacy device records without a native identifier', async () => {
    requestRuntimeJsonMock.mockResolvedValue([
      { id: 'legacy', name: 'Legacy', platform: 'android', status: 'running' }
    ])
    await expect(
      callTauriEmulatorRuntimeRpc('emulator.permissions', { device: 'legacy', op: 'reset' })
    ).rejects.toThrow('no registered native identifier')
    expect(setPermissionMock).not.toHaveBeenCalled()
  })

  it('leaves unrelated methods for the main dispatcher', async () => {
    await expect(callTauriEmulatorRuntimeRpc('git.status', {})).resolves.toEqual({
      handled: false
    })
  })
})
