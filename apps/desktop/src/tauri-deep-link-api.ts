import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { parseDeepLinkAction, type DeepLinkAction } from './tauri-deep-link-contract'

const DEEP_LINK_EVENT = 'pebble:deep-link'
const DEFAULT_RUNTIME_NAME = 'Pebble Server'
const MAX_COMPLETED_ACTIONS = 256
const COMPLETED_ACTION_TTL_MS = 10_000
const activeActionKeys = new Set<string>()
const completedActionTimes = new Map<string, number>()
let dispatchChain = Promise.resolve()

export function installTauriDeepLinkApi(): void {
  if (!hasTauriInternals()) {
    return
  }
  void installDeepLinkListenerAndDrainInitialUrls().catch((error) => {
    console.warn('[tauri-deep-link] failed to initialize protocol listener:', error)
  })
}

async function installDeepLinkListenerAndDrainInitialUrls(): Promise<void> {
  // Why: the command opens Rust's ready barrier; listening first closes the
  // activation gap between a second-instance launch and the cold-start drain.
  await listen<string>(DEEP_LINK_EVENT, (event) => enqueuePebbleDeepLink(event.payload))
  const urls = await invoke<string[]>('deep_link_initial_urls')
  for (const url of urls) {
    enqueuePebbleDeepLink(url)
  }
}

function enqueuePebbleDeepLink(url: string): void {
  // Why: protocol activations are ordered user intents. Serial dispatch avoids
  // duplicate runtime names and page selection races during launch bursts.
  dispatchChain = dispatchChain.then(
    () => handlePebbleDeepLink(url),
    () => handlePebbleDeepLink(url)
  )
}

async function handlePebbleDeepLink(url: string): Promise<void> {
  const action = parseDeepLinkAction(url)
  if (!action) {
    rejectUnsupportedDeepLink()
    return
  }
  const completedAt = completedActionTimes.get(action.key)
  if (
    activeActionKeys.has(action.key) ||
    (completedAt !== undefined && Date.now() - completedAt <= COMPLETED_ACTION_TTL_MS)
  ) {
    return
  }
  if (completedAt !== undefined) {
    completedActionTimes.delete(action.key)
  }
  activeActionKeys.add(action.key)
  try {
    await dispatchDeepLinkAction(action)
    if (action.kind === 'pair') {
      rememberCompletedAction(action.key)
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  } finally {
    activeActionKeys.delete(action.key)
  }
}

async function dispatchDeepLinkAction(action: DeepLinkAction): Promise<void> {
  const state = useAppStore.getState()
  switch (action.kind) {
    case 'pair': {
      const name = await createUniqueRuntimeName(action.offer.endpoint)
      const result = await window.api.runtimeEnvironments.addFromPairingCode({
        name,
        pairingCode: action.url
      })
      const environments = await window.api.runtimeEnvironments.list()
      state.setRuntimeEnvironments(environments)
      await state.refreshRuntimeEnvironmentStatus(result.environment.id)
      toast.success(translate('tauri.deepLink.runtimeAdded', 'Remote server added.'))
      return
    }
    case 'settings':
      state.openSettingsTarget({
        pane: action.pane,
        repoId: action.repoId,
        ...(action.sectionId ? { sectionId: action.sectionId } : {}),
        ...(action.intent ? { intent: action.intent } : {})
      })
      state.openSettingsPage()
      return
    case 'tasks':
      state.openTaskPage(action.source ? { taskSource: action.source } : {}, {
        recordTasksInteraction: false
      })
      return
    case 'activity':
      state.openActivityPage()
      return
    case 'skills':
      state.openSkillsPage()
      return
    case 'mobile':
      state.openMobilePage()
      return
    case 'space':
      state.openSpacePage()
      return
    case 'automations':
      if (action.automationId) {
        state.setSelectedAutomationId(action.automationId)
      }
      if (action.automationId && (action.runId || action.hostId)) {
        state.setPendingAutomationRunNavigation({
          automationId: action.automationId,
          runId: action.runId ?? null,
          ...(action.hostId ? { hostId: action.hostId } : {})
        })
      }
      state.openAutomationsPage()
  }
}

async function createUniqueRuntimeName(endpoint: string): Promise<string> {
  let baseName = DEFAULT_RUNTIME_NAME
  try {
    const hostname = new URL(endpoint).hostname
    if (hostname) {
      baseName = `Pebble ${hostname}`
    }
  } catch {
    /* validated by the parser; keep the defensive product fallback */
  }
  const environments = await window.api.runtimeEnvironments.list()
  const names = new Set(environments.map((environment) => environment.name))
  if (!names.has(baseName)) {
    return baseName
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${baseName} ${suffix}`
    if (!names.has(candidate)) {
      return candidate
    }
  }
  return `${baseName} ${Date.now()}`
}

function rememberCompletedAction(key: string): void {
  completedActionTimes.set(key, Date.now())
  if (completedActionTimes.size > MAX_COMPLETED_ACTIONS) {
    completedActionTimes.delete(completedActionTimes.keys().next().value as string)
  }
}

function rejectUnsupportedDeepLink(): void {
  toast.error(translate('tauri.deepLink.unsupported', 'This Pebble link is not supported.'))
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
