import { installWebPreloadApi } from '@/web/web-preload-api'
import { invoke } from '@tauri-apps/api/core'

import { installNativeSettingsStore } from './native-settings-store-bridge'
import {
  emitTauriSettingsChanges,
  subscribeToTauriSettingsChanges
} from './tauri-settings-change-events'
import { previewTauriGhosttyImport } from './tauri-ghostty-import-api'
import { previewTauriWarpThemeImport } from './tauri-warp-theme-import-api'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { ensurePebbleRuntimeProcess } from './pebble-tauri-runtime-transport'
import {
  createPebbleProjectsApi,
  createPebbleReposApi,
  createPebbleWorktreesApi
} from './pebble-tauri-workspace-runtime-api'
import {
  createPebbleRuntimeApi,
  createPebbleRuntimeEnvironmentsApi
} from './pebble-tauri-runtime-control-api'
import { createPebbleAutomationsApi } from './tauri-automations-api'
import { createPebbleCrashReportsApi } from './tauri-crash-reports-api'
import { createPebbleComputerUsePermissionsApi } from './tauri-computer-use-permissions-api'
import { createPebbleDiagnosticsApi } from './tauri-diagnostics-api'
import { createTauriTelemetryApi } from './tauri-telemetry-api'
import { createPebbleFeedbackApi } from './tauri-feedback-api'
import { createPebbleExportApi } from './tauri-export-api'
import { createPebbleFileWatchApi } from './tauri-file-watch-api'
import {
  createPebbleFolderWorkspacesApi,
  createPebbleProjectGroupsApi
} from './tauri-folder-workspace-api'
import { createPebbleHooksApi } from './tauri-hooks-api'
import { createPebbleAgentHooksApi, reconcileTauriManagedAgentHooks } from './tauri-agent-hooks-api'
import { createPebbleAgentTrustApi } from './tauri-agent-trust-api'
import { createPebbleClaudeAccountsApi, createPebbleCodexAccountsApi } from './tauri-accounts-api'
import { installTauriAccountsSnapshotSync } from './tauri-accounts-snapshot-sync'
import { createTauriNativeChatApi } from './tauri-native-chat-api'
import { createPebbleRateLimitsApi } from './tauri-rate-limits-api'
import { createPebbleMiniMaxCredentialsApi } from './tauri-minimax-credentials-api'
import { createPebbleMobileApi } from './tauri-mobile-runtime-api'
import { createPebbleSpeechApi } from './tauri-speech-api'
import { createPebbleSshApi } from './tauri-ssh-targets-api'
import { createPebbleNotificationsApi } from './tauri-notifications-api'
import { createPebbleCliApi } from './tauri-cli-api'
import { createPebbleGitTextGenerationApi } from './tauri-source-control-text-generation'
import { createPebbleAiVaultApi } from './tauri-ai-vault-api'
import { readTauriMemorySnapshot } from './tauri-diagnostics-runtime-rpc'
import { createPebbleWorkspacePortsApi } from './tauri-workspace-ports-api'
import { createPebbleSparsePresetsApi } from './tauri-sparse-presets-api'
import { createPebbleWorkspaceSpaceApi } from './tauri-workspace-space-api'
import { createPebblePetApi } from './tauri-pet-api'
import { createPebbleNotebookApi } from './tauri-notebook-api'
import { createPebbleLocalhostWorktreeLabelsApi } from './tauri-localhost-worktree-labels-api'
import { createPebbleWorkspaceCleanupApi } from './tauri-workspace-cleanup-api'
import { createPebbleRemoteWorkspaceApi } from './tauri-remote-workspace-api'
import { createPebbleJiraApi } from './tauri-jira-api'
import { createPebbleLinearApi } from './tauri-linear-api'
import { createPebbleEphemeralVmApi } from './tauri-ephemeral-vm-api'
import { createPebbleClaudeUsageApi } from './tauri-claude-usage-api'
import { createPebbleCodexUsageApi } from './tauri-codex-usage-api'
import { createPebbleOpenCodeUsageApi } from './tauri-opencode-usage-api'
import { createTauriGitHubPRRefreshCoordinator } from './tauri-github-pr-refresh-coordinator'
import { createTauriGitRuntimeApi } from './tauri-git-runtime-rpc'
import { createTauriKeybindingsApi } from './tauri-keybindings-api'
import { installTauriE2EApi } from './tauri-e2e-api'
import { nativeRuntimeCall, writeProviderJson } from './pebble-tauri-runtime-provider-io'
import {
  createPebbleGitHubApi,
  createPebbleGitLabApi
} from './pebble-tauri-provider-api-surface'
import { createPebblePreflightApi } from './pebble-tauri-preflight-surface'
import {
  createPebbleAppApi,
  normalizeTauriWorkspaceDirectory
} from './pebble-tauri-app-surface'

type PlatformInfo = ReturnType<PreloadApi['platform']['get']>

let platformInfo: PlatformInfo = {
  platform: navigator.userAgent.includes('Mac')
    ? 'darwin'
    : navigator.userAgent.includes('Windows')
      ? 'win32'
      : 'linux',
  osRelease: '',
  displayServer: null
}

export function installPebbleTauriPreloadApi(): void {
  installWebPreloadApi()
  // The web preload is only a compatibility baseline. Leaving its identity
  // marker enabled makes the canonical renderer hide desktop-only settings
  // and route through browser-client behavior throughout the product.
  const shellWindow = window as Window & {
    __PEBBLE_TAURI_SHELL__?: boolean
    __PEBBLE_WEB_CLIENT__?: boolean
  }
  shellWindow.__PEBBLE_TAURI_SHELL__ = true
  shellWindow.__PEBBLE_WEB_CLIENT__ = false
  // Why: register the native file-backed store before any settings read so the
  // renderer never persists settings/onboarding/keybindings to localStorage.
  installNativeSettingsStore()
  // Why: startup services perform the observable retry/status flow. This early
  // warmup is best-effort and must never become a global unhandled rejection.
  void ensurePebbleRuntimeProcess().catch(() => undefined)

  const api = window.api
  const telemetry = createTauriTelemetryApi()
  api.telemetryTrack = telemetry.telemetryTrack
  api.telemetrySetOptIn = telemetry.telemetrySetOptIn
  api.telemetryGetConsentState = telemetry.telemetryGetConsentState
  api.telemetryAcknowledgeBanner = telemetry.telemetryAcknowledgeBanner
  installTauriE2EApi(api, import.meta.env)
  api.platform = { get: () => platformInfo }
  void invoke<PlatformInfo>('app_platform_info')
    .then((value) => {
      platformInfo = value
    })
    .catch(() => undefined)
  api.app = createPebbleAppApi(api.app)
  const baseSettingsApi = api.settings
  api.settings = {
    ...baseSettingsApi,
    get: async () => normalizeTauriWorkspaceDirectory(await baseSettingsApi.get()),
    set: async (updates) => {
      const settings = await normalizeTauriWorkspaceDirectory(await baseSettingsApi.set(updates))
      if ('agentStatusHooksEnabled' in updates) {
        await reconcileTauriManagedAgentHooks(settings.agentStatusHooksEnabled !== false)
      }
      // Why: Tauri menu callbacks run in this renderer, unlike Electron's main
      // process menu, so successful out-of-band writes need an explicit event.
      emitTauriSettingsChanges(updates)
      return settings
    },
    listFonts: () => invoke<string[]>('app_list_fonts'),
    previewGhosttyImport: async () => previewTauriGhosttyImport(await baseSettingsApi.get()),
    previewWarpThemeImport: previewTauriWarpThemeImport,
    onChanged: subscribeToTauriSettingsChanges
  }
  api.keybindings = createTauriKeybindingsApi(api.keybindings)
  // The fixed GitHub cache key is registered with the native document backend
  // before this wrapper is created, so these calls never use localStorage.
  api.cache = { ...api.cache }
  api.skills = { discover: (target) => nativeRuntimeCall('skills.discover', target) }
  api.nativeChat = createTauriNativeChatApi()
  api.preflight = createPebblePreflightApi(api.preflight)
  api.projects = createPebbleProjectsApi(api.projects)
  api.repos = createPebbleReposApi(api.repos)
  api.projectGroups = createPebbleProjectGroupsApi(api.projectGroups)
  api.folderWorkspaces = createPebbleFolderWorkspacesApi(api.folderWorkspaces)
  api.worktrees = createPebbleWorktreesApi(api.worktrees)
  api.git = createPebbleGitTextGenerationApi(createTauriGitRuntimeApi(api.git))
  api.runtime = createPebbleRuntimeApi(api.runtime)
  const githubPRRefresh = createTauriGitHubPRRefreshCoordinator(writeProviderJson)
  api.gh = createPebbleGitHubApi(api.gh, githubPRRefresh)
  api.hostedReview = {
    forBranch: (args) => nativeRuntimeCall('hostedReview.forBranch', args),
    getCreationEligibility: (args) =>
      nativeRuntimeCall('hostedReview.getCreationEligibility', args),
    create: (args) => nativeRuntimeCall('hostedReview.create', args)
  }
  api.gl = createPebbleGitLabApi(api.gl)
  api.runtimeEnvironments = createPebbleRuntimeEnvironmentsApi(api.runtimeEnvironments)
  api.automations = createPebbleAutomationsApi(api.automations)
  api.crashReports = createPebbleCrashReportsApi(api.crashReports)
  api.computerUsePermissions = createPebbleComputerUsePermissionsApi(api.computerUsePermissions)
  api.diagnostics = createPebbleDiagnosticsApi(api.diagnostics)
  api.feedback = createPebbleFeedbackApi()
  api.export = createPebbleExportApi()
  api.fs = createPebbleFileWatchApi(api.fs)
  api.hooks = createPebbleHooksApi(api.hooks)
  api.mobile = createPebbleMobileApi(api.mobile)
  api.speech = createPebbleSpeechApi(api.speech)
  api.ssh = createPebbleSshApi(api.ssh)
  api.notifications = createPebbleNotificationsApi(api.notifications)
  api.cli = createPebbleCliApi(api.cli)
  api.agentHooks = createPebbleAgentHooksApi(api.agentHooks)
  api.agentTrust = createPebbleAgentTrustApi()
  // Startup reconciliation mirrors Electron's managed hook installer and
  // respects the persisted opt-out before touching agent configuration.
  void api.settings
    .get()
    .then((settings) => reconcileTauriManagedAgentHooks(settings.agentStatusHooksEnabled !== false))
    .catch(() => undefined)
  api.codexAccounts = createPebbleCodexAccountsApi(api.codexAccounts)
  api.claudeAccounts = createPebbleClaudeAccountsApi(api.claudeAccounts)
  api.minimaxCredentials = createPebbleMiniMaxCredentialsApi(api.minimaxCredentials)
  api.rateLimits = createPebbleRateLimitsApi(api.rateLimits)
  api.aiVault = createPebbleAiVaultApi(api.aiVault)
  // Why: the web baseline returns a zero snapshot. Desktop Resource Manager
  // must read the same native process-tree collector exposed to runtime RPC.
  api.memory = { getSnapshot: readTauriMemorySnapshot }
  api.stats = { getSummary: () => nativeRuntimeCall('stats.summary') }
  api.wsl = {
    isAvailable: () => nativeRuntimeCall('host.wsl.isAvailable'),
    listDistros: () => nativeRuntimeCall('host.wsl.listDistros')
  }
  api.pwsh = { isAvailable: () => nativeRuntimeCall('host.pwsh.isAvailable') }
  api.gitBash = { isAvailable: () => nativeRuntimeCall('host.gitBash.isAvailable') }
  api.workspacePorts = createPebbleWorkspacePortsApi()
  api.sparsePresets = createPebbleSparsePresetsApi()
  api.workspaceSpace = createPebbleWorkspaceSpaceApi()
  api.pet = createPebblePetApi()
  api.notebook = createPebbleNotebookApi()
  api.localhostWorktreeLabels = createPebbleLocalhostWorktreeLabelsApi()
  api.workspaceCleanup = createPebbleWorkspaceCleanupApi(api.ui)
  api.remoteWorkspace = createPebbleRemoteWorkspaceApi(api)
  api.jira = createPebbleJiraApi()
  api.linear = createPebbleLinearApi()
  api.ephemeralVm = createPebbleEphemeralVmApi(api)
  api.claudeUsage = createPebbleClaudeUsageApi()
  api.codexUsage = createPebbleCodexUsageApi()
  api.openCodeUsage = createPebbleOpenCodeUsageApi()
  installTauriAccountsSnapshotSync()
}
