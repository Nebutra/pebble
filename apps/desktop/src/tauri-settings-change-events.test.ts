import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  emitTauriSettingsChanges,
  resetTauriSettingsChangeListenersForTests,
  subscribeToTauriSettingsChanges
} from './tauri-settings-change-events'

describe('Tauri settings change events', () => {
  beforeEach(() => {
    resetTauriSettingsChangeListenersForTests()
  })

  it('broadcasts persisted updates until the listener unsubscribes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToTauriSettingsChanges(listener)

    emitTauriSettingsChanges({ showTasksButton: false })
    unsubscribe()
    emitTauriSettingsChanges({ showTasksButton: true })

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ showTasksButton: false })
  })

  it('continues broadcasting when an unrelated listener throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    subscribeToTauriSettingsChanges(() => {
      throw new Error('listener failed')
    })
    const healthyListener = vi.fn()
    subscribeToTauriSettingsChanges(healthyListener)

    expect(() => emitTauriSettingsChanges({ showMobileButton: false })).not.toThrow()
    expect(healthyListener).toHaveBeenCalledWith({ showMobileButton: false })
  })
})
