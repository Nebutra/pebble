import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION
} from '../../../packages/product-core/shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../packages/product-core/shared/runtime-rpc-envelope'
import type {
  RuntimeBrowserDriverState,
  RuntimeSyncWindowGraph,
  RuntimeSyncWindowGraphResult,
  RuntimeTerminalDriverState
} from '../../../packages/product-core/shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../packages/product-core/shared/runtime-environments'
import { parsePebbleYaml } from '../../../packages/product-core/shared/pebble-yaml'
import type { SetupScriptImportCandidate } from '../../../packages/product-core/shared/setup-script-imports'
import { inspectSetupScriptImportCandidates } from '../../../packages/product-core/shared/setup-script-imports'
import type {
  CreateHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewInfo
} from '../../../packages/product-core/shared/hosted-review'
import type { PebbleHooks } from '../../../packages/product-core/shared/types'
import { PRODUCT_NAME } from './product-brand'
import { warnUnmappedRuntimeMethod } from './runtime-unmapped-method-warning'
import { callTauriAutomationRuntimeRpc } from './tauri-automations-api'
import {
  getErrorMessage,
  getHostPlatform,
  hasTauriInternals,
  ensurePebbleRuntimeProcess,
  readPebbleStatusOrNull,
  requestRuntimeJson
} from './pebble-tauri-runtime-transport'
import {
  createRuntimeWorktreeResult,
  getRuntimeRepoId,
  persistRuntimeProjectSortOrder,
  persistRuntimeWorktreeSortOrder,
  readRuntimeWorktreeLineage,
  readRepos,
  readWorktrees,
  removeRuntimeWorktree,
  setRuntimeWorktreeMeta,
  toCreateWorktreeArgs
} from './pebble-tauri-workspace-runtime-api'
import { callTauriBrowserRuntimeRpc } from './tauri-browser-runtime-rpc'
import { callTauriAccountsRuntimeRpc } from './tauri-accounts-runtime-rpc'
import { callTauriClipboardRuntimeRpc } from './tauri-clipboard-runtime-rpc'
import { callTauriDiagnosticsRuntimeRpc } from './tauri-diagnostics-runtime-rpc'
import { callTauriSettingsRuntimeRpc } from './tauri-settings-runtime-rpc'
import { callTauriStatsRuntimeRpc } from './tauri-stats-runtime-rpc'
import { callTauriSkillsRuntimeRpc } from './tauri-skills-runtime-rpc'
import { callTauriUiRuntimeRpc } from './tauri-ui-runtime-rpc'
import { callTauriTerminalDisplayRuntimeRpc } from './tauri-terminal-display-runtime-rpc'
import { callTauriFileRuntimeRpc } from './tauri-file-runtime-rpc'
import {
  callTauriFolderWorkspaceRuntimeRpc,
  callTauriProjectGroupRuntimeRpc
} from './tauri-folder-workspace-api'
import { callTauriGitRuntimeRpc } from './tauri-git-runtime-rpc'
import {
  openTauriComputerUsePermissionSetup,
  readTauriComputerUsePermissionStatus
} from './tauri-computer-use-permissions-api'
import { subscribeTauriRuntimeEnvironment } from './tauri-runtime-environment-subscription-api'
import { registerRuntimeSessionDriverConsumer } from './tauri-runtime-session-driver-relay'
import { registerRuntimeBrowserDriverConsumer } from './tauri-runtime-browser-driver-relay'
import { callTauriSessionTabsRuntimeRpc } from './tauri-session-tabs-runtime-rpc'
import { callTauriProjectHostSetupRuntimeRpc } from './tauri-project-host-setup-runtime-rpc'
import { callTauriWorkspacePortsRuntimeRpc } from './tauri-workspace-ports-api'
import { callTauriOrchestrationRuntimeRpc } from './tauri-orchestration-runtime-rpc'
import { emitTauriActivateWorktree } from './tauri-settings-event-api'
import { callTauriTerminalRuntimeRpc } from './tauri-terminal-runtime-rpc'
import { callTauriEmulatorRuntimeRpc } from './tauri-emulator-runtime-rpc'
import { runtimeFeatureInteractionId } from './runtime-feature-interaction'
import {
  createHostedReview,
  fetchGitHubPRCheckDetails,
  fetchGitHubPRChecks,
  fetchGitLabJobTrace,
  fetchGitLabIssues,
  fetchGitLabMRs,
  fetchGitLabWorkItems,
  fetchHostedReviewCreationEligibility,
  fetchHostedReviewForBranch,
  fetchGitHubPRForBranch,
  fetchReviewWorkItems,
  rerunGitHubPRChecks,
  retryGitLabJob,
  updateHostedReview,
  mergeHostedReview,
  setHostedReviewAutoMerge,
  addHostedReviewComment,
  addHostedInlineReviewComment,
  replyHostedReviewComment,
  resolveHostedReviewThread,
  setHostedReviewFileViewed,
  type UpdateHostedReviewResult
} from './tauri-provider-review-bridge'
import { readHostTerminalCapabilities } from './host-terminal-capabilities'
import {
  fetchGitHubRateLimit,
  fetchGitHubViewer,
  fetchGitHubAuthDiagnostic,
  fetchGitLabRateLimit,
  fetchGitLabViewer,
  fetchGitLabAuthDiagnostic
} from './tauri-provider-rate-limit-bridge'
import {
  addGitLabIssueComment,
  createGitLabIssue,
  fetchGitLabLabels,
  updateGitLabIssue
} from './tauri-gitlab-issue-mutation-bridge'
import {
  fetchGitLabTodos,
  fetchGitLabWorkItemByPath,
  fetchGitLabWorkItemDetails
} from './tauri-gitlab-work-item-details-bridge'
import {
  fetchGitHubIssue,
  fetchGitHubIssues,
  fetchGitHubPRComments,
  fetchGitHubWorkItem,
  fetchGitHubWorkItemDetails,
  fetchGitHubWorkItems
} from './tauri-github-work-items-bridge'
import {
  countGitHubWorkItems,
  createGitHubIssue,
  fetchGitHubAssignableUsers,
  fetchGitHubLabels,
  updateGitHubIssue
} from './tauri-github-issue-metadata-bridge'
import { fetchGitHubPRFileContents } from './tauri-github-pr-file-contents-bridge'
import {
  fetchAccessibleGitHubProjects,
  fetchGitHubProjectAssignableUsers,
  fetchGitHubProjectIssueTypes,
  fetchGitHubProjectLabels,
  fetchGitHubProjectWorkItemDetails,
  addGitHubProjectIssueComment,
  deleteGitHubProjectIssueComment,
  updateGitHubProjectIssue,
  updateGitHubProjectIssueComment,
  updateGitHubProjectPullRequest,
  clearGitHubProjectItemField,
  updateGitHubProjectIssueType,
  updateGitHubProjectItemField,
  fetchGitHubProjectViewTable,
  fetchGitHubProjectViews,
  resolveGitHubProjectRef
} from './tauri-github-project-catalog-bridge'

const PEBBLE_RUNTIME_ID = 'pebble-local'
const TAURI_RUNTIME_CAPABILITIES = RUNTIME_CAPABILITIES

type RuntimeProviderSubsystem = 'browser' | 'computer' | 'emulator'
type RuntimeSubsystemName = RuntimeProviderSubsystem | 'mobile-relay'

type TerminalFitOverrideSnapshot = {
  ptyId: string
  mode: 'mobile-fit'
  cols: number
  rows: number
}

type TerminalFitOverrideEvent = {
  ptyId: string
  mode: 'mobile-fit' | 'desktop-fit'
  cols: number
  rows: number
}

type TerminalDriverSnapshot = {
  ptyId: string
  driver: RuntimeTerminalDriverState
}

type BrowserDriverSnapshot = {
  browserPageId: string
  driver: RuntimeBrowserDriverState
}

type TerminalDriverEvent = TerminalDriverSnapshot
type BrowserDriverEvent = BrowserDriverSnapshot

type RuntimeNativeProvider = {
  id: string
  subsystem: RuntimeProviderSubsystem
  name: string
  status: 'ready' | 'running' | 'degraded' | 'error'
  capabilities: string[]
  message?: string
  lastSeenAt: string
}

type RuntimeSubsystemStatus = {
  name: RuntimeSubsystemName | string
  status: string
  configured: boolean
  capabilities: string[]
  message?: string
}

const terminalFitOverrides = new Map<string, Omit<TerminalFitOverrideSnapshot, 'ptyId'>>()
const terminalDrivers = new Map<string, RuntimeTerminalDriverState>()
const browserDrivers = new Map<string, RuntimeBrowserDriverState>()
const terminalFitOverrideListeners = new Set<(event: TerminalFitOverrideEvent) => void>()
const terminalDriverListeners = new Set<(event: TerminalDriverEvent) => void>()
const browserDriverListeners = new Set<(event: BrowserDriverEvent) => void>()

// Runtime session.driver events (mobile relay input takes the floor, desktop
// reclaims) feed the same driver map the renderer lock banner listens on.
registerRuntimeSessionDriverConsumer((sessionId, driver) => setTerminalDriver(sessionId, driver))
registerRuntimeBrowserDriverConsumer((browserPageId, driver) =>
  setBrowserDriver(browserPageId, driver)
)

export function createPebbleRuntimeApi(base: PreloadApi['runtime']): PreloadApi['runtime'] {
  return {
    ...base,
    syncWindowGraph: (graph) => readOrCreateRuntimeStatus(graph),
    getStatus: () => readOrCreateRuntimeStatus(),
    call: ({ method, params }) => callPebbleRuntimeMethod(method, params),
    getTerminalFitOverrides: () => Promise.resolve(readTerminalFitOverrides()),
    getTerminalDrivers: () => Promise.resolve(readTerminalDrivers()),
    getBrowserDrivers: () => readBrowserDriversFromRuntime(),
    restoreTerminalFit: async (ptyId) => restoreTauriTerminalFit(ptyId),
    reclaimBrowserForDesktop: async (browserPageId) => reclaimTauriBrowserForDesktop(browserPageId),
    onTerminalFitOverrideChanged: (callback) =>
      subscribeToSet(terminalFitOverrideListeners, callback),
    onTerminalDriverChanged: (callback) => subscribeToSet(terminalDriverListeners, callback),
    onBrowserDriverChanged: (callback) => subscribeToSet(browserDriverListeners, callback)
  }
}

export function createPebbleRuntimeEnvironmentsApi(
  base: PreloadApi['runtimeEnvironments']
): PreloadApi['runtimeEnvironments'] {
  return {
    ...base,
    list: () =>
      hasTauriInternals()
        ? invoke<PublicKnownRuntimeEnvironment[]>('runtime_environments_list')
        : Promise.resolve([]),
    resolve: ({ selector }) =>
      invoke<PublicKnownRuntimeEnvironment>('runtime_environments_resolve', {
        input: { selector }
      }),
    getStatus: async () => okRuntimeRpc(await readOrCreateRuntimeStatus()),
    call: async ({ selector, method, params, timeoutMs }) => {
      try {
        return await invoke<RuntimeRpcResponse<unknown>>('runtime_environments_call', {
          input: { selector, method, params, timeoutMs }
        })
      } catch (error) {
        return failRuntimeRpc('remote_runtime_unavailable', getErrorMessage(error))
      }
    },
    addFromPairingCode: ({ name, pairingCode }) =>
      invoke<{ environment: PublicKnownRuntimeEnvironment }>(
        'runtime_environments_add_from_pairing_code',
        { input: { name, pairingCode } }
      ),
    remove: ({ selector }) =>
      invoke<{ removed: PublicKnownRuntimeEnvironment }>('runtime_environments_remove', {
        input: { selector }
      }),
    disconnect: ({ selector }) =>
      invoke<{ disconnected: PublicKnownRuntimeEnvironment }>('runtime_environments_disconnect', {
        input: { selector }
      }),
    subscribe: (args, callbacks) =>
      hasTauriInternals()
        ? subscribeTauriRuntimeEnvironment(args, callbacks)
        : base.subscribe(args, callbacks)
  }
}

// GET adapter for the provider-review bridge; ensures the runtime is up first,
// then a non-2xx (501 CLI-missing, 401 unauthenticated) throws so the dispatcher
// surfaces a failed RPC like Electron's provider load failures.
async function getProviderJson<T>(path: string): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, { method: 'GET' })
}

async function postProviderJson<T>(
  path: string,
  options: { method: 'POST'; body?: unknown; timeoutMs?: number }
): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, options)
}

async function callPebbleRuntimeMethod(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown>> {
  const response = await callPebbleRuntimeMethodInner(method, params)
  const interactionId = response.ok ? runtimeFeatureInteractionId(method, params) : null
  const uiApi = globalThis.window?.api?.ui
  if (interactionId && uiApi) {
    // Why: education telemetry is best-effort and must never turn a successful runtime RPC into a failure.
    void uiApi.recordFeatureInteraction(interactionId).catch(() => {})
  }
  return response
}

async function callPebbleRuntimeMethodInner(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown>> {
  try {
    const accountsResult = await callTauriAccountsRuntimeRpc(method, params)
    if (accountsResult.handled) {
      return okRuntimeRpc(accountsResult.result)
    }
    const clipboardResult = await callTauriClipboardRuntimeRpc(method, params)
    if (clipboardResult.handled) {
      return okRuntimeRpc(clipboardResult.result)
    }
    const diagnosticsResult = await callTauriDiagnosticsRuntimeRpc(method)
    if (diagnosticsResult.handled) {
      return okRuntimeRpc(diagnosticsResult.result)
    }
    const settingsResult = await callTauriSettingsRuntimeRpc(method, params)
    if (settingsResult.handled) {
      return okRuntimeRpc(settingsResult.result)
    }
    const statsResult = await callTauriStatsRuntimeRpc(method)
    if (statsResult.handled) {
      return okRuntimeRpc(statsResult.result)
    }
    const skillsResult = await callTauriSkillsRuntimeRpc(method, params)
    if (skillsResult.handled) {
      return okRuntimeRpc(skillsResult.result)
    }
    const uiResult = await callTauriUiRuntimeRpc(method, params)
    if (uiResult.handled) {
      return okRuntimeRpc(uiResult.result)
    }
    const terminalDisplayResult = await callTauriTerminalDisplayRuntimeRpc(method, params, {
      hasPty: (ptyId) => window.api.pty.hasPty(ptyId),
      resizeMobile: async (ptyId, clientId, cols, rows) => {
        await requestRuntimeJson(`/v1/sessions/${encodeURIComponent(ptyId)}/resize`, {
          method: 'POST',
          body: { cols, rows, source: 'mobile', clientId },
          timeoutMs: 5000
        })
      },
      hasFitOverride: (ptyId) => terminalFitOverrides.has(ptyId),
      setMobileFit: (ptyId, viewport) =>
        emitTerminalFitOverride({ ptyId, mode: 'mobile-fit', ...viewport }),
      setMobileDriver: (ptyId, driver) => setTerminalDriver(ptyId, driver),
      restoreDesktopFit: restoreTauriTerminalFit
    })
    if (terminalDisplayResult.handled) {
      return okRuntimeRpc(terminalDisplayResult.result)
    }
    const browserResult = await callTauriBrowserRuntimeRpc(method, params)
    if (browserResult.handled) {
      return okRuntimeRpc(browserResult.result)
    }
    const terminalResult = await callTauriTerminalRuntimeRpc(method, params)
    if (terminalResult.handled) {
      return okRuntimeRpc(terminalResult.result)
    }
    const fileResult = await callTauriFileRuntimeRpc(method, params)
    if (fileResult.handled) {
      return okRuntimeRpc(fileResult.result)
    }
    const emulatorResult = await callTauriEmulatorRuntimeRpc(method, params)
    if (emulatorResult.handled) {
      return okRuntimeRpc(emulatorResult.result)
    }
    const gitResult = await callTauriGitRuntimeRpc(method, params)
    if (gitResult.handled) {
      return okRuntimeRpc(gitResult.result)
    }
    const automationResult = await callTauriAutomationRuntimeRpc(method, params)
    if (automationResult.handled) {
      return okRuntimeRpc(automationResult.result)
    }
    const sessionTabsResult = await callTauriSessionTabsRuntimeRpc(method, params)
    if (sessionTabsResult.handled) {
      return okRuntimeRpc(sessionTabsResult.result)
    }
    const projectHostSetupResult = await callTauriProjectHostSetupRuntimeRpc(method, params)
    if (projectHostSetupResult.handled) {
      return okRuntimeRpc(projectHostSetupResult.result)
    }
    const workspacePortsResult = await callTauriWorkspacePortsRuntimeRpc(method, params)
    if (workspacePortsResult.handled) {
      return okRuntimeRpc(workspacePortsResult.result)
    }
    const orchestrationResult = await callTauriOrchestrationRuntimeRpc(method, params)
    if (orchestrationResult.handled) {
      return okRuntimeRpc(orchestrationResult.result)
    }
    switch (method) {
      case 'status.get':
        return okRuntimeRpc(await readOrCreateRuntimeStatus())
      case 'repo.list':
        return okRuntimeRpc({ repos: await readRepos() })
      case 'repo.add':
        return okRuntimeRpc(await window.api.repos.add(toRepoAddArgs(params)))
      case 'repo.create':
        return okRuntimeRpc(await window.api.repos.create(toRepoCreateArgs(params)))
      case 'repo.clone':
        return okRuntimeRpc({
          repo: await window.api.repos.clone(toRepoCloneArgs(params))
        })
      case 'repo.gitAvailable':
        return okRuntimeRpc({
          available: await window.api.repos.isGitAvailable()
        })
      case 'repo.update':
        return okRuntimeRpc({
          repo: await window.api.repos.update(toRepoUpdateArgs(params))
        })
      case 'repo.rm':
        await window.api.repos.remove({ repoId: requireRepoId(params) })
        return okRuntimeRpc({ removed: true })
      case 'repo.reorder':
        return okRuntimeRpc(await persistRuntimeProjectSortOrder(toOrderedIds(params)))
      case 'repo.baseRefDefault':
        return okRuntimeRpc(
          await window.api.repos.getBaseRefDefault({
            repoId: requireRepoId(params)
          })
        )
      case 'repo.searchRefs':
        return okRuntimeRpc(await searchRuntimeRepoRefs(params))
      case 'repo.hooksCheck':
        return okRuntimeRpc(await readRuntimeRepoHooksCheck(params))
      case 'repo.setupScriptImports':
        return okRuntimeRpc(await inspectRuntimeRepoSetupScriptImports(params))
      case 'repo.issueCommandRead':
        return okRuntimeRpc(await readRuntimeRepoIssueCommand(params))
      case 'repo.issueCommandWrite':
        return okRuntimeRpc(await writeRuntimeRepoIssueCommand(params))
      case 'projectGroup.list':
      case 'projectGroup.create':
      case 'projectGroup.update':
      case 'projectGroup.delete':
      case 'projectGroup.moveProject': {
        const projectGroupResult = await callTauriProjectGroupRuntimeRpc(method, params)
        if (projectGroupResult.handled) {
          return okRuntimeRpc(projectGroupResult.result)
        }
        return failRuntimeRpc(
          'method_not_available',
          `${PRODUCT_NAME} runtime method is not mapped: ${method}`
        )
      }
      case 'projectGroup.scanNested':
      case 'projectGroup.importNested': {
        const projectGroupResult = await callTauriProjectGroupRuntimeRpc(method, params)
        if (projectGroupResult.handled) {
          return okRuntimeRpc(projectGroupResult.result)
        }
        return failRuntimeRpc(
          'method_not_available',
          `${PRODUCT_NAME} runtime method is not mapped: ${method}`
        )
      }
      case 'folderWorkspace.list':
      case 'folderWorkspace.create':
      case 'folderWorkspace.update':
      case 'folderWorkspace.delete':
      case 'folderWorkspace.getPathStatus': {
        const folderWorkspaceResult = await callTauriFolderWorkspaceRuntimeRpc(method, params)
        if (folderWorkspaceResult.handled) {
          return okRuntimeRpc(folderWorkspaceResult.result)
        }
        return failRuntimeRpc(
          'method_not_available',
          `${PRODUCT_NAME} runtime method is not mapped: ${method}`
        )
      }
      case 'hostedReview.forBranch':
        return okRuntimeRpc(await readTauriHostedReviewForBranch(params))
      case 'hostedReview.getCreationEligibility':
        return okRuntimeRpc(await readTauriHostedReviewCreationEligibility(params))
      case 'hostedReview.create':
        return okRuntimeRpc(await createTauriHostedReview(params))
      case 'provider.list':
      case 'providers.list':
      case 'nativeProvider.list':
        return okRuntimeRpc({
          providers: await readRuntimeNativeProviders(params)
        })
      case 'provider.status':
      case 'subsystem.status':
        return okRuntimeRpc({
          status: await readRuntimeSubsystemStatus(params)
        })
      case 'provider.register':
      case 'nativeProvider.register':
        return okRuntimeRpc({
          provider: await registerRuntimeNativeProvider(params)
        })
      case 'host.platform': {
        const capabilities = await readHostTerminalCapabilities(requestRuntimeJson)
        return okRuntimeRpc({ platform: capabilities.hostPlatform })
      }
      case 'host.wsl.isAvailable': {
        const capabilities = await readHostTerminalCapabilities(requestRuntimeJson)
        return okRuntimeRpc(capabilities.wslAvailable)
      }
      case 'host.wsl.listDistros': {
        const capabilities = await readHostTerminalCapabilities(requestRuntimeJson)
        return okRuntimeRpc(capabilities.wslDistros)
      }
      case 'host.pwsh.isAvailable': {
        const capabilities = await readHostTerminalCapabilities(requestRuntimeJson)
        return okRuntimeRpc(capabilities.pwshAvailable)
      }
      case 'host.gitBash.isAvailable': {
        const capabilities = await readHostTerminalCapabilities(requestRuntimeJson)
        return okRuntimeRpc(capabilities.gitBashAvailable)
      }
      case 'computer.permissionsStatus':
        return okRuntimeRpc(await readTauriComputerUsePermissionStatus())
      case 'computer.permissions':
        return okRuntimeRpc(
          await openTauriComputerUsePermissionSetup(readComputerPermissionsArgs(params))
        )
      case 'worktree.list':
        return okRuntimeRpc({
          worktrees: await readWorktrees(getRuntimeRepoId(params))
        })
      case 'worktree.activate':
        return okRuntimeRpc(await activateTauriWorktree(params))
      case 'worktree.detectedList':
        return okRuntimeRpc(
          await window.api.worktrees.listDetected({
            repoId: requireRepoId(params)
          })
        )
      case 'worktree.lineageList':
        return okRuntimeRpc(await readRuntimeWorktreeLineage())
      case 'worktree.create':
        return okRuntimeRpc(await createRuntimeWorktreeResult(toCreateWorktreeArgs(params)))
      case 'worktree.prefetchCreateBase':
        await window.api.worktrees.prefetchCreateBase(toWorktreePrefetchArgs(params))
        return okRuntimeRpc(null)
      case 'worktree.resolvePrBase':
        return okRuntimeRpc(
          await window.api.worktrees.resolvePrBase(toWorktreeResolvePrArgs(params))
        )
      case 'worktree.resolveMrBase':
        return okRuntimeRpc(
          await window.api.worktrees.resolveMrBase(toWorktreeResolveMrArgs(params))
        )
      case 'worktree.set':
        return okRuntimeRpc({ worktree: await setRuntimeWorktreeMeta(params) })
      case 'worktree.persistSortOrder':
        await persistRuntimeWorktreeSortOrder(toOrderedIds(params))
        return okRuntimeRpc({ status: 'applied' })
      case 'worktree.rm':
      case 'worktree.remove':
        return okRuntimeRpc({
          preservedBranch: await removeRuntimeWorktree(params)
        })
      case 'worktree.forceDeleteBranch':
        return okRuntimeRpc(
          await window.api.worktrees.forceDeletePreservedBranch(toForceDeleteBranchArgs(params))
        )
      case 'preflight.check':
        return okRuntimeRpc(await window.api.preflight.check())
      case 'preflight.detectAgents':
        return okRuntimeRpc(await window.api.preflight.detectAgents())
      case 'preflight.refreshAgents':
        return okRuntimeRpc(await window.api.preflight.refreshAgents())
      case 'preflight.detectRemoteAgents':
        return okRuntimeRpc(
          await window.api.preflight.detectRemoteAgents(toConnectionParams(params))
        )
      case 'preflight.detectRemoteWindowsTerminalCapabilities':
        return okRuntimeRpc(
          await window.api.preflight.detectRemoteWindowsTerminalCapabilities(
            toConnectionParams(params)
          )
        )
      case 'github.prChecks':
        return okRuntimeRpc(await fetchGitHubPRChecks(getProviderJson, params))
      case 'github.prForBranch':
        return okRuntimeRpc(await fetchGitHubPRForBranch(postProviderJson, params))
      case 'github.rateLimit':
        return okRuntimeRpc(
          await fetchGitHubRateLimit(getProviderJson, readRateLimitParams(params))
        )
      case 'github.viewer':
        return okRuntimeRpc(await fetchGitHubViewer(getProviderJson))
      case 'github.diagnoseAuth':
        return okRuntimeRpc(await fetchGitHubAuthDiagnostic(getProviderJson))
      case 'github.prCheckDetails':
        return okRuntimeRpc(await fetchGitHubPRCheckDetails(getProviderJson, params))
      case 'github.rerunPRChecks':
        return okRuntimeRpc(await rerunGitHubPRChecks(postProviderJson, params))
      case 'github.listIssues':
        return okRuntimeRpc(await fetchGitHubIssues(getProviderJson, params))
      case 'github.listWorkItems':
        return okRuntimeRpc(await fetchGitHubWorkItems(getProviderJson, params))
      case 'github.countWorkItems':
        return okRuntimeRpc(await countGitHubWorkItems(getProviderJson, params))
      case 'github.listLabels':
        return okRuntimeRpc(await fetchGitHubLabels(getProviderJson, params))
      case 'github.listAssignableUsers':
        return okRuntimeRpc(await fetchGitHubAssignableUsers(getProviderJson, params))
      case 'github.createIssue':
        return okRuntimeRpc(await createGitHubIssue(postProviderJson, params))
      case 'github.updateIssue':
        return okRuntimeRpc(await updateGitHubIssue(postProviderJson, params))
      case 'github.issue':
        return okRuntimeRpc(await fetchGitHubIssue(getProviderJson, params))
      case 'github.workItem':
      case 'github.workItemByOwnerRepo':
        return okRuntimeRpc(await fetchGitHubWorkItem(getProviderJson, params))
      case 'github.workItemDetails':
        return okRuntimeRpc(await fetchGitHubWorkItemDetails(getProviderJson, params))
      case 'github.prFileContents':
        return okRuntimeRpc(await fetchGitHubPRFileContents(postProviderJson, params))
      case 'github.prComments':
        return okRuntimeRpc(await fetchGitHubPRComments(getProviderJson, params))
      case 'github.project.resolveRef':
        return okRuntimeRpc(await resolveGitHubProjectRef(getProviderJson, params))
      case 'github.project.listViews':
        return okRuntimeRpc(await fetchGitHubProjectViews(getProviderJson, params))
      case 'github.project.viewTable':
        return okRuntimeRpc(await fetchGitHubProjectViewTable(postProviderJson, params))
      case 'github.project.listAccessible':
        return okRuntimeRpc(await fetchAccessibleGitHubProjects(getProviderJson))
      case 'github.project.listLabelsBySlug':
        return okRuntimeRpc(await fetchGitHubProjectLabels(getProviderJson, params))
      case 'github.project.listAssignableUsersBySlug':
        return okRuntimeRpc(await fetchGitHubProjectAssignableUsers(getProviderJson, params))
      case 'github.project.listIssueTypesBySlug':
        return okRuntimeRpc(await fetchGitHubProjectIssueTypes(getProviderJson, params))
      case 'github.project.workItemDetailsBySlug':
        return okRuntimeRpc(await fetchGitHubProjectWorkItemDetails(getProviderJson, params))
      case 'github.project.updateIssueBySlug':
        return okRuntimeRpc(await updateGitHubProjectIssue(postProviderJson, params))
      case 'github.project.updatePullRequestBySlug':
        return okRuntimeRpc(await updateGitHubProjectPullRequest(postProviderJson, params))
      case 'github.project.addIssueCommentBySlug':
        return okRuntimeRpc(await addGitHubProjectIssueComment(postProviderJson, params))
      case 'github.project.updateIssueCommentBySlug':
        return okRuntimeRpc(await updateGitHubProjectIssueComment(postProviderJson, params))
      case 'github.project.deleteIssueCommentBySlug':
        return okRuntimeRpc(await deleteGitHubProjectIssueComment(postProviderJson, params))
      case 'github.project.updateItemField':
        return okRuntimeRpc(await updateGitHubProjectItemField(postProviderJson, params))
      case 'github.project.clearItemField':
        return okRuntimeRpc(await clearGitHubProjectItemField(postProviderJson, params))
      case 'github.project.updateIssueTypeBySlug':
        return okRuntimeRpc(await updateGitHubProjectIssueType(postProviderJson, params))
      case 'gitlab.listMRs':
        return okRuntimeRpc(await fetchGitLabMRs(getProviderJson, params))
      case 'gitlab.listIssues':
        return okRuntimeRpc(await fetchGitLabIssues(getProviderJson, params))
      case 'gitlab.listWorkItems':
        return okRuntimeRpc(await fetchGitLabWorkItems(getProviderJson, params))
      case 'gitlab.listLabels':
        return okRuntimeRpc(await fetchGitLabLabels(getProviderJson, params))
      case 'gitlab.createIssue':
        return okRuntimeRpc(await createGitLabIssue(postProviderJson, params))
      case 'gitlab.updateIssue':
        return okRuntimeRpc(await updateGitLabIssue(postProviderJson, params))
      case 'gitlab.addIssueComment':
        return okRuntimeRpc(await addGitLabIssueComment(postProviderJson, params))
      case 'gitlab.todos':
        return okRuntimeRpc(await fetchGitLabTodos(getProviderJson, params))
      case 'gitlab.workItemDetails':
        return okRuntimeRpc(await fetchGitLabWorkItemDetails(getProviderJson, params))
      case 'gitlab.workItemByPath':
        return okRuntimeRpc(await fetchGitLabWorkItemByPath(getProviderJson, params))
      case 'gitlab.rateLimit':
        return okRuntimeRpc(
          await fetchGitLabRateLimit(getProviderJson, readGitLabRateLimitParams(params))
        )
      case 'gitlab.viewer':
        return okRuntimeRpc(await fetchGitLabViewer(getProviderJson))
      case 'gitlab.diagnoseAuth':
        return okRuntimeRpc(await fetchGitLabAuthDiagnostic(getProviderJson))
      case 'gitlab.jobTrace':
        return okRuntimeRpc(await fetchGitLabJobTrace(postProviderJson, params))
      case 'gitlab.retryJob':
        return okRuntimeRpc(await retryGitLabJob(postProviderJson, params))
      case 'github.updatePR':
        return okRuntimeRpc(
          await updateTauriHostedReview('github', params, {
            fromUpdates: true
          })
        )
      case 'github.updatePRTitle':
        return okRuntimeRpc(
          await updateTauriHostedReview('github', params, {
            titleField: 'title'
          })
        )
      case 'github.mergePR':
        return okRuntimeRpc(await mergeTauriHostedReview('github', params, 'squash'))
      case 'github.setPRAutoMerge':
        return okRuntimeRpc(await setTauriHostedReviewAutoMerge(params))
      case 'github.addIssueComment':
        return okRuntimeRpc(await addTauriHostedReviewComment('github', params))
      case 'github.addPRReviewComment':
        return okRuntimeRpc(await addTauriHostedInlineReviewComment('github', params))
      case 'github.addPRReviewCommentReply':
        return okRuntimeRpc(await replyTauriHostedReviewComment(params))
      case 'github.resolveReviewThread':
        return okRuntimeRpc(await resolveTauriHostedReviewThread('github', params))
      case 'github.setPRFileViewed':
        return okRuntimeRpc(await setTauriHostedReviewFileViewed(params))
      case 'github.updatePRState':
        return okRuntimeRpc(
          await updateTauriHostedReview('github', params, {
            fromUpdates: true
          })
        )
      case 'github.requestPRReviewers':
        return okRuntimeRpc(
          await updateTauriHostedReview('github', params, {
            reviewersField: 'addReviewers'
          })
        )
      case 'github.removePRReviewers':
        return okRuntimeRpc(
          await updateTauriHostedReview('github', params, {
            reviewersField: 'removeReviewers'
          })
        )
      case 'gitlab.updateMR':
        return okRuntimeRpc(
          await updateTauriHostedReview('gitlab', params, {
            fromUpdates: true
          })
        )
      case 'gitlab.updateMRState':
        return okRuntimeRpc(
          await updateTauriHostedReview('gitlab', params, {
            stateField: 'state'
          })
        )
      case 'gitlab.updateMRReviewers':
        return okRuntimeRpc(
          await updateTauriHostedReview('gitlab', params, {
            reviewerIdsField: 'reviewerIds'
          })
        )
      case 'gitlab.mergeMR':
        return okRuntimeRpc(await mergeTauriHostedReview('gitlab', params, 'merge'))
      case 'gitlab.addMRComment':
        return okRuntimeRpc(await addTauriHostedReviewComment('gitlab', params))
      case 'gitlab.addMRInlineComment':
        return okRuntimeRpc(await addTauriHostedInlineReviewComment('gitlab', params))
      case 'gitlab.resolveMRDiscussion':
        return okRuntimeRpc(await resolveTauriHostedReviewThread('gitlab', params))
      // Provider-neutral list for the REST-backed providers (bitbucket,
      // azure-devops, gitea); params carry the provider discriminator.
      case 'providerReview.listWorkItems':
        return okRuntimeRpc(await fetchReviewWorkItems(getProviderJson, params))
      default:
        warnUnmappedRuntimeMethod(method)
        return failRuntimeRpc(
          'method_not_available',
          `${PRODUCT_NAME} runtime method is not mapped: ${method}`
        )
    }
  } catch (error) {
    return failRuntimeRpc('runtime_error', getErrorMessage(error))
  }
}

async function readRuntimeNativeProviders(params: unknown): Promise<RuntimeNativeProvider[]> {
  await ensurePebbleRuntimeProcess()
  const subsystem = readProviderSubsystem(params)
  const query = subsystem ? `?subsystem=${encodeURIComponent(subsystem)}` : ''
  return requestRuntimeJson<RuntimeNativeProvider[]>(`/v1/providers${query}`, {
    method: 'GET'
  })
}

async function readRuntimeSubsystemStatus(params: unknown): Promise<RuntimeSubsystemStatus> {
  await ensurePebbleRuntimeProcess()
  const subsystem = readSubsystemName(params)
  return requestRuntimeJson<RuntimeSubsystemStatus>(`/v1/${subsystem}/status`, {
    method: 'GET'
  })
}

async function registerRuntimeNativeProvider(params: unknown): Promise<RuntimeNativeProvider> {
  await ensurePebbleRuntimeProcess()
  const input = readProviderObject(params)
  return requestRuntimeJson<RuntimeNativeProvider>('/v1/providers', {
    method: 'POST',
    body: {
      id: readProviderOptionalString(input.id),
      subsystem: readProviderSubsystem(input) ?? 'browser',
      name: readProviderRequiredString(input.name, 'native provider name'),
      status: readProviderOptionalString(input.status),
      capabilities: readProviderStringList(input.capabilities),
      message: readProviderOptionalString(input.message)
    }
  })
}

async function readTauriHostedReviewForBranch(params: unknown): Promise<HostedReviewInfo | null> {
  await ensurePebbleRuntimeProcess()
  return fetchHostedReviewForBranch(getProviderJson, params)
}

async function readTauriHostedReviewCreationEligibility(
  params: unknown
): Promise<HostedReviewCreationEligibility> {
  await ensurePebbleRuntimeProcess()
  return fetchHostedReviewCreationEligibility(getProviderJson, params)
}

async function createTauriHostedReview(params: unknown): Promise<CreateHostedReviewResult> {
  await ensurePebbleRuntimeProcess()
  return createHostedReview(requestRuntimeJson, params)
}

// Maps the renderer's per-operation github.*/gitlab.* RPC param shapes
// (prNumber/iid, updates.{title,body,state}, reviewers) onto the Go runtime's
// single provider-neutral update route.
async function updateTauriHostedReview(
  provider: 'github' | 'gitlab',
  params: unknown,
  shape: {
    fromUpdates?: boolean
    titleField?: 'title'
    stateField?: 'state'
    reviewersField?: 'addReviewers' | 'removeReviewers'
    reviewerIdsField?: 'reviewerIds'
  }
): Promise<UpdateHostedReviewResult> {
  await ensurePebbleRuntimeProcess()
  const input = (params ?? {}) as Record<string, unknown>
  const number = input.prNumber ?? input.iid
  const updates = (input.updates ?? {}) as Record<string, unknown>
  const body: Record<string, unknown> = { ...input, number }
  if (shape.fromUpdates) {
    if (typeof updates.title === 'string') {
      body.title = updates.title
    }
    if (typeof updates.body === 'string') {
      body.body = updates.body
    }
    if (typeof updates.state === 'string') {
      body.state = updates.state
    }
    if (typeof updates.draft === 'boolean') {
      body.draft = updates.draft
    }
    if (provider === 'github' && typeof updates.baseRefName === 'string') {
      body.baseRefName = updates.baseRefName
    }
    if (provider === 'gitlab' && typeof updates.targetBranch === 'string') {
      body.targetBranch = updates.targetBranch
    }
  }
  if (shape.titleField) {
    body.title = input[shape.titleField]
  }
  if (shape.stateField) {
    body.state = input[shape.stateField]
  }
  if (shape.reviewersField && Array.isArray(input.reviewers)) {
    body[shape.reviewersField] = input.reviewers
  }
  if (shape.reviewerIdsField && Array.isArray(input[shape.reviewerIdsField])) {
    body.reviewerIds = input[shape.reviewerIdsField]
  }
  return updateHostedReview(requestRuntimeJson, { ...body, provider })
}

async function mergeTauriHostedReview(
  provider: 'github' | 'gitlab',
  params: unknown,
  defaultMethod: 'merge' | 'squash'
): Promise<UpdateHostedReviewResult> {
  await ensurePebbleRuntimeProcess()
  const input = (params ?? {}) as Record<string, unknown>
  return mergeHostedReview(requestRuntimeJson, {
    ...input,
    provider,
    number: input.prNumber ?? input.iid,
    method: input.method ?? defaultMethod
  })
}

async function setTauriHostedReviewAutoMerge(params: unknown): Promise<UpdateHostedReviewResult> {
  await ensurePebbleRuntimeProcess()
  const input = (params ?? {}) as Record<string, unknown>
  return setHostedReviewAutoMerge(requestRuntimeJson, {
    ...input,
    number: input.prNumber,
    method: input.method ?? 'squash'
  })
}

async function addTauriHostedReviewComment(provider: 'github' | 'gitlab', params: unknown) {
  await ensurePebbleRuntimeProcess()
  const input = (params ?? {}) as Record<string, unknown>
  return addHostedReviewComment(requestRuntimeJson, {
    ...input,
    provider,
    number: input.number ?? input.iid
  })
}

async function addTauriHostedInlineReviewComment(provider: 'github' | 'gitlab', params: unknown) {
  await ensurePebbleRuntimeProcess()
  const outer = (params ?? {}) as Record<string, unknown>
  const nested =
    outer.input && typeof outer.input === 'object' ? (outer.input as Record<string, unknown>) : {}
  return addHostedInlineReviewComment(requestRuntimeJson, {
    ...outer,
    ...nested,
    provider,
    number: outer.prNumber ?? outer.iid
  })
}

async function replyTauriHostedReviewComment(params: unknown) {
  await ensurePebbleRuntimeProcess()
  const input = (params ?? {}) as Record<string, unknown>
  return replyHostedReviewComment(requestRuntimeJson, { ...input, number: input.prNumber })
}

async function resolveTauriHostedReviewThread(provider: 'github' | 'gitlab', params: unknown) {
  await ensurePebbleRuntimeProcess()
  const input = (params ?? {}) as Record<string, unknown>
  return resolveHostedReviewThread(requestRuntimeJson, {
    ...input,
    provider,
    number: input.iid,
    threadId: input.threadId ?? input.discussionId,
    resolved: input.resolve ?? input.resolved
  })
}

async function setTauriHostedReviewFileViewed(params: unknown) {
  await ensurePebbleRuntimeProcess()
  return setHostedReviewFileViewed(requestRuntimeJson, params)
}

async function readOrCreateRuntimeStatus(
  graph?: RuntimeSyncWindowGraph
): Promise<RuntimeSyncWindowGraphResult> {
  const status = await readPebbleStatusOrNull()
  return {
    runtimeId: PEBBLE_RUNTIME_ID,
    rendererGraphEpoch: Date.now(),
    graphStatus: status ? 'ready' : 'unavailable',
    authoritativeWindowId: null,
    liveTabCount: graph?.tabs.length ?? 0,
    liveLeafCount: graph?.leaves.length ?? 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
    // Why: capability reporting follows the native Tauri/Go implementation;
    // clients may select the raw, backpressured screencast transport.
    capabilities: [...TAURI_RUNTIME_CAPABILITIES],
    hostPlatform: getHostPlatform(),
    remoteControl: null,
    agentOrchestrationByPaneKey: {}
  }
}

function okRuntimeRpc<TResult>(result: TResult): RuntimeRpcResponse<TResult> {
  return {
    id: crypto.randomUUID(),
    ok: true,
    result,
    _meta: { runtimeId: PEBBLE_RUNTIME_ID }
  }
}

function failRuntimeRpc(code: string, message: string): RuntimeRpcResponse<unknown> {
  return {
    id: crypto.randomUUID(),
    ok: false,
    error: { code, message },
    _meta: { runtimeId: PEBBLE_RUNTIME_ID }
  }
}

function readSubsystemName(params: unknown): RuntimeSubsystemName {
  const input = readProviderObject(params)
  const value =
    readProviderOptionalString(input.name) ??
    readProviderOptionalString(input.subsystem) ??
    readProviderOptionalString(input.kind) ??
    'browser'
  if (
    value === 'browser' ||
    value === 'computer' ||
    value === 'emulator' ||
    value === 'mobile-relay'
  ) {
    return value
  }
  throw new Error(`Unsupported runtime subsystem: ${value}`)
}

function readProviderSubsystem(params: unknown): RuntimeProviderSubsystem | null {
  const input = readProviderObject(params)
  const value =
    readProviderOptionalString(input.subsystem) ??
    readProviderOptionalString(input.name) ??
    readProviderOptionalString(input.kind)
  if (!value) {
    return null
  }
  if (value === 'browser' || value === 'computer' || value === 'emulator') {
    return value
  }
  throw new Error(`Unsupported native provider subsystem: ${value}`)
}

function readProviderObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readProviderOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readRateLimitParams(params: unknown): { force?: boolean } {
  const input = readProviderObject(params)
  return input.force === true ? { force: true } : {}
}

function readGitLabRateLimitParams(params: unknown): { force?: boolean; host?: string | null } {
  const input = readProviderObject(params)
  const host = readProviderOptionalString(input.host)
  return { ...readRateLimitParams(input), ...(host ? { host } : {}) }
}

function readProviderRequiredString(value: unknown, label: string): string {
  const result = readProviderOptionalString(value)
  if (!result) {
    throw new Error(`${label} is required`)
  }
  return result
}

function readProviderStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

function readTerminalFitOverrides(): TerminalFitOverrideSnapshot[] {
  return Array.from(terminalFitOverrides.entries()).map(([ptyId, override]) => ({
    ptyId,
    ...override
  }))
}

function readTerminalDrivers(): TerminalDriverSnapshot[] {
  return Array.from(terminalDrivers.entries()).map(([ptyId, driver]) => ({
    ptyId,
    driver
  }))
}

function readBrowserDrivers(): BrowserDriverSnapshot[] {
  return Array.from(browserDrivers.entries()).map(([browserPageId, driver]) => ({
    browserPageId,
    driver
  }))
}

async function readBrowserDriversFromRuntime(): Promise<BrowserDriverSnapshot[]> {
  try {
    const snapshots = await requestRuntimeJson<unknown[]>('/v1/browser/drivers', {
      method: 'GET',
      timeoutMs: 5000
    })
    for (const snapshot of snapshots) {
      const input = readProviderObject(snapshot)
      const browserPageId = readProviderOptionalString(input.browserPageId)
      const driver = readProviderObject(input.driver)
      if (!browserPageId) {
        continue
      }
      if (driver.kind === 'mobile' && typeof driver.clientId === 'string') {
        setBrowserDriver(browserPageId, { kind: 'mobile', clientId: driver.clientId })
      } else if (driver.kind === 'desktop' || driver.kind === 'idle') {
        setBrowserDriver(browserPageId, { kind: driver.kind })
      }
    }
  } catch {
    // Why: retain push-fed state when an older runtime lacks snapshot hydration.
  }
  return readBrowserDrivers()
}

function getTerminalDriver(ptyId: string): RuntimeTerminalDriverState {
  return terminalDrivers.get(ptyId) ?? { kind: 'idle' }
}

function setTerminalDriver(ptyId: string, driver: RuntimeTerminalDriverState): void {
  const previous = getTerminalDriver(ptyId)
  if (sameRuntimeDriver(previous, driver)) {
    return
  }
  if (driver.kind === 'idle') {
    terminalDrivers.delete(ptyId)
  } else {
    terminalDrivers.set(ptyId, driver)
  }
  emitToSet(terminalDriverListeners, { ptyId, driver })
}

function getBrowserDriver(browserPageId: string): RuntimeBrowserDriverState {
  return browserDrivers.get(browserPageId) ?? { kind: 'idle' }
}

function setBrowserDriver(browserPageId: string, driver: RuntimeBrowserDriverState): void {
  const previous = getBrowserDriver(browserPageId)
  if (sameRuntimeDriver(previous, driver)) {
    return
  }
  if (driver.kind === 'idle') {
    browserDrivers.delete(browserPageId)
  } else {
    browserDrivers.set(browserPageId, driver)
  }
  emitToSet(browserDriverListeners, { browserPageId, driver })
}

function sameRuntimeDriver(
  left: RuntimeTerminalDriverState | RuntimeBrowserDriverState,
  right: RuntimeTerminalDriverState | RuntimeBrowserDriverState
): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'mobile' && right.kind === 'mobile') {
    return left.clientId === right.clientId
  }
  return true
}

function emitTerminalFitOverride(event: TerminalFitOverrideEvent): void {
  if (event.mode === 'mobile-fit') {
    terminalFitOverrides.set(event.ptyId, {
      mode: 'mobile-fit',
      cols: event.cols,
      rows: event.rows
    })
  } else {
    terminalFitOverrides.delete(event.ptyId)
  }
  emitToSet(terminalFitOverrideListeners, event)
}

async function restoreTauriTerminalFit(ptyId: string): Promise<{ restored: boolean }> {
  const hadFitOverride = terminalFitOverrides.has(ptyId)
  const previousDriver = getTerminalDriver(ptyId)
  if (hadFitOverride) {
    emitTerminalFitOverride({ ptyId, mode: 'desktop-fit', cols: 0, rows: 0 })
  }
  // Why: the runtime enforces the presence lock on writes, so a desktop
  // take-back must flip the runtime-side driver too, not only the mirror.
  await requestRuntimeJson(`/v1/sessions/${encodeURIComponent(ptyId)}/reclaim-desktop`, {
    method: 'POST',
    timeoutMs: 5000
  }).catch(() => undefined)
  setTerminalDriver(ptyId, { kind: 'desktop' })
  return { restored: hadFitOverride || previousDriver.kind === 'mobile' }
}

async function reclaimTauriBrowserForDesktop(
  browserPageId: string
): Promise<{ reclaimed: boolean }> {
  const previousDriver = getBrowserDriver(browserPageId)
  await requestRuntimeJson(
    `/v1/browser/tabs/${encodeURIComponent(browserPageId)}/reclaim-desktop`,
    { method: 'POST', timeoutMs: 5000 }
  )
  setBrowserDriver(browserPageId, { kind: 'desktop' })
  return { reclaimed: previousDriver.kind === 'mobile' }
}

function subscribeToSet<TEvent>(
  listeners: Set<(event: TEvent) => void>,
  callback: (event: TEvent) => void
): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

function emitToSet<TEvent>(listeners: Set<(event: TEvent) => void>, event: TEvent): void {
  for (const listener of listeners) {
    listener(event)
  }
}

function readComputerPermissionsArgs(
  params: unknown
): Parameters<typeof openTauriComputerUsePermissionSetup>[0] {
  const id = readRuntimeObject(params).id
  if (id === 'accessibility' || id === 'screenshots') {
    return { id }
  }
  return {}
}

function toRepoAddArgs(params: unknown): Parameters<PreloadApi['repos']['add']>[0] {
  const input = readRuntimeObject(params)
  return {
    path: readRuntimeRequiredString(input.path, 'repo path'),
    kind: readRuntimeString(input.kind) === 'folder' ? 'folder' : 'git'
  }
}

function toRepoCreateArgs(params: unknown): Parameters<PreloadApi['repos']['create']>[0] {
  const input = readRuntimeObject(params)
  return {
    parentPath: readRuntimeRequiredString(input.parentPath, 'parent path'),
    name: readRuntimeRequiredString(input.name, 'repo name'),
    kind: readRuntimeString(input.kind) === 'folder' ? 'folder' : 'git'
  }
}

function toRepoCloneArgs(params: unknown): Parameters<PreloadApi['repos']['clone']>[0] {
  const input = readRuntimeObject(params)
  return {
    url: readRuntimeRequiredString(input.url, 'clone url'),
    destination: readRuntimeRequiredString(input.destination, 'clone destination')
  }
}

function toRepoUpdateArgs(params: unknown): Parameters<PreloadApi['repos']['update']>[0] {
  const input = readRuntimeObject(params)
  return {
    repoId: requireRepoId(params),
    updates: readRuntimeObject(input.updates)
  }
}

async function searchRuntimeRepoRefs(params: unknown): Promise<{
  refs: string[]
  refDetails: { refName: string; localBranchName: string }[]
  truncated: boolean
}> {
  const input = readRuntimeObject(params)
  const repoId = requireRepoId(params)
  const query = readRuntimeString(input.query) ?? ''
  const limit = readRuntimeNumber(input.limit)
  const [refs, refDetails] = await Promise.all([
    window.api.repos.searchBaseRefs({ repoId, query, limit }),
    window.api.repos.searchBaseRefDetails({ repoId, query, limit })
  ])
  return { refs, refDetails, truncated: false }
}

async function readRuntimeRepoHooksCheck(params: unknown): Promise<{
  status: 'ok' | 'error'
  hasHooks: boolean
  hooks: PebbleHooks | null
  mayNeedUpdate: boolean
}> {
  const repoId = requireRepoId(params)
  const repo = (await readRepos()).find((entry) => entry.id === repoId)
  if (!repo || repo.kind === 'folder') {
    return { status: 'ok', hasHooks: false, hooks: null, mayNeedUpdate: false }
  }
  const content = await readRuntimeRepoTextFile(repoId, 'pebble.yaml')
  if (content === null) {
    return { status: 'ok', hasHooks: false, hooks: null, mayNeedUpdate: false }
  }
  const hooks = parsePebbleYaml(content)
  return {
    status: 'ok',
    hasHooks: true,
    hooks,
    mayNeedUpdate: hooks === null && hasUnrecognizedPebbleYamlKeys(content)
  }
}

async function inspectRuntimeRepoSetupScriptImports(
  params: unknown
): Promise<SetupScriptImportCandidate[]> {
  const repoId = requireRepoId(params)
  const repo = (await readRepos()).find((entry) => entry.id === repoId)
  if (!repo || repo.kind === 'folder') {
    return []
  }
  return inspectSetupScriptImportCandidates((relativePath) =>
    readRuntimeRepoTextFile(repoId, relativePath)
  )
}

function hasUnrecognizedPebbleYamlKeys(content: string): boolean {
  const recognized = new Set(['scripts', 'issueCommand', 'defaultTabs', 'environmentRecipes'])
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(\s|$)/)
    if (match && !recognized.has(match[1])) {
      return true
    }
  }
  return false
}

async function readRuntimeRepoIssueCommand(params: unknown): Promise<{
  status: 'ok' | 'error'
  localContent: string | null
  sharedContent: string | null
  effectiveContent: string | null
  localFilePath: string
  source: 'local' | 'shared' | 'none'
}> {
  const repoId = requireRepoId(params)
  const repo = (await readRepos()).find((entry) => entry.id === repoId)
  if (!repo || repo.kind === 'folder') {
    return {
      status: 'ok',
      localContent: null,
      sharedContent: null,
      effectiveContent: null,
      localFilePath: '',
      source: 'none'
    }
  }
  const localFilePath = joinRuntimeControlPath(repo.path, '.pebble/issue-command')
  const localContent =
    (await readRuntimeRepoTextFile(repoId, '.pebble/issue-command'))?.trim() || null
  const sharedContent =
    parsePebbleYaml(
      (await readRuntimeRepoTextFile(repoId, 'pebble.yaml')) ?? ''
    )?.issueCommand?.trim() || null
  const effectiveContent = localContent ?? sharedContent
  return {
    status: 'ok',
    localContent,
    sharedContent,
    effectiveContent,
    localFilePath,
    source: localContent ? 'local' : sharedContent ? 'shared' : 'none'
  }
}

async function readRuntimeRepoTextFile(repoId: string, filePath: string): Promise<string | null> {
  return requestRuntimeJson<{ content: string }>(
    `/v1/files/read?${new URLSearchParams({ projectId: repoId, path: filePath }).toString()}`,
    { method: 'GET', timeoutMs: 3000 }
  )
    .then((result) => result.content)
    .catch(() => null)
}

async function writeRuntimeRepoIssueCommand(params: unknown): Promise<{ ok: true }> {
  const input = readRuntimeObject(params)
  await requestRuntimeJson('/v1/files/write', {
    method: 'POST',
    timeoutMs: 5000,
    body: {
      projectId: requireRepoId(params),
      path: '.pebble/issue-command',
      content: readRuntimeRawString(input.content) ?? '',
      createDirs: true
    }
  })
  return { ok: true }
}

function toWorktreePrefetchArgs(
  params: unknown
): Parameters<PreloadApi['worktrees']['prefetchCreateBase']>[0] {
  const input = readRuntimeObject(params)
  return {
    repoId: requireRepoId(params),
    baseBranch: readRuntimeString(input.baseBranch) ?? undefined
  }
}

function toWorktreeResolvePrArgs(
  params: unknown
): Parameters<PreloadApi['worktrees']['resolvePrBase']>[0] {
  const input = readRuntimeObject(params)
  return {
    repoId: requireRepoId(params),
    prNumber: readRuntimeNumber(input.prNumber) ?? 0,
    headRefName: readRuntimeString(input.headRefName) ?? '',
    baseRefName: readRuntimeString(input.baseRefName) ?? '',
    isCrossRepository: input.isCrossRepository === true
  }
}

function toWorktreeResolveMrArgs(
  params: unknown
): Parameters<PreloadApi['worktrees']['resolveMrBase']>[0] {
  const input = readRuntimeObject(params)
  return {
    repoId: requireRepoId(params),
    mrIid: readRuntimeNumber(input.mrIid) ?? 0,
    sourceBranch: readRuntimeString(input.sourceBranch) ?? '',
    targetBranch: readRuntimeString(input.targetBranch) ?? '',
    isCrossRepository: input.isCrossRepository === true
  }
}

function toForceDeleteBranchArgs(
  params: unknown
): Parameters<PreloadApi['worktrees']['forceDeletePreservedBranch']>[0] {
  const input = readRuntimeObject(params)
  return {
    worktreeId: requireWorktreeId(params),
    branchName: readRuntimeRequiredString(input.branchName, 'branch name'),
    expectedHead: readRuntimeRequiredString(input.expectedHead, 'expected branch head')
  }
}

async function activateTauriWorktree(params: unknown): Promise<{
  repoId: string
  worktreeId: string
  activated: true
}> {
  const worktreeId = requireWorktreeId(params)
  const worktree = (await readWorktrees()).find((entry) => entry.id === worktreeId)
  if (!worktree) {
    throw new Error(`Worktree not found: ${worktreeId}`)
  }
  emitTauriActivateWorktree({
    repoId: worktree.repoId,
    worktreeId
  })
  return {
    repoId: worktree.repoId,
    worktreeId,
    activated: true
  }
}

function requireRepoId(params: unknown): string {
  const repoId = getRuntimeRepoId(params)
  if (!repoId) {
    throw new Error('Missing repo id')
  }
  return repoId
}

function requireWorktreeId(params: unknown): string {
  const input = readRuntimeObject(params)
  const nested = readRuntimeObject(input.worktree)
  const value =
    readRuntimeString(input.worktreeId) ??
    readRuntimeString(input.worktree) ??
    readRuntimeString(nested.id) ??
    readRuntimeString(nested.worktreeId)
  if (!value) {
    throw new Error('Missing worktree id')
  }
  if (value.startsWith('id:worktree:')) {
    return value.slice('id:worktree:'.length)
  }
  if (value.startsWith('worktree:')) {
    return value.slice('worktree:'.length)
  }
  return value.startsWith('id:') ? value.slice('id:'.length) : value
}

function joinRuntimeControlPath(base: string, child: string): string {
  if (!base) {
    return child
  }
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return base.endsWith('/') || base.endsWith('\\')
    ? `${base}${child}`
    : `${base}${separator}${child}`
}

function readRuntimeObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readRuntimeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readRuntimeRawString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readRuntimeRequiredString(value: unknown, label: string): string {
  const result = readRuntimeString(value)
  if (!result) {
    throw new Error(`${label} is required`)
  }
  return result
}

function readRuntimeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toConnectionParams(params: unknown): { connectionId: string } {
  const connectionId =
    typeof params === 'object' && params !== null && 'connectionId' in params
      ? String(params.connectionId)
      : ''
  return { connectionId }
}

function toOrderedIds(params: unknown): string[] {
  if (typeof params !== 'object' || params === null) {
    return []
  }
  const orderedIds = (params as Record<string, unknown>).orderedIds
  return Array.isArray(orderedIds)
    ? orderedIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
}
