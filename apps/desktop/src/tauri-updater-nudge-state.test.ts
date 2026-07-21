import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TauriUpdaterNudgeState } from './tauri-updater-nudge-state'

describe('TauriUpdaterNudgeState', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      1 as unknown as ReturnType<typeof setInterval>
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('persists a matching campaign before running its update check', async () => {
    const writes: unknown[] = []
    const sequence: string[] = []
    const state = new TauriUpdaterNudgeState({
      development: false,
      fetchNudge: async () => ({ id: 'release-128', minVersion: '1.4.120' }),
      readVersion: async () => '1.4.124',
      readUi: async () => ({}),
      writeUi: async (patch) => {
        writes.push(patch)
        sequence.push('persist')
      },
      readStatus: () => ({ state: 'idle' }),
      startCheck: (operation) => ({ started: true, promise: operation() }),
      performCheck: async () => {
        sequence.push('check')
      },
      clearDismissal: () => sequence.push('clear')
    })

    state.installPolling()

    await vi.waitFor(() => expect(sequence).toEqual(['persist', 'clear', 'check']))
    expect(writes).toEqual([{ pendingUpdateNudgeId: 'release-128', dismissedUpdateVersion: null }])
  })

  it('does not persist a campaign when another updater operation owns the check', async () => {
    const writeUi = vi.fn()
    const performCheck = vi.fn()
    const fetchNudge = vi.fn().mockResolvedValue({
      id: 'release-129',
      maxVersion: '1.4.130'
    })
    const startCheck = vi.fn(() => ({ started: false, promise: Promise.resolve() }))
    const state = new TauriUpdaterNudgeState({
      development: false,
      fetchNudge,
      readVersion: async () => '1.4.124',
      readUi: async () => ({}),
      writeUi,
      readStatus: () => ({ state: 'idle' }),
      startCheck,
      performCheck,
      clearDismissal: vi.fn()
    })

    state.installPolling()

    await vi.waitFor(() => expect(fetchNudge).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(startCheck).toHaveBeenCalledOnce())
    expect(writeUi).not.toHaveBeenCalled()
    expect(performCheck).not.toHaveBeenCalled()
  })

  it('dismisses the active status campaign instead of a stale persisted id', async () => {
    const writeUi = vi.fn().mockResolvedValue(undefined)
    const state = new TauriUpdaterNudgeState({
      development: true,
      fetchNudge: async () => null,
      readVersion: async () => '1.4.124',
      readUi: async () => ({ pendingUpdateNudgeId: 'stale' }),
      writeUi,
      readStatus: () => ({
        state: 'available',
        version: '1.4.128',
        changelog: null,
        activeNudgeId: 'active'
      }),
      startCheck: () => ({ started: false, promise: Promise.resolve() }),
      performCheck: async () => undefined,
      clearDismissal: vi.fn()
    })

    await state.dismiss()

    expect(writeUi).toHaveBeenCalledWith({
      pendingUpdateNudgeId: null,
      dismissedUpdateNudgeId: 'active'
    })
  })
})
