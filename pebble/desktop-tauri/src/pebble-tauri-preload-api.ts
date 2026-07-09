import { installWebPreloadApi } from '@/web/web-preload-api'

import type {
  PreflightStatus,
  PreloadApi
} from '../../../src/preload/api-types'
import { PRODUCT_NAME } from './product-brand'
import {
  ensurePebbleRuntimeProcess,
  readPebbleStatusOrNull
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
import { createPebbleCrashReportsApi } from './tauri-crash-reports-api'
import {
  detectTauriAgents,
  readTauriPreflightStatus,
  refreshTauriAgents
} from './tauri-preflight-agent-api'

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
  void ensurePebbleRuntimeProcess()

  const api = window.api
  api.app = createPebbleAppApi(api.app)
  api.preflight = createPebblePreflightApi(api.preflight)
  api.projects = createPebbleProjectsApi(api.projects)
  api.repos = createPebbleReposApi(api.repos)
  api.worktrees = createPebbleWorktreesApi(api.worktrees)
  api.runtime = createPebbleRuntimeApi(api.runtime)
  api.runtimeEnvironments = createPebbleRuntimeEnvironmentsApi(api.runtimeEnvironments)
  api.crashReports = createPebbleCrashReportsApi(api.crashReports)
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
    awaitFirstWindowStartupServices: () => Promise.resolve(),
    startupDiagnostic: () => Promise.resolve()
  }
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
    detectRemoteAgents: () => Promise.resolve([]),
    detectRemoteWindowsTerminalCapabilities: () =>
      Promise.resolve({
        wslAvailable: false,
        wslDistros: [],
        pwshAvailable: false,
        gitBashAvailable: false,
        hostPlatform: null
      })
  }
}
