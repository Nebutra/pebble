import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SILENT_UPDATE_FOCUS_GAP_MS,
  SILENT_UPDATE_INTERVAL_MS,
  SILENT_UPDATE_MIN_GAP_MS,
  SILENT_UPDATE_STARTUP_DELAY_MS,
  TauriSilentUpdateCheck
} from './tauri-updater-silent-check'

describe('TauriSilentUpdateCheck', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('runs a silent check after the startup delay and on the steady interval', async () => {
    vi.useFakeTimers()
    const runSilentCheck = vi.fn().mockResolvedValue(undefined)
    const timeouts: { ms: number; fn: () => void }[] = []
    const intervals: { ms: number; fn: () => void }[] = []

    const state = new TauriSilentUpdateCheck({
      development: false,
      isBusy: () => false,
      runSilentCheck,
      now: () => Date.now(),
      setTimeoutFn: ((fn: () => void, ms?: number) => {
        timeouts.push({ ms: ms ?? 0, fn })
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      setIntervalFn: ((fn: () => void, ms?: number) => {
        intervals.push({ ms: ms ?? 0, fn })
        return 1 as unknown as ReturnType<typeof setInterval>
      }) as typeof setInterval,
      addEventListenerFn: vi.fn(),
      documentRef: null
    })

    state.install()

    expect(timeouts).toHaveLength(1)
    expect(timeouts[0]?.ms).toBe(SILENT_UPDATE_STARTUP_DELAY_MS)
    expect(intervals).toHaveLength(1)
    expect(intervals[0]?.ms).toBe(SILENT_UPDATE_INTERVAL_MS)

    timeouts[0]?.fn()
    await vi.waitFor(() => expect(runSilentCheck).toHaveBeenCalledTimes(1))

    // Steady interval should fire after min-gap from last check.
    vi.setSystemTime(Date.now() + SILENT_UPDATE_MIN_GAP_MS + 1)
    intervals[0]?.fn()
    await vi.waitFor(() => expect(runSilentCheck).toHaveBeenCalledTimes(2))
  })

  it('does not run silent checks in development builds', async () => {
    const runSilentCheck = vi.fn()
    const state = new TauriSilentUpdateCheck({
      development: true,
      isBusy: () => false,
      runSilentCheck,
      setTimeoutFn: vi.fn() as unknown as typeof setTimeout,
      setIntervalFn: vi.fn() as unknown as typeof setInterval,
      addEventListenerFn: vi.fn(),
      documentRef: null
    })

    state.install()
    await state.tick({ reason: 'startup' })

    expect(runSilentCheck).not.toHaveBeenCalled()
  })

  it('respects the focus gap so returning to the window does not thrash the network', async () => {
    let now = 1_000_000
    const runSilentCheck = vi.fn().mockResolvedValue(undefined)
    const state = new TauriSilentUpdateCheck({
      development: false,
      isBusy: () => false,
      runSilentCheck,
      now: () => now,
      setTimeoutFn: vi.fn() as unknown as typeof setTimeout,
      setIntervalFn: vi.fn() as unknown as typeof setInterval,
      addEventListenerFn: vi.fn(),
      documentRef: null
    })

    await state.tick({ reason: 'startup', minGapMs: 0 })
    expect(runSilentCheck).toHaveBeenCalledTimes(1)

    now += SILENT_UPDATE_FOCUS_GAP_MS - 1
    await state.tick({ reason: 'focus', minGapMs: SILENT_UPDATE_FOCUS_GAP_MS })
    expect(runSilentCheck).toHaveBeenCalledTimes(1)

    now += 2
    await state.tick({ reason: 'focus', minGapMs: SILENT_UPDATE_FOCUS_GAP_MS })
    expect(runSilentCheck).toHaveBeenCalledTimes(2)
  })

  it('skips when another updater operation is busy', async () => {
    const runSilentCheck = vi.fn()
    const state = new TauriSilentUpdateCheck({
      development: false,
      isBusy: () => true,
      runSilentCheck,
      setTimeoutFn: vi.fn() as unknown as typeof setTimeout,
      setIntervalFn: vi.fn() as unknown as typeof setInterval,
      addEventListenerFn: vi.fn(),
      documentRef: null
    })

    await state.tick({ reason: 'startup', minGapMs: 0 })
    expect(runSilentCheck).not.toHaveBeenCalled()
  })
})
