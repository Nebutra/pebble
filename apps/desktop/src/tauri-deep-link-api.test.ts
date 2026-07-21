// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deepLinkMocks = vi.hoisted(() => {
  const getState = vi.fn()
  const useAppStore = Object.assign(vi.fn(), { getState })
  return {
    getState,
    invoke: vi.fn(),
    listen: vi.fn(),
    toast: {
      error: vi.fn(),
      success: vi.fn()
    },
    useAppStore
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: deepLinkMocks.invoke
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: deepLinkMocks.listen
}))

vi.mock('sonner', () => ({
  toast: deepLinkMocks.toast
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/store', () => ({
  useAppStore: deepLinkMocks.useAppStore
}))

import { installTauriDeepLinkApi } from './tauri-deep-link-api'

type DeepLinkHandler = (event: { payload: string }) => void

function makePairingUrl(endpoint: string, scope: 'runtime' | 'mobile' = 'runtime'): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 2,
      endpoint,
      deviceToken: `token-${endpoint}`,
      publicKeyB64: `key-${endpoint}`,
      scope
    })
  ).toString('base64url')
  return `pebble://pair?code=${payload}`
}

describe('installTauriDeepLinkApi', () => {
  const addFromPairingCode = vi.fn()
  const listRuntimeEnvironments = vi.fn()
  const refreshRuntimeEnvironmentStatus = vi.fn()
  const setRuntimeEnvironments = vi.fn()
  const openSettingsPage = vi.fn()
  const openSettingsTarget = vi.fn()
  const openTaskPage = vi.fn()
  const openActivityPage = vi.fn()
  const openAutomationsPage = vi.fn()
  const openSkillsPage = vi.fn()
  const openMobilePage = vi.fn()
  const openSpacePage = vi.fn()
  const setSelectedAutomationId = vi.fn()
  const setPendingAutomationRunNavigation = vi.fn()
  let deepLinkHandler: DeepLinkHandler | null

  beforeEach(() => {
    vi.clearAllMocks()
    deepLinkHandler = null
    ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    ;(window as unknown as { api: unknown }).api = {
      runtimeEnvironments: {
        addFromPairingCode,
        list: listRuntimeEnvironments
      }
    }
    addFromPairingCode.mockResolvedValue({ environment: { id: 'env-1' } })
    listRuntimeEnvironments.mockResolvedValue([])
    refreshRuntimeEnvironmentStatus.mockResolvedValue(undefined)
    deepLinkMocks.getState.mockReturnValue({
      refreshRuntimeEnvironmentStatus,
      setRuntimeEnvironments,
      openSettingsPage,
      openSettingsTarget,
      openTaskPage,
      openActivityPage,
      openAutomationsPage,
      openSkillsPage,
      openMobilePage,
      openSpacePage,
      setSelectedAutomationId,
      setPendingAutomationRunNavigation
    })
    deepLinkMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'deep_link_initial_urls') {
        return []
      }
      throw new Error(`unexpected command: ${command}`)
    })
    deepLinkMocks.listen.mockImplementation((_event: string, handler: DeepLinkHandler) => {
      deepLinkHandler = handler
      return Promise.resolve(vi.fn())
    })
  })

  it('imports startup pairing URLs into runtime environments', async () => {
    const pairingUrl = makePairingUrl('https://runtime-startup.example.com')
    deepLinkMocks.invoke.mockResolvedValueOnce([pairingUrl])

    installTauriDeepLinkApi()

    await vi.waitFor(() =>
      expect(addFromPairingCode).toHaveBeenCalledWith({
        name: 'Pebble runtime-startup.example.com',
        pairingCode: pairingUrl
      })
    )
    expect(setRuntimeEnvironments).toHaveBeenCalledWith([])
    expect(refreshRuntimeEnvironmentStatus).toHaveBeenCalledWith('env-1')
    expect(deepLinkMocks.toast.success).toHaveBeenCalledWith('Remote server added.')
  })

  it('registers the protocol listener before marking the renderer ready', async () => {
    const listenerGate: { resolve?: (unsubscribe: () => void) => void } = {}
    deepLinkMocks.listen.mockImplementation((_event: string, handler: DeepLinkHandler) => {
      deepLinkHandler = handler
      return new Promise((resolve) => {
        listenerGate.resolve = resolve
      })
    })

    installTauriDeepLinkApi()
    await Promise.resolve()
    expect(deepLinkMocks.invoke).not.toHaveBeenCalledWith('deep_link_initial_urls')

    listenerGate.resolve?.(vi.fn())
    await vi.waitFor(() =>
      expect(deepLinkMocks.invoke).toHaveBeenCalledWith('deep_link_initial_urls')
    )
  })

  it('handles runtime deep-link events without going through the web no-op path', async () => {
    installTauriDeepLinkApi()
    const pairingUrl = makePairingUrl('https://runtime-event.example.com')

    deepLinkHandler?.({ payload: pairingUrl })

    await vi.waitFor(() =>
      expect(addFromPairingCode).toHaveBeenCalledWith({
        name: 'Pebble runtime-event.example.com',
        pairingCode: pairingUrl
      })
    )
    expect(deepLinkMocks.listen).toHaveBeenCalledWith('pebble:deep-link', expect.any(Function))
  })

  it('opens canonical settings panes and optional sections through native deep links', async () => {
    installTauriDeepLinkApi()

    deepLinkHandler?.({ payload: 'pebble://settings/voice?section=local-models' })

    await vi.waitFor(() =>
      expect(openSettingsTarget).toHaveBeenCalledWith({
        pane: 'voice',
        repoId: null,
        sectionId: 'local-models'
      })
    )
    expect(openSettingsPage).toHaveBeenCalledOnce()
    expect(addFromPairingCode).not.toHaveBeenCalled()
    expect(deepLinkMocks.toast.error).not.toHaveBeenCalled()
  })

  it('rejects unknown settings panes instead of navigating arbitrary store targets', async () => {
    installTauriDeepLinkApi()

    deepLinkHandler?.({ payload: 'pebble://settings/not-a-pane' })

    await vi.waitFor(() =>
      expect(deepLinkMocks.toast.error).toHaveBeenCalledWith('This Pebble link is not supported.')
    )
    expect(openSettingsTarget).not.toHaveBeenCalled()
    expect(openSettingsPage).not.toHaveBeenCalled()
    expect(addFromPairingCode).not.toHaveBeenCalled()
  })

  it('dispatches every renderer page action exposed by the product protocol', async () => {
    installTauriDeepLinkApi()

    deepLinkHandler?.({ payload: 'pebble://tasks?source=gitlab' })
    deepLinkHandler?.({ payload: 'pebble://activity' })
    deepLinkHandler?.({ payload: 'pebble://skills' })
    deepLinkHandler?.({ payload: 'pebble://mobile' })
    deepLinkHandler?.({ payload: 'pebble://space' })

    await vi.waitFor(() => expect(openSpacePage).toHaveBeenCalledOnce())
    expect(openTaskPage).toHaveBeenCalledWith(
      { taskSource: 'gitlab' },
      { recordTasksInteraction: false }
    )
    expect(openActivityPage).toHaveBeenCalledOnce()
    expect(openSkillsPage).toHaveBeenCalledOnce()
    expect(openMobilePage).toHaveBeenCalledOnce()
  })

  it('allows the same navigation action to be activated again later', async () => {
    installTauriDeepLinkApi()

    deepLinkHandler?.({ payload: 'pebble://activity' })
    await vi.waitFor(() => expect(openActivityPage).toHaveBeenCalledTimes(1))
    deepLinkHandler?.({ payload: 'pebble://activity' })

    await vi.waitFor(() => expect(openActivityPage).toHaveBeenCalledTimes(2))
  })

  it('opens a selected automation run on an explicit execution host', async () => {
    installTauriDeepLinkApi()

    deepLinkHandler?.({
      payload: 'pebble://automations/nightly-build?run=run-42&host=runtime:server-1'
    })

    await vi.waitFor(() => expect(openAutomationsPage).toHaveBeenCalledOnce())
    expect(setSelectedAutomationId).toHaveBeenCalledWith('nightly-build')
    expect(setPendingAutomationRunNavigation).toHaveBeenCalledWith({
      automationId: 'nightly-build',
      runId: 'run-42',
      hostId: 'runtime:server-1'
    })
  })

  it('supports the quick-command settings intent and repo-scoped settings', async () => {
    installTauriDeepLinkApi()

    deepLinkHandler?.({
      payload: 'pebble://settings/quick-commands?repo=repo-42&intent=add-quick-command'
    })

    await vi.waitFor(() =>
      expect(openSettingsTarget).toHaveBeenCalledWith({
        pane: 'quick-commands',
        repoId: 'repo-42',
        intent: 'add-quick-command'
      })
    )
  })

  it.each([
    'https://example.com',
    'pebble://unknown',
    'pebble://tasks/extra',
    'pebble://tasks?source=unknown',
    'pebble://tasks?source=github&source=gitlab',
    'pebble://activity?unexpected=true',
    'pebble://automations/a/b',
    'pebble://automations?run=orphan',
    'pebble://settings/voice?section=%2Funsafe',
    'pebble://settings/voice?unexpected=true',
    'pebble://pair?code=not-base64-json',
    makePairingUrl('https://phone.example.com', 'mobile')
  ])('explicitly rejects malformed or unsupported input: %s', async (payload) => {
    installTauriDeepLinkApi()

    deepLinkHandler?.({ payload })

    await vi.waitFor(() => expect(deepLinkMocks.toast.error).toHaveBeenCalled())
    expect(openSettingsPage).not.toHaveBeenCalled()
    expect(openTaskPage).not.toHaveBeenCalled()
    expect(openAutomationsPage).not.toHaveBeenCalled()
    expect(addFromPairingCode).not.toHaveBeenCalled()
  })

  it('serializes cold-start actions in arrival order', async () => {
    const firstPairing = makePairingUrl('https://first.example.com')
    const secondPairing = makePairingUrl('https://second.example.com')
    const firstGate: { resolve?: (value: { environment: { id: string } }) => void } = {}
    addFromPairingCode
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            firstGate.resolve = resolve
          })
      )
      .mockResolvedValueOnce({ environment: { id: 'env-2' } })
    deepLinkMocks.invoke.mockResolvedValueOnce([firstPairing, secondPairing])

    installTauriDeepLinkApi()

    await vi.waitFor(() => expect(addFromPairingCode).toHaveBeenCalledTimes(1))
    firstGate.resolve?.({ environment: { id: 'env-1' } })
    await vi.waitFor(() => expect(addFromPairingCode).toHaveBeenCalledTimes(2))
    expect(addFromPairingCode.mock.calls.map(([input]) => input.pairingCode)).toEqual([
      firstPairing,
      secondPairing
    ])
  })

  it('allows a failed pairing activation to be retried', async () => {
    installTauriDeepLinkApi()
    const pairingUrl = makePairingUrl('https://retry.example.com')
    addFromPairingCode.mockRejectedValueOnce(new Error('temporary failure'))

    deepLinkHandler?.({ payload: pairingUrl })
    await vi.waitFor(() =>
      expect(deepLinkMocks.toast.error).toHaveBeenCalledWith('temporary failure')
    )
    deepLinkHandler?.({ payload: pairingUrl })

    await vi.waitFor(() => expect(addFromPairingCode).toHaveBeenCalledTimes(2))
  })

  it('suppresses immediate duplicate OS delivery of the same pairing activation', async () => {
    installTauriDeepLinkApi()
    const pairingUrl = makePairingUrl('https://duplicate.example.com')

    deepLinkHandler?.({ payload: pairingUrl })
    deepLinkHandler?.({ payload: pairingUrl })

    await vi.waitFor(() => expect(addFromPairingCode).toHaveBeenCalledOnce())
  })
})
