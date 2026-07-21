// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { PersistedUIState } from '../../../packages/product-core/shared/types'
import { createTauriStarNagApi, installTauriStarNagApi } from './tauri-star-nag-api'

const { invokeMock, getVersionMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  getVersionMock: vi.fn(() => Promise.resolve('1.4.128'))
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: getVersionMock }))

describe('Tauri star nag API', () => {
  let state: PersistedUIState
  let setMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    state = {} as PersistedUIState
    setMock = vi.fn(async (updates: Partial<PersistedUIState>) => {
      state = { ...state, ...updates }
    })
    window.api = {
      ui: {
        get: vi.fn(async () => state),
        set: setMock
      },
      gh: {
        checkPebbleStarred: vi.fn(),
        starPebble: vi.fn()
      }
    } as unknown as PreloadApi
  })

  it('emits the canonical card payload for force show', async () => {
    const api = createTauriStarNagApi()
    const onShow = vi.fn()
    api.onShow(onShow)

    await api.forceShow()

    expect(onShow).toHaveBeenCalledWith({ mode: 'gh', surface: 'card' })
  })

  it('keeps onboarding quiet during a persisted cooldown', async () => {
    state.starNagDeferredUntil = Date.now() + 60_000
    const api = createTauriStarNagApi()
    const onShow = vi.fn()
    api.onShow(onShow)

    await api.onboardingCompleted()

    expect(invokeMock).not.toHaveBeenCalled()
    expect(onShow).not.toHaveBeenCalled()
  })

  it('persists completion after native GitHub starring succeeds', async () => {
    invokeMock.mockResolvedValue(true)
    const api = createTauriStarNagApi()

    await expect(api.starPebble()).resolves.toBe(true)

    expect(invokeMock).toHaveBeenCalledWith('star_nag_star')
    expect(state.starNagCompleted).toBe(true)
    expect(state.starNagDeferredUntil).toBeNull()
  })

  it('prepares and consumes one agent value moment per app version', async () => {
    invokeMock.mockResolvedValue(false)
    const api = createTauriStarNagApi()
    const onShow = vi.fn()
    api.onShow(onShow)

    await expect(api.agentValueMoment()).resolves.toEqual({ status: 'ready', mode: 'gh' })
    await api.showAgentValueMoment()

    expect(onShow).toHaveBeenCalledWith({ mode: 'gh', surface: 'card' })
    expect(state.starNagAgentValueMomentAppVersion).toBe('1.4.128')
  })

  it('uses Go stats to baseline the version and show only after the threshold', async () => {
    let onAgentStatus: ((payload: { state: string }) => void) | undefined
    const getSummary = vi
      .fn()
      .mockResolvedValueOnce({ totalAgentsSpawned: 10 })
      .mockResolvedValueOnce({ totalAgentsSpawned: 45 })
    window.api = {
      ...window.api,
      stats: { getSummary },
      agentStatus: {
        onSet: vi.fn((callback) => {
          onAgentStatus = callback
          return () => undefined
        })
      }
    } as unknown as PreloadApi
    invokeMock.mockResolvedValue(false)
    installTauriStarNagApi()
    const onShow = vi.fn()
    window.api.starNag.onShow(onShow)

    onAgentStatus?.({ state: 'working' })
    await vi.waitFor(() => expect(state.starNagBaselineAgents).toBe(10))
    expect(onShow).not.toHaveBeenCalled()

    onAgentStatus?.({ state: 'working' })
    await vi.waitFor(() => expect(onShow).toHaveBeenCalledWith({ mode: 'gh', surface: 'card' }))
  })

  it('routes the Landing and Settings GitHub star actions through native commands', async () => {
    window.api = {
      ...window.api,
      stats: { getSummary: vi.fn().mockResolvedValue({ totalAgentsSpawned: 0 }) },
      agentStatus: { onSet: vi.fn(() => () => undefined) }
    } as unknown as PreloadApi
    invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true)

    installTauriStarNagApi()

    await expect(window.api.gh.checkPebbleStarred()).resolves.toBe(true)
    await expect(window.api.gh.starPebble('landing')).resolves.toBe(true)
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'star_nag_check')
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'star_nag_star')
  })
})
