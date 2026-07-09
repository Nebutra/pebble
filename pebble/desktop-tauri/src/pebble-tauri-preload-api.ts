import { installWebPreloadApi } from '@/web/web-preload-api'

import { installNativeSettingsStore } from './native-settings-store-bridge'

import type { PreflightStatus, PreloadApi } from '../../../src/preload/api-types'
import { sanitizeCrashReportDetails } from '../../../src/shared/crash-reporting'
import type { RuntimeRpcResponse } from '../../../src/shared/runtime-rpc-envelope'
import { PRODUCT_NAME } from './product-brand'
import {
  ensurePebbleRuntimeProcess,
  readPebbleStatusOrNull,
  requestRuntimeJson
} from './pebble-tauri-runtime-transport'
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
import { createPebbleFileWatchApi } from './tauri-file-watch-api'
import {
  createPebbleFolderWorkspacesApi,
  createPebbleProjectGroupsApi
} from './tauri-folder-workspace-api'
import { createPebbleHooksApi } from './tauri-hooks-api'
import { createPebbleMobileApi } from './tauri-mobile-runtime-api'
import { createPebbleSpeechApi } from './tauri-speech-api'
import { readHostTerminalCapabilities } from './host-terminal-capabilities'
import {
  detectTauriAgents,
  readTauriPreflightStatus,
  refreshTauriAgents
} from './tauri-preflight-agent-api'
import { createPebbleSshApi } from './tauri-ssh-targets-api'
import { createPebbleNotificationsApi } from './tauri-notifications-api'
import { createPebbleCliApi } from './tauri-cli-api'

const fallbackPreflightStatus: PreflightStatus = {
  git: { installed: true },
  gh: { installed: false, authenticated: false },
  glab: { installed: false, authenticated: false },
  bitbucket: { configured: false, authenticated: false, account: null },
  azureDevOps: {
    configured: false,
    authenticated: false,
    account: null,
    baseUrl: null,
    tokenConfigured: false
  },
  gitea: {
    configured: false,
    authenticated: false,
    account: null,
    baseUrl: null,
    tokenConfigured: false
  }
}

export function installPebbleTauriPreloadApi(): void {
  installWebPreloadApi()
  // Why: register the native file-backed store before any settings read so the
  // renderer never persists settings/onboarding/keybindings to localStorage.
  installNativeSettingsStore()
  void ensurePebbleRuntimeProcess()

  const api = window.api
  api.app = createPebbleAppApi(api.app)
  api.preflight = createPebblePreflightApi(api.preflight)
  api.projects = createPebbleProjectsApi(api.projects)
  api.repos = createPebbleReposApi(api.repos)
  api.projectGroups = createPebbleProjectGroupsApi(api.projectGroups)
  api.folderWorkspaces = createPebbleFolderWorkspacesApi(api.folderWorkspaces)
  api.worktrees = createPebbleWorktreesApi(api.worktrees)
  api.runtime = createPebbleRuntimeApi(api.runtime)
  api.runtimeEnvironments = createPebbleRuntimeEnvironmentsApi(api.runtimeEnvironments)
  api.automations = createPebbleAutomationsApi(api.automations)
  api.crashReports = createPebbleCrashReportsApi(api.crashReports)
  api.computerUsePermissions = createPebbleComputerUsePermissionsApi(api.computerUsePermissions)
  api.diagnostics = createPebbleDiagnosticsApi(api.diagnostics)
  api.fs = createPebbleFileWatchApi(api.fs)
  api.hooks = createPebbleHooksApi(api.hooks)
  api.mobile = createPebbleMobileApi(api.mobile)
  api.speech = createPebbleSpeechApi(api.speech)
  api.ssh = createPebbleSshApi(api.ssh)
  api.notifications = createPebbleNotificationsApi(api.notifications)
  api.cli = createPebbleCliApi(api.cli)
}

function createPebbleAppApi(base: PreloadApi['app']): PreloadApi['app'] {
  return {
    ...base,
    getIdentity: () =>
      Promise.resolve({
        name: PRODUCT_NAME,
        isDev: import.meta.env.DEV,
        devLabel: import.meta.env.DEV ? 'Dev' : null,
        devBranch: null,
        devWorktreeName: null,
        devRepoRoot: null,
        dockBadgeLabel: null
      }),
    awaitFirstWindowStartupServices: waitForTauriStartupServices,
    startupDiagnostic: recordTauriStartupDiagnostic
  }
}

async function waitForTauriStartupServices(): Promise<void> {
  await ensurePebbleRuntimeProcess()
  await Promise.allSettled([readPebbleStatusOrNull(), refreshTauriAgents()])
}

async function recordTauriStartupDiagnostic(
  event: string,
  details?: Record<string, unknown>
): Promise<void> {
  if (!event.startsWith('renderer-')) {
    return
  }
  window.api.crashReports.recordBreadcrumb({
    name: `startup:${event}`,
    data: details ? sanitizeCrashReportDetails(details) : undefined
  })
}

function createPebblePreflightApi(base: PreloadApi['preflight']): PreloadApi['preflight'] {
  return {
    ...base,
    check: async () => {
      const status = await readPebbleStatusOrNull()
      if (!status) {
        return readTauriPreflightStatus(fallbackPreflightStatus)
      }
      return readTauriPreflightStatus({
        ...fallbackPreflightStatus,
        git: { installed: !status.unavailableTools?.includes('git') }
      })
    },
    detectAgents: () => detectTauriAgents(),
    refreshAgents: () => refreshTauriAgents(),
    detectRemoteAgents: async ({ connectionId }) => {
      try {
        return readRemoteAgentIds(
          await callRuntimeEnvironmentResult(connectionId, 'preflight.detectAgents')
        )
      } catch {
        return []
      }
    },
    // The Go runtime probes whichever host it runs on (local or the SSH-remote
    // runtime), so its host-capability route already answers for the target
    // machine — no need to forward through a runtime-environment RPC hop.
    detectRemoteWindowsTerminalCapabilities: () => readHostTerminalCapabilities(requestRuntimeJson)
  }
}

async function callRuntimeEnvironmentResult(
  selector: string,
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<unknown> {
  const response = (await window.api.runtimeEnvironments.call({
    selector,
    method,
    params,
    timeoutMs
  })) as RuntimeRpcResponse<unknown>
  if (response.ok) {
    return response.result
  }
  throw new Error(response.error.message)
}

function readRemoteAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))]
}
