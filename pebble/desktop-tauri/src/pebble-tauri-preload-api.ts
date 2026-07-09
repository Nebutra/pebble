import { installWebPreloadApi } from '@/web/web-preload-api'

import type {
  PreflightStatus,
  PreloadApi,
  RefreshAgentsResult
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

const fallbackRefreshAgents: RefreshAgentsResult = {
  agents: [],
  addedPathSegments: [],
  shellHydrationOk: false,
  pathSource: 'sync_seed_only',
  pathFailureReason: 'spawn_error'
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
        return fallbackPreflightStatus
      }
      return {
        ...fallbackPreflightStatus,
        git: { installed: !status.unavailableTools?.includes('git') }
      }
    },
    detectAgents: () => Promise.resolve([]),
    refreshAgents: () => Promise.resolve(fallbackRefreshAgents),
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
