// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { availableMonitorsMock, invokeMock, windowMock } = vi.hoisted(() => ({
  availableMonitorsMock: vi.fn(),
  invokeMock: vi.fn(),
  windowMock: {
    isFocused: vi.fn(),
    isMinimized: vi.fn(),
    minimize: vi.fn(),
    setFocus: vi.fn(),
    show: vi.fn(),
    unminimize: vi.fn()
  }
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

vi.mock('@tauri-apps/api/window', () => ({
  availableMonitors: availableMonitorsMock,
  getCurrentWindow: () => windowMock
}))

import { measureTauriWindowLifecycle } from './tauri-window-lifecycle-measurement'

describe('measureTauriWindowLifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"><main>ready</main></div>'
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now())
      return 1
    })
    availableMonitorsMock.mockResolvedValue([{ name: 'Built-in' }])
    windowMock.minimize.mockResolvedValue(undefined)
    windowMock.unminimize.mockResolvedValue(undefined)
    windowMock.show.mockResolvedValue(undefined)
    windowMock.setFocus.mockResolvedValue(undefined)
    windowMock.isMinimized.mockResolvedValueOnce(true).mockResolvedValue(false)
    windowMock.isFocused.mockResolvedValue(true)
    invokeMock.mockResolvedValue(true)
  })

  it('measures a real minimize and resume sequence without claiming multi-display restoration', async () => {
    const result = await measureTauriWindowLifecycle(Date.now() - 50)

    expect(result.firstFrameMs).toBeGreaterThanOrEqual(50)
    expect(result.minimizeObserved).toBe(true)
    expect(result.resumeObserved).toBe(true)
    expect(result.resumeFocused).toBe(true)
    expect(result.monitorCount).toBe(1)
    expect(result.multiDisplayRestore).toBe('unavailable')
    expect(invokeMock).toHaveBeenCalledWith('functional_gate_minimize')
    expect(invokeMock).toHaveBeenCalledWith('functional_gate_restore_and_focus')
  })

  it('requires a relaunch instead of treating two-monitor topology as restore evidence', async () => {
    availableMonitorsMock.mockResolvedValue([{ name: 'Built-in' }, { name: 'External' }])

    const result = await measureTauriWindowLifecycle(Date.now())

    expect(result.monitorCount).toBe(2)
    expect(result.multiDisplayRestore).toBe('requires-relaunch')
  })

  it('continues when an unattended WebView throttles animation frames', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', () => 1)

    const measurement = measureTauriWindowLifecycle(Date.now())
    await vi.advanceTimersByTimeAsync(251)
    await vi.runAllTimersAsync()

    await expect(measurement).resolves.toMatchObject({
      minimizeObserved: true,
      resumeObserved: true
    })
  })
})
