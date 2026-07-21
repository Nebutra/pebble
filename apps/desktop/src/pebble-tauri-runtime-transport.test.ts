// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeBridgeModule from './runtime-bridge'

const bridge = vi.hoisted(() => ({
  getRuntimeProcessStatus: vi.fn(),
  getRuntimeResourceJson: vi.fn(),
  probeRuntimeStatus: vi.fn(),
  requestRuntimeResourceJson: vi.fn(),
  startRuntimeProcess: vi.fn()
}))

vi.mock('./runtime-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeBridgeModule>()),
  ...bridge
}))

describe('Pebble runtime readiness coordinator', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.stubEnv('VITE_TAURI_PARITY_CAPTURE', 'false')
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {}
    })
    bridge.getRuntimeProcessStatus.mockResolvedValue({ running: true })
    bridge.startRuntimeProcess.mockResolvedValue({ running: true })
  })

  it('does not probe or spawn a runtime for deterministic parity capture', async () => {
    vi.stubEnv('VITE_TAURI_PARITY_CAPTURE', 'true')
    const { ensurePebbleRuntimeProcess, readPebbleStatusOrNull } =
      await import('./pebble-tauri-runtime-transport')

    await expect(ensurePebbleRuntimeProcess()).resolves.toBeUndefined()
    await expect(readPebbleStatusOrNull()).resolves.toBeNull()
    expect(bridge.probeRuntimeStatus).not.toHaveBeenCalled()
    expect(bridge.startRuntimeProcess).not.toHaveBeenCalled()
  })

  it('waits when the process exists but its HTTP listener is not ready', async () => {
    bridge.probeRuntimeStatus
      .mockResolvedValueOnce({ transport: 'disconnected' })
      .mockResolvedValueOnce({ transport: 'disconnected' })
      .mockResolvedValueOnce({ transport: 'connected', body: '{}' })
    const { ensurePebbleRuntimeProcess } = await import('./pebble-tauri-runtime-transport')

    const ready = ensurePebbleRuntimeProcess()
    await vi.advanceTimersByTimeAsync(25)

    await expect(ready).resolves.toBeUndefined()
    expect(bridge.startRuntimeProcess).not.toHaveBeenCalled()
    expect(bridge.probeRuntimeStatus).toHaveBeenCalledTimes(3)
  })

  it('shares one spawn and readiness wait across concurrent callers', async () => {
    bridge.getRuntimeProcessStatus
      .mockResolvedValueOnce({ running: false })
      .mockResolvedValue({ running: true })
    bridge.probeRuntimeStatus
      .mockResolvedValueOnce({ transport: 'disconnected' })
      .mockResolvedValueOnce({ transport: 'disconnected' })
      .mockResolvedValueOnce({ transport: 'disconnected' })
      .mockResolvedValue({ transport: 'connected', body: '{}' })
    const { ensurePebbleRuntimeProcess } = await import('./pebble-tauri-runtime-transport')

    const first = ensurePebbleRuntimeProcess()
    const second = ensurePebbleRuntimeProcess()
    await vi.advanceTimersByTimeAsync(25)

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(bridge.startRuntimeProcess).toHaveBeenCalledTimes(1)
  })

  it('recovers when the first child exits during desktop runtime handoff', async () => {
    bridge.probeRuntimeStatus
      .mockResolvedValueOnce({ transport: 'disconnected' })
      .mockResolvedValueOnce({ transport: 'disconnected' })
      .mockResolvedValueOnce({ transport: 'disconnected' })
      .mockResolvedValueOnce({ transport: 'disconnected' })
      .mockResolvedValueOnce({ transport: 'disconnected' })
      .mockResolvedValueOnce({ transport: 'disconnected' })
      .mockResolvedValue({ transport: 'connected', body: '{}' })
    bridge.getRuntimeProcessStatus.mockResolvedValue({
      running: false,
      error: 'runtime exited with code 1'
    })
    const { ensurePebbleRuntimeProcess } = await import('./pebble-tauri-runtime-transport')

    const ready = ensurePebbleRuntimeProcess()
    await vi.advanceTimersByTimeAsync(150)

    await expect(ready).resolves.toBeUndefined()
    expect(bridge.startRuntimeProcess).toHaveBeenCalledTimes(2)
  })

  it('reports the last concrete process error after bounded retries fail', async () => {
    bridge.probeRuntimeStatus.mockResolvedValue({ transport: 'disconnected' })
    bridge.getRuntimeProcessStatus.mockResolvedValue({
      running: false,
      error: 'runtime exited with code 2'
    })
    bridge.startRuntimeProcess.mockRejectedValue(new Error('runtime exited with code 2'))
    const { ensurePebbleRuntimeProcess } = await import('./pebble-tauri-runtime-transport')

    const rejection = expect(ensurePebbleRuntimeProcess()).rejects.toThrow(
      'runtime exited with code 2'
    )
    await vi.advanceTimersByTimeAsync(8_000)

    await rejection
    expect(bridge.startRuntimeProcess.mock.calls.length).toBeGreaterThan(1)
  })

  it('does not issue a native JSON request until readiness is proven', async () => {
    bridge.probeRuntimeStatus
      .mockResolvedValueOnce({ transport: 'disconnected' })
      .mockResolvedValueOnce({ transport: 'disconnected' })
      .mockResolvedValueOnce({ transport: 'connected', body: '{}' })
    bridge.getRuntimeResourceJson.mockResolvedValue({
      transport: 'connected',
      httpStatus: 200,
      body: '{"ok":true}'
    })
    const { requestRuntimeJson } = await import('./pebble-tauri-runtime-transport')

    const request = requestRuntimeJson<{ ok: boolean }>('/v1/test', { method: 'GET' })
    expect(bridge.getRuntimeResourceJson).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(25)

    await expect(request).resolves.toEqual({ ok: true })
    expect(bridge.getRuntimeResourceJson).toHaveBeenCalledTimes(1)
  })

  it('restarts and retries once when the runtime refuses the request connection', async () => {
    bridge.probeRuntimeStatus
      .mockResolvedValueOnce({ transport: 'connected', body: '{}' })
      .mockResolvedValueOnce({
        transport: 'unreachable',
        error: 'Connection refused (os error 61)'
      })
      .mockResolvedValueOnce({
        transport: 'unreachable',
        error: 'Connection refused (os error 61)'
      })
      .mockResolvedValueOnce({ transport: 'connected', body: '{}' })
    bridge.getRuntimeProcessStatus
      .mockResolvedValueOnce({ running: false, exitCode: 1 })
      .mockResolvedValue({ running: true })
    bridge.getRuntimeResourceJson
      .mockResolvedValueOnce({
        transport: 'unreachable',
        httpStatus: null,
        body: null,
        error: 'Connection refused (os error 61)'
      })
      .mockResolvedValueOnce({
        transport: 'connected',
        httpStatus: 200,
        body: '{"recovered":true}'
      })
    const { requestRuntimeJson } = await import('./pebble-tauri-runtime-transport')

    const request = requestRuntimeJson<{ recovered: boolean }>('/v1/test', { method: 'GET' })
    await vi.advanceTimersByTimeAsync(25)

    await expect(request).resolves.toEqual({ recovered: true })
    expect(bridge.startRuntimeProcess).toHaveBeenCalledTimes(1)
    expect(bridge.getRuntimeResourceJson).toHaveBeenCalledTimes(2)
  })

  it('does not retry HTTP failures that may have reached the runtime', async () => {
    bridge.probeRuntimeStatus.mockResolvedValue({ transport: 'connected', body: '{}' })
    bridge.requestRuntimeResourceJson.mockResolvedValue({
      transport: 'connected',
      httpStatus: 503,
      body: 'temporarily unavailable',
      error: null
    })
    const { requestRuntimeJson } = await import('./pebble-tauri-runtime-transport')

    await expect(
      requestRuntimeJson('/v1/test', { method: 'POST', body: { value: 1 } })
    ).rejects.toThrow('temporarily unavailable')
    expect(bridge.requestRuntimeResourceJson).toHaveBeenCalledTimes(1)
    expect(bridge.startRuntimeProcess).not.toHaveBeenCalled()
  })

  it('recovers the process without replaying an unreachable write', async () => {
    bridge.probeRuntimeStatus
      .mockResolvedValueOnce({ transport: 'connected', body: '{}' })
      .mockResolvedValueOnce({ transport: 'unreachable', error: 'actively refused' })
      .mockResolvedValueOnce({ transport: 'connected', body: '{}' })
    bridge.getRuntimeProcessStatus.mockResolvedValueOnce({ running: false, exitCode: 1 })
    bridge.requestRuntimeResourceJson.mockResolvedValue({
      transport: 'unreachable',
      httpStatus: null,
      body: null,
      error: 'actively refused'
    })
    const { requestRuntimeJson } = await import('./pebble-tauri-runtime-transport')

    await expect(
      requestRuntimeJson('/v1/remote-workspace/patch', {
        method: 'PATCH',
        body: { revision: 4 }
      })
    ).rejects.toThrow('actively refused')
    expect(bridge.startRuntimeProcess).not.toHaveBeenCalled()
    expect(bridge.requestRuntimeResourceJson).toHaveBeenCalledTimes(1)
  })
})
