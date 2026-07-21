import { lazy } from 'react'
import { scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'

const SETTINGS_PANE_PRELOADERS: Record<string, () => Promise<unknown>> = {
  accounts: () => import('./AccountsPane'),
  advanced: () => import('./AdvancedPane'),
  agents: () => import('./AgentsPane'),
  appearance: () => import('./AppearancePane'),
  browser: () => import('./BrowserPane'),
  'commit-message-ai': () => import('./CommitMessageAiPane'),
  'computer-use': () => import('./ComputerUsePane'),
  'developer-permissions': () => import('./DeveloperPermissionsPane'),
  experimental: () => import('./ExperimentalPane'),
  'floating-workspace': () => import('./FloatingWorkspacePane'),
  git: () =>
    Promise.all([
      import('./GitPane'),
      import('./CommitMessageAiPane'),
      import('./GitProviderApiBudgetPane')
    ]),
  input: () => import('./InputPane'),
  integrations: () => import('./IntegrationsPane'),
  'mobile-emulator': () => import('./MobileEmulatorSettingsPane'),
  mobile: () => import('./MobileSettingsPane'),
  notifications: () => import('./NotificationsPane'),
  orchestration: () => import('./OrchestrationPane'),
  privacy: () => import('./PrivacyPane'),
  'quick-commands': () => import('./QuickCommandsPane'),
  'runtime-environments': () => import('./RuntimeEnvironmentsPane'),
  'setup-guide': () => import('./SettingsSetupGuidePane'),
  shortcuts: () => import('./ShortcutsPane'),
  ssh: () => import('./SshPane'),
  stats: () => import('../stats/StatsPane'),
  tasks: () => import('./TasksPane'),
  terminal: () => import('./TerminalPane'),
  voice: () => import('./VoicePane')
}

export function preloadSettingsPane(sectionId: string): Promise<void> {
  const preloader = sectionId.startsWith('repo-')
    ? () => import('./RepositoryPane')
    : SETTINGS_PANE_PRELOADERS[sectionId]
  // A rejected preload is retried by React.lazy when the pane is selected.
  return (
    preloader?.().then(
      () => undefined,
      () => undefined
    ) ?? Promise.resolve()
  )
}

export function preloadSettingsPanesInBackground(): () => void {
  const sectionIds = [...Object.keys(SETTINGS_PANE_PRELOADERS), 'repo-background-warmup']
  return scheduleSettingsPanePreloadQueue(sectionIds, preloadSettingsPane)
}

export function scheduleSettingsPanePreloadQueue(
  sectionIds: readonly string[],
  preload: (sectionId: string) => Promise<void>
): () => void {
  let cancelled = false
  let index = 0
  let cancelScheduledImport: (() => void) | null = null

  const scheduleNext = (): void => {
    if (cancelled || index >= sectionIds.length) {
      return
    }
    const sectionId = sectionIds[index++]
    cancelScheduledImport = scheduleAfterInputQuiet(
      () => {
        cancelScheduledImport = null
        if (cancelled) {
          return
        }
        // Why: dynamic module evaluation cannot be cancelled once started.
        // Serial ownership limits a first-visit collision to at most one pane.
        void preload(sectionId).finally(scheduleNext)
      },
      {
        // Why: startup hydration and the Settings route get the first quiet
        // window; pane warming begins only after the shell has settled.
        delayMs: index === 1 ? 1_500 : 120,
        quietMs: 250,
        idleTimeoutMs: 1_200
      }
    )
  }

  scheduleNext()
  return () => {
    cancelled = true
    cancelScheduledImport?.()
    cancelScheduledImport = null
  }
}

export const AccountsPane = lazy(() =>
  import('./AccountsPane').then((module) => ({ default: module.AccountsPane }))
)
export const AdvancedPane = lazy(() =>
  import('./AdvancedPane').then((module) => ({ default: module.AdvancedPane }))
)
export const AgentsPane = lazy(() =>
  import('./AgentsPane').then((module) => ({ default: module.AgentsPane }))
)
export const AppearancePane = lazy(() =>
  import('./AppearancePane').then((module) => ({ default: module.AppearancePane }))
)
export const BrowserPane = lazy(() =>
  import('./BrowserPane').then((module) => ({ default: module.BrowserPane }))
)
export const CommitMessageAiPane = lazy(() =>
  import('./CommitMessageAiPane').then((module) => ({ default: module.CommitMessageAiPane }))
)
export const ComputerUsePane = lazy(() =>
  import('./ComputerUsePane').then((module) => ({ default: module.ComputerUsePane }))
)
export const DeveloperPermissionsPane = lazy(() =>
  import('./DeveloperPermissionsPane').then((module) => ({
    default: module.DeveloperPermissionsPane
  }))
)
export const ExperimentalPane = lazy(() =>
  import('./ExperimentalPane').then((module) => ({ default: module.ExperimentalPane }))
)
export const FloatingWorkspacePane = lazy(() =>
  import('./FloatingWorkspacePane').then((module) => ({ default: module.FloatingWorkspacePane }))
)
export const GitPane = lazy(() =>
  import('./GitPane').then((module) => ({ default: module.GitPane }))
)
export const GitProviderApiBudgetPane = lazy(() =>
  import('./GitProviderApiBudgetPane').then((module) => ({
    default: module.GitProviderApiBudgetPane
  }))
)
export const InputPane = lazy(() =>
  import('./InputPane').then((module) => ({ default: module.InputPane }))
)
export const IntegrationsPane = lazy(() =>
  import('./IntegrationsPane').then((module) => ({ default: module.IntegrationsPane }))
)
export const MobileEmulatorSettingsPane = lazy(() =>
  import('./MobileEmulatorSettingsPane').then((module) => ({
    default: module.MobileEmulatorSettingsPane
  }))
)
export const MobileSettingsPane = lazy(() =>
  import('./MobileSettingsPane').then((module) => ({ default: module.MobileSettingsPane }))
)
export const NotificationsPane = lazy(() =>
  import('./NotificationsPane').then((module) => ({ default: module.NotificationsPane }))
)
export const OrchestrationPane = lazy(() =>
  import('./OrchestrationPane').then((module) => ({ default: module.OrchestrationPane }))
)
export const PrivacyPane = lazy(() =>
  import('./PrivacyPane').then((module) => ({ default: module.PrivacyPane }))
)
export const QuickCommandsPane = lazy(() =>
  import('./QuickCommandsPane').then((module) => ({ default: module.QuickCommandsPane }))
)
export const RepositoryPane = lazy(() =>
  import('./RepositoryPane').then((module) => ({ default: module.RepositoryPane }))
)
export const RuntimeEnvironmentsPane = lazy(() =>
  import('./RuntimeEnvironmentsPane').then((module) => ({
    default: module.RuntimeEnvironmentsPane
  }))
)
export const SettingsSetupGuidePane = lazy(() =>
  import('./SettingsSetupGuidePane').then((module) => ({ default: module.SettingsSetupGuidePane }))
)
export const ShortcutsPane = lazy(() =>
  import('./ShortcutsPane').then((module) => ({ default: module.ShortcutsPane }))
)
export const SshPane = lazy(() =>
  import('./SshPane').then((module) => ({ default: module.SshPane }))
)
export const StatsPane = lazy(() =>
  import('../stats/StatsPane').then((module) => ({ default: module.StatsPane }))
)
export const TasksPane = lazy(() =>
  import('./TasksPane').then((module) => ({ default: module.TasksPane }))
)
export const TerminalPane = lazy(() =>
  import('./TerminalPane').then((module) => ({ default: module.TerminalPane }))
)
export const VoicePane = lazy(() =>
  import('./VoicePane').then((module) => ({ default: module.VoicePane }))
)
