import { installWebPreloadApi } from '@/web/web-preload-api'

import type {
  PreflightStatus,
  PreloadApi,
  RefreshAgentsResult
} from '../../../src/preload/api-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION
} from '../../../src/shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../src/shared/runtime-rpc-envelope'
import type {
  RuntimeStatus,
  RuntimeSyncWindowGraph,
  RuntimeSyncWindowGraphResult
} from '../../../src/shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../src/shared/runtime-environments'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  DetectedWorktreeListResult,
  Project,
  ProjectHostSetup,
  RemoveWorktreeResult,
  Repo,
  Worktree,
  WorktreeMeta
} from '../../../src/shared/types'
import {
  createRuntimeProcessStartCommand,
  createRuntimeResourceGetCommand,
  createRuntimeResourceRequestCommand,
  createRuntimeStatusProbeCommand,
  getRuntimeProcessStatus,
  getRuntimeResourceJson,
  probeRuntimeStatus,
  requestRuntimeResourceJson,
  startRuntimeProcess
} from './runtime-bridge'
import { pickNativeDirectories, pickNativeDirectory } from './native-dialog-bridge'
import { PRODUCT_LOCAL_RUNTIME_NAME, PRODUCT_NAME } from './product-brand'
import { DEFAULT_RUNTIME_URL, type RuntimeResourceGetResult } from './runtime-command-shapes'
import { MANAGED_WORKTREE_OWNERSHIP } from '../../../src/shared/worktree-ownership'

type PebbleRuntimeProject = {
  id: string
  name: string
  path: string
  locationKind: string
  hostId?: string
  provider?: string
  createdAt: string
  updatedAt: string
}

type PebbleRuntimeWorktree = {
  id: string
  projectId: string
  path: string
  branch?: string
  base?: string
  reviewKind?: string
  reviewId?: string
  createdAt: string
  updatedAt: string
}

type PebbleRuntimeStatus = {
  version: string
  startedAt: string
  uptimeSeconds: number
  projectCount: number
  worktreeCount: number
  sessionCount: number
  agentRunCount: number
  taskCount: number
  capabilities: string[]
  unavailableTools?: string[]
}

type RuntimeHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

const PEBBLE_RUNTIME_ID = 'pebble-local'
const PEBBLE_ENVIRONMENT_ID = 'pebble-local-runtime'
const DEFAULT_REPO_BADGE_COLOR = '#737373'

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

function createPebbleProjectsApi(base: PreloadApi['projects']): PreloadApi['projects'] {
  return {
    ...base,
    list: async () => projectHostSetupProjectionFromRepos(await readRepos()).projects,
    listHostSetups: async () => projectHostSetupProjectionFromRepos(await readRepos()).setups,
    update: async ({ projectId, updates }) => {
      const repos = await readRepos()
      const projection = projectHostSetupProjectionFromRepos(repos)
      const project = projection.projects.find((entry) => entry.id === projectId)
      return project ? ({ ...project, ...updates, updatedAt: Date.now() } satisfies Project) : null
    }
  }
}

function createPebbleReposApi(base: PreloadApi['repos']): PreloadApi['repos'] {
  return {
    ...base,
    list: readRepos,
    add: async ({ path, kind }) => {
      try {
        const project = await createRuntimeProject({
          name: pathBasename(path),
          path,
          locationKind: 'local'
        })
        return { repo: mapRuntimeProjectToRepo(project, kind) }
      } catch (error) {
        return { error: getErrorMessage(error) }
      }
    },
    addRemote: async ({ connectionId, remotePath, displayName, kind }) => {
      try {
        const project = await createRuntimeProject({
          name: displayName?.trim() || pathBasename(remotePath),
          path: remotePath,
          locationKind: 'ssh',
          hostId: connectionId
        })
        return { repo: mapRuntimeProjectToRepo(project, kind) }
      } catch (error) {
        return { error: getErrorMessage(error) }
      }
    },
    create: async ({ parentPath, name, kind }) => {
      try {
        const path = joinRuntimePath(parentPath, name)
        const project = await createRuntimeProject({ name, path, locationKind: 'local' })
        return { repo: mapRuntimeProjectToRepo(project, kind) }
      } catch (error) {
        return { error: getErrorMessage(error) }
      }
    },
    createRemote: async ({ connectionId, parentPath, name, kind }) => {
      try {
        const path = joinRuntimePath(parentPath, name)
        const project = await createRuntimeProject({
          name,
          path,
          locationKind: 'ssh',
          hostId: connectionId
        })
        return { repo: mapRuntimeProjectToRepo(project, kind) }
      } catch (error) {
        return { error: getErrorMessage(error) }
      }
    },
    remove: async ({ repoId }) => {
      await requestRuntimeJson<PebbleRuntimeProject>(`/v1/projects/${encodeURIComponent(repoId)}`, {
        method: 'DELETE'
      })
    },
    reorder: () => Promise.resolve({ status: 'applied' }),
    pickFolder: pickNativeDirectory,
    pickDirectory: pickNativeDirectory,
    pickFolders: pickNativeDirectories,
    update: async ({ repoId, updates }) => {
      const body: Record<string, unknown> = {}
      if (typeof updates.displayName === 'string') {
        body.name = updates.displayName
      }
      if (typeof updates.kind === 'string') {
        body.provider = updates.kind
      }
      const project = await requestRuntimeJson<PebbleRuntimeProject>(
        `/v1/projects/${encodeURIComponent(repoId)}`,
        { method: 'PATCH', body }
      )
      return mapRuntimeProjectToRepo(project, updates.kind)
    },
    isGitAvailable: async () => {
      const status = await readPebbleStatusOrNull()
      return !status?.unavailableTools?.includes('git')
    },
    getDefaultCreateProjectParent: () => Promise.resolve('~/pebble/workspaces'),
    getBaseRefDefault: () => Promise.resolve({ defaultBaseRef: null, remoteCount: 0 }),
    searchBaseRefs: () => Promise.resolve([]),
    searchBaseRefDetails: () => Promise.resolve([]),
    onChanged: () => noopUnsubscribe
  }
}

function createPebbleWorktreesApi(base: PreloadApi['worktrees']): PreloadApi['worktrees'] {
  return {
    ...base,
    list: async ({ repoId }) => readWorktrees(repoId),
    listAll: async () => readWorktrees(),
    listDetected: async ({ repoId }) => {
      const worktrees = await readWorktrees(repoId)
      return {
        repoId,
        authoritative: true,
        source: 'metadata-fallback',
        worktrees: worktrees.map((worktree) => ({
          ...worktree,
          ownership: MANAGED_WORKTREE_OWNERSHIP,
          selectedCheckout: false,
          visible: true
        }))
      } satisfies DetectedWorktreeListResult
    },
    create: async (args) => {
      const worktree = await createRuntimeWorktree(args)
      return { worktree } satisfies CreateWorktreeResult
    },
    remove: async ({ worktreeId }) => {
      await requestRuntimeJson<PebbleRuntimeWorktree>(
        `/v1/worktrees/${encodeURIComponent(worktreeId)}`,
        { method: 'DELETE' }
      )
      return {} satisfies RemoveWorktreeResult
    },
    updateMeta: async ({ worktreeId, updates }) => {
      const current = (await readWorktrees()).find((entry) => entry.id === worktreeId)
      if (!current) {
        throw new Error(`Worktree not found: ${worktreeId}`)
      }
      return applyWorktreeMeta(current, updates)
    },
    listLineage: () => Promise.resolve({ lineage: {}, workspaceLineage: {} }),
    updateLineage: () => Promise.resolve(null),
    persistSortOrder: () => Promise.resolve(),
    prefetchCreateBase: () => Promise.resolve(),
    resolvePrBase: () => Promise.resolve({ error: 'Pull request base resolution is not available.' }),
    resolveMrBase: () =>
      Promise.resolve({ error: 'Merge request base resolution is not available.' }),
    forceDeletePreservedBranch: () => Promise.resolve({ deleted: true }),
    onChanged: () => noopUnsubscribe,
    onCreateProgress: () => noopUnsubscribe,
    onBaseStatus: () => noopUnsubscribe,
    onRemoteBranchConflict: () => noopUnsubscribe
  }
}

function createPebbleRuntimeApi(base: PreloadApi['runtime']): PreloadApi['runtime'] {
  return {
    ...base,
    syncWindowGraph: (graph) => readOrCreateRuntimeStatus(graph),
    getStatus: () => readOrCreateRuntimeStatus(),
    call: ({ method, params }) => callPebbleRuntimeMethod(method, params),
    getTerminalFitOverrides: () => Promise.resolve([]),
    getTerminalDrivers: () => Promise.resolve([]),
    getBrowserDrivers: () => Promise.resolve([]),
    restoreTerminalFit: () => Promise.resolve({ restored: false }),
    reclaimBrowserForDesktop: () => Promise.resolve({ reclaimed: false }),
    onTerminalFitOverrideChanged: () => noopUnsubscribe,
    onTerminalDriverChanged: () => noopUnsubscribe,
    onBrowserDriverChanged: () => noopUnsubscribe
  }
}

function createPebbleRuntimeEnvironmentsApi(
  base: PreloadApi['runtimeEnvironments']
): PreloadApi['runtimeEnvironments'] {
  return {
    ...base,
    list: () => Promise.resolve([createPebbleRuntimeEnvironment()]),
    resolve: () => Promise.resolve(createPebbleRuntimeEnvironment()),
    getStatus: async () => okRuntimeRpc(await readOrCreateRuntimeStatus()),
    call: ({ method, params }) => callPebbleRuntimeMethod(method, params),
    addFromPairingCode: async ({ name }) => ({
      environment: { ...createPebbleRuntimeEnvironment(), name }
    }),
    remove: () => Promise.resolve({ removed: createPebbleRuntimeEnvironment() }),
    disconnect: () => Promise.resolve({ disconnected: createPebbleRuntimeEnvironment() }),
    subscribe: async (_args, callbacks) => {
      callbacks.onClose?.()
      return { unsubscribe: noopUnsubscribe, sendBinary: noopSendBinary }
    }
  }
}

async function callPebbleRuntimeMethod(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown>> {
  try {
    switch (method) {
      case 'status.get':
        return okRuntimeRpc(await readOrCreateRuntimeStatus())
      case 'repo.list':
        return okRuntimeRpc({ repos: await readRepos() })
      case 'project.list':
        return okRuntimeRpc({ projects: projectHostSetupProjectionFromRepos(await readRepos()).projects })
      case 'projectHostSetup.list':
        return okRuntimeRpc({ setups: projectHostSetupProjectionFromRepos(await readRepos()).setups })
      case 'worktree.list':
        return okRuntimeRpc({ worktrees: await readWorktrees(getRuntimeRepoId(params)) })
      case 'worktree.lineageList':
        return okRuntimeRpc({ lineage: {}, workspaceLineage: {} })
      case 'worktree.create':
        return okRuntimeRpc({ worktree: await createRuntimeWorktree(toCreateWorktreeArgs(params)) })
      case 'worktree.set':
        return okRuntimeRpc({ worktree: await setRuntimeWorktreeMeta(params) })
      case 'worktree.remove':
        await removeRuntimeWorktree(params)
        return okRuntimeRpc({ preservedBranch: undefined })
      case 'preflight.check':
        return okRuntimeRpc(await window.api.preflight.check())
      default:
        return failRuntimeRpc(
          'method_not_available',
          `${PRODUCT_NAME} runtime method is not mapped: ${method}`
        )
    }
  } catch (error) {
    return failRuntimeRpc('runtime_error', getErrorMessage(error))
  }
}

async function readRepos(): Promise<Repo[]> {
  await ensurePebbleRuntimeProcess()
  const projects = await requestRuntimeJson<PebbleRuntimeProject[]>('/v1/projects', {
    method: 'GET'
  }).catch(() => [])
  return projects.map((project) => mapRuntimeProjectToRepo(project))
}

async function readWorktrees(projectId?: string): Promise<Worktree[]> {
  await ensurePebbleRuntimeProcess()
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  const runtimeWorktrees = await requestRuntimeJson<PebbleRuntimeWorktree[]>(
    `/v1/worktrees${query}`,
    { method: 'GET' }
  ).catch(() => [])
  return runtimeWorktrees.map(mapRuntimeWorktreeToWorktree)
}

async function createRuntimeProject(args: {
  name: string
  path: string
  locationKind: string
  hostId?: string
}): Promise<PebbleRuntimeProject> {
  return requestRuntimeJson<PebbleRuntimeProject>('/v1/projects', {
    method: 'POST',
    body: {
      name: args.name,
      path: args.path,
      locationKind: args.locationKind,
      ...(args.hostId ? { hostId: args.hostId } : {})
    }
  })
}

async function createRuntimeWorktree(args: CreateWorktreeArgs): Promise<Worktree> {
  const repo = (await readRepos()).find((entry) => entry.id === args.repoId)
  const parentPath = repo?.worktreeBasePath || repo?.path || ''
  const path = joinRuntimePath(parentPath, args.name)
  const runtimeWorktree = await requestRuntimeJson<PebbleRuntimeWorktree>('/v1/worktrees', {
    method: 'POST',
    body: {
      projectId: args.repoId,
      path,
      branch: args.branchNameOverride ?? args.name,
      base: args.baseBranch ?? '',
      executeGit: true
    }
  })
  return applyWorktreeMeta(mapRuntimeWorktreeToWorktree(runtimeWorktree), {
    ...(args.displayName ? { displayName: args.displayName } : {}),
    ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
    ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
    ...(args.linkedLinearIssue !== undefined ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
    ...(args.workspaceStatus ? { workspaceStatus: args.workspaceStatus } : {}),
    ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
    ...(args.createdWithAgent ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(args.pendingFirstAgentMessageRename !== undefined
      ? { pendingFirstAgentMessageRename: args.pendingFirstAgentMessageRename }
      : {})
  })
}

async function setRuntimeWorktreeMeta(params: unknown): Promise<Worktree> {
  const selector = readObject(params)
  const worktreeId =
    readString(selector.worktreeId) ??
    readString(selector.worktree) ??
    readString(readObject(selector.worktree).id)
  if (!worktreeId) {
    throw new Error('Missing worktree id')
  }
  const updates = readObject(params) as Partial<WorktreeMeta>
  const current = (await readWorktrees()).find((entry) => entry.id === worktreeId)
  if (!current) {
    throw new Error(`Worktree not found: ${worktreeId}`)
  }
  return applyWorktreeMeta(current, updates)
}

async function removeRuntimeWorktree(params: unknown): Promise<void> {
  const payload = readObject(params)
  const worktreeId =
    readString(payload.worktreeId) ??
    readString(payload.worktree) ??
    readString(readObject(payload.worktree).id)
  if (!worktreeId) {
    throw new Error('Missing worktree id')
  }
  await requestRuntimeJson<PebbleRuntimeWorktree>(`/v1/worktrees/${encodeURIComponent(worktreeId)}`, {
    method: 'DELETE'
  })
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
    capabilities: [...RUNTIME_CAPABILITIES],
    hostPlatform: getHostPlatform(),
    remoteControl: null,
    agentOrchestrationByPaneKey: {}
  }
}

async function readPebbleStatusOrNull(): Promise<PebbleRuntimeStatus | null> {
  try {
    if (hasTauriInternals()) {
      const result = await probeRuntimeStatus(createRuntimeStatusProbeCommand({ timeoutMs: 1000 }))
      if (result.transport !== 'connected' || !result.body) {
        return null
      }
      return JSON.parse(result.body) as PebbleRuntimeStatus
    }
    return await requestRuntimeJson<PebbleRuntimeStatus>('/v1/status', {
      method: 'GET',
      timeoutMs: 1000
    })
  } catch {
    return null
  }
}

async function ensurePebbleRuntimeProcess(): Promise<void> {
  if (!hasTauriInternals()) {
    return
  }
  const probe = await probeRuntimeStatus(createRuntimeStatusProbeCommand({ timeoutMs: 500 })).catch(
    () => null
  )
  if (probe?.transport === 'connected') {
    return
  }
  const processStatus = await getRuntimeProcessStatus().catch(() => null)
  if (processStatus?.running) {
    return
  }
  await startRuntimeProcess(
    createRuntimeProcessStartCommand({ listen: '127.0.0.1:17777' })
  ).catch(() => undefined)
}

async function requestRuntimeJson<T>(
  path: string,
  options: { method: RuntimeHttpMethod; body?: unknown; timeoutMs?: number }
): Promise<T> {
  if (hasTauriInternals()) {
    const result =
      options.method === 'GET'
        ? await getRuntimeResourceJson(
            createRuntimeResourceGetCommand({
              path,
              timeoutMs: options.timeoutMs ?? 1500
            })
          )
        : await requestRuntimeResourceJson(
            createRuntimeResourceRequestCommand({
              method: options.method,
              path,
              bodyJson: JSON.stringify(options.body ?? {}),
              timeoutMs: options.timeoutMs ?? 1500
            })
          )
    return parseRuntimeJsonResult<T>(result)
  }

  const response = await fetch(`${DEFAULT_RUNTIME_URL}${path}`, {
    method: options.method,
    headers:
      options.method === 'GET'
        ? undefined
        : {
            'Content-Type': 'application/json'
          },
    body: options.method === 'GET' ? undefined : JSON.stringify(options.body ?? {})
  })
  if (!response.ok) {
    throw new Error(`Runtime request failed with HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

function parseRuntimeJsonResult<T>(result: RuntimeResourceGetResult): T {
  if (result.transport !== 'connected') {
    throw new Error(result.error ?? `Runtime transport failed: ${result.transport}`)
  }
  if (result.httpStatus !== null && (result.httpStatus < 200 || result.httpStatus > 299)) {
    throw new Error(result.body ?? `Runtime request failed with HTTP ${result.httpStatus}`)
  }
  if (!result.body) {
    throw new Error('Runtime returned an empty JSON response.')
  }
  return JSON.parse(result.body) as T
}

function mapRuntimeProjectToRepo(
  project: PebbleRuntimeProject,
  kind: Repo['kind'] = 'git'
): Repo {
  const addedAt = dateMs(project.createdAt)
  const executionHostId =
    project.locationKind === 'ssh' && project.hostId
      ? (`ssh:${project.hostId}` as const)
      : LOCAL_EXECUTION_HOST_ID
  return {
    id: project.id,
    path: project.path,
    displayName: project.name || pathBasename(project.path),
    badgeColor: DEFAULT_REPO_BADGE_COLOR,
    addedAt,
    kind,
    connectionId: project.locationKind === 'ssh' ? (project.hostId ?? null) : null,
    executionHostId,
    projectHostSetupMethod: 'imported-existing-folder'
  }
}

function mapRuntimeWorktreeToWorktree(worktree: PebbleRuntimeWorktree): Worktree {
  const createdAt = dateMs(worktree.createdAt)
  return {
    id: worktree.id,
    instanceId: worktree.id,
    repoId: worktree.projectId,
    projectId: worktree.projectId,
    hostId: LOCAL_EXECUTION_HOST_ID,
    projectHostSetupId: worktree.projectId,
    path: worktree.path,
    head: '',
    branch: worktree.branch ?? '',
    isBare: false,
    isSparse: false,
    isMainWorktree: false,
    displayName: pathBasename(worktree.path),
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: createdAt,
    lastActivityAt: dateMs(worktree.updatedAt),
    createdAt,
    ...(worktree.base ? { baseRef: worktree.base } : {})
  }
}

function applyWorktreeMeta(worktree: Worktree, updates: Partial<WorktreeMeta>): Worktree {
  return {
    ...worktree,
    ...updates,
    linkedIssue: updates.linkedIssue ?? worktree.linkedIssue,
    linkedPR: updates.linkedPR ?? worktree.linkedPR,
    linkedLinearIssue: updates.linkedLinearIssue ?? worktree.linkedLinearIssue,
    lastActivityAt: Date.now()
  }
}

function createPebbleRuntimeEnvironment(): PublicKnownRuntimeEnvironment {
  const now = Date.now()
  return {
    id: PEBBLE_ENVIRONMENT_ID,
    name: PRODUCT_LOCAL_RUNTIME_NAME,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
    runtimeId: PEBBLE_RUNTIME_ID,
    source: 'manual',
    endpoints: [
      {
        id: 'http-local',
        kind: 'websocket',
        label: 'Local Runtime',
        endpoint: DEFAULT_RUNTIME_URL
      }
    ],
    preferredEndpointId: 'http-local'
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

function toCreateWorktreeArgs(params: unknown): CreateWorktreeArgs {
  const payload = readObject(params)
  return {
    repoId: readString(payload.repoId) ?? readString(payload.projectId) ?? '',
    name: readString(payload.name) ?? readString(payload.branch) ?? 'workspace',
    displayName: readString(payload.displayName),
    baseBranch: readString(payload.baseBranch) ?? readString(payload.base),
    branchNameOverride: readString(payload.branchNameOverride) ?? readString(payload.branch)
  }
}

function getRuntimeRepoId(params: unknown): string | undefined {
  const payload = readObject(params)
  return readString(payload.repoId) ?? readString(payload.projectId)
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function dateMs(value: string | undefined): number {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function pathBasename(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]+/).pop() || normalized || 'Project'
}

function joinRuntimePath(parentPath: string, name: string): string {
  const separator = parentPath.includes('\\') && !parentPath.includes('/') ? '\\' : '/'
  return parentPath.endsWith('/') || parentPath.endsWith('\\')
    ? `${parentPath}${name}`
    : `${parentPath}${separator}${name}`
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function getHostPlatform(): NodeJS.Platform {
  const userAgent = navigator.userAgent.toLowerCase()
  if (userAgent.includes('windows')) {
    return 'win32'
  }
  if (userAgent.includes('mac')) {
    return 'darwin'
  }
  return 'linux'
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function noopUnsubscribe(): void {}

function noopSendBinary(_bytes: Uint8Array<ArrayBufferLike>): void {}
