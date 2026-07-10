import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForTauriStartupServices } from './tauri-startup-services'

const { ensureRuntimeMock, readStatusMock, refreshAgentsMock } = vi.hoisted(() => ({
  ensureRuntimeMock: vi.fn(),
  readStatusMock: vi.fn(),
  refreshAgentsMock: vi.fn()
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: ensureRuntimeMock,
  readPebbleStatusOrNull: readStatusMock
}))

vi.mock('./tauri-preflight-agent-api', () => ({
  refreshTauriAgents: refreshAgentsMock
}))

describe('waitForTauriStartupServices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not block first-window startup forever when native probes hang', async () => {
    vi.useFakeTimers()
    ensureRuntimeMock.mockReturnValue(new Promise(() => undefined))
    readStatusMock.mockReturnValue(new Promise(() => undefined))
    refreshAgentsMock.mockReturnValue(new Promise(() => undefined))

    const pending = waitForTauriStartupServices(25)
    await vi.advanceTimersByTimeAsync(25)

    await expect(pending).resolves.toBeUndefined()
    expect(ensureRuntimeMock).toHaveBeenCalled()
    expect(readStatusMock).toHaveBeenCalled()
    expect(refreshAgentsMock).toHaveBeenCalled()
  })

  it('treats startup probes as best-effort so renderer hydration can continue', async () => {
    ensureRuntimeMock.mockRejectedValue(new Error('runtime failed'))
    readStatusMock.mockResolvedValue(null)
    refreshAgentsMock.mockRejectedValue(new Error('agent refresh failed'))

    await expect(waitForTauriStartupServices(25)).resolves.toBeUndefined()
  })
})
