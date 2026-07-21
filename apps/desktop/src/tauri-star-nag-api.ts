import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { PersistedUIState } from '../../../packages/product-core/shared/types'

type StarNagApi = PreloadApi['starNag']
type ShowPayload = Parameters<Parameters<StarNagApi['onShow']>[0]>[0]

const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000
let appVersionPromise: Promise<string> | null = null

export function installTauriStarNagApi(): void {
  const service = createTauriStarNagService()
  window.api.starNag = service.api
  // Why: Landing and Settings use the historical gh surface, while the prompt
  // uses starNag; both must share one native check/mutation instead of diverging.
  window.api.gh = {
    ...window.api.gh,
    checkPebbleStarred: () => invoke<boolean | null>('star_nag_check'),
    starPebble: () => invoke<boolean>('star_nag_star')
  }
  let evaluationPending = false
  window.api.agentStatus.onSet((payload) => {
    if (payload.state !== 'working' || evaluationPending) {
      return
    }
    evaluationPending = true
    void service.evaluateThreshold().finally(() => {
      evaluationPending = false
    })
  })
}

export function createTauriStarNagApi(): StarNagApi {
  return createTauriStarNagService().api
}

function createTauriStarNagService(): {
  api: StarNagApi
  evaluateThreshold: () => Promise<void>
} {
  const showListeners = new Set<(payload?: ShowPayload) => void>()
  const hideListeners = new Set<() => void>()
  let promptVisible = false
  let pendingMode: 'gh' | 'web' | null = null

  const hidePrompt = (): void => {
    promptVisible = false
    for (const listener of hideListeners) {
      listener()
    }
  }

  const completePrompt = async (): Promise<void> => {
    await window.api.ui.set({ starNagCompleted: true, starNagDeferredUntil: null })
    promptVisible = false
    pendingMode = null
    hidePrompt()
  }

  const deferPrompt = async (): Promise<void> => {
    const state = await window.api.ui.get()
    const threshold = state.starNagNextThreshold ?? 35
    await window.api.ui.set({
      starNagNextThreshold: threshold * 2,
      starNagDeferredUntil: Date.now() + COOLDOWN_MS
    })
    promptVisible = false
    pendingMode = null
  }

  const showPrompt = async (mode: 'gh' | 'web', surface: 'card' | 'toast'): Promise<void> => {
    const state = await window.api.ui.get()
    if (state.starNagCompleted || promptVisible) {
      return
    }
    promptVisible = true
    for (const listener of showListeners) {
      listener({ mode, surface })
    }
  }

  const showCheckedPrompt = async (surface: 'card' | 'toast'): Promise<void> => {
    const starred = await invoke<boolean | null>('star_nag_check')
    if (starred === true) {
      await completePrompt()
      return
    }
    await showPrompt(starred === null ? 'web' : 'gh', surface)
  }

  const prepareAgentValueMoment = async (): ReturnType<StarNagApi['agentValueMoment']> => {
    const state = await window.api.ui.get()
    if (
      state.starNagAgentValueMomentAppVersion === (await readAppVersion()) ||
      isSuppressed(state)
    ) {
      await consumeAgentValueMoment()
      return { status: 'skipped' }
    }
    const starred = await invoke<boolean | null>('star_nag_check')
    if (starred === true) {
      await completePrompt()
      await consumeAgentValueMoment()
      return { status: 'skipped' }
    }
    pendingMode = starred === null ? 'web' : 'gh'
    return { status: 'ready', mode: pendingMode }
  }

  const api: StarNagApi = {
    onShow: (callback) => subscribe(showListeners, callback),
    onHide: (callback) => subscribe(hideListeners, callback),
    dismiss: () => deferPrompt(),
    later: () => deferPrompt(),
    complete: () => completePrompt(),
    disable: () => completePrompt(),
    openWeb: () => deferPrompt(),
    starPebble: async () => {
      const starred = await invoke<boolean>('star_nag_star')
      if (starred) {
        await completePrompt()
      }
      return starred
    },
    forceShow: async () => showPrompt('gh', 'card'),
    agentValueMoment: prepareAgentValueMoment,
    showAgentValueMoment: async () => {
      if (!pendingMode) {
        return
      }
      const mode = pendingMode
      pendingMode = null
      await showPrompt(mode, 'card')
      await consumeAgentValueMoment()
    },
    onboardingCompleted: async () => {
      const state = await window.api.ui.get()
      if (isSuppressed(state)) {
        return
      }
      if (promptVisible) {
        hidePrompt()
      }
      await showCheckedPrompt('toast')
    }
  }
  return {
    api,
    evaluateThreshold: async () => {
      const [state, summary, version] = await Promise.all([
        window.api.ui.get(),
        window.api.stats.getSummary(),
        readAppVersion()
      ])
      if (state.starNagAppVersion !== version || state.starNagBaselineAgents == null) {
        await window.api.ui.set({
          starNagAppVersion: version,
          starNagBaselineAgents: summary.totalAgentsSpawned,
          starNagNextThreshold: 35
        })
        return
      }
      if (isSuppressed(state) || promptVisible) {
        return
      }
      const threshold = state.starNagNextThreshold ?? 35
      if (summary.totalAgentsSpawned - state.starNagBaselineAgents < threshold) {
        return
      }
      await showCheckedPrompt('card')
    }
  }
}

function isSuppressed(state: PersistedUIState): boolean {
  return (
    state.starNagCompleted === true ||
    (typeof state.starNagDeferredUntil === 'number' && state.starNagDeferredUntil > Date.now())
  )
}

async function consumeAgentValueMoment(): Promise<void> {
  await window.api.ui.set({ starNagAgentValueMomentAppVersion: await readAppVersion() })
}

function readAppVersion(): Promise<string> {
  appVersionPromise ??= getVersion()
  return appVersionPromise
}

function subscribe<T>(
  listeners: Set<(value: T) => void>,
  callback: (value: T) => void
): () => void {
  listeners.add(callback)
  return () => listeners.delete(callback)
}
