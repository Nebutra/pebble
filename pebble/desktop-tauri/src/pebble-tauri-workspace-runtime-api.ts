import { homeDir, join as joinNativePath } from '@tauri-apps/api/path'

import type { PreloadApi } from '../../../src/preload/api-types'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import type {
  RuntimeWorktreeCreateResult,
  RuntimeWorktreeRecord
} from '../../../src/shared/runtime-types'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  DetectedWorktreeListResult,
  ForceDeleteWorktreeBranchResult,
  GitWorktreeInfo,
  PreservedWorktreeBranch,
  Project,
  RemoveWorktreeResult,
  Repo,
  Worktree,
  WorktreeBaseStatusEvent,
  WorktreeLineage,
  WorkspaceLineage,
  WorktreeMeta,
  WorktreeRemoteBranchConflictEvent
} from '../../../src/shared/types'
import { MANAGED_WORKTREE_OWNERSHIP } from '../../../src/shared/worktree-ownership'
import { pickNativeDirectories, pickNativeDirectory } from './native-dialog-bridge'
import {
  ensurePebbleRuntimeProcess,
  getErrorMessage,
  readPebbleStatusOrNull,
  requestRuntimeJson
} from './pebble-tauri-runtime-transport'
import { createRuntimeEventStreamCommand, readRuntimeEventStream } from './runtime-bridge'
import type { RuntimeEventStreamEntry } from './runtime-command-shapes'
import {
  applyWorktreeMeta,
  joinRuntimePath,
  mapRuntimeProjectToRepo,
  mapRuntimeWorktreeToWorktree,
  pathBasename,
  readBoolean,
  readObject,
  readString,
  type PebbleRuntimeProject,
  type PebbleRuntimeWorktree
} from './pebble-tauri-workspace-runtime-records'
import {
  getTauriBaseRefDefault,
  resolveTauriMrBase,
  resolveTauriPrBase,
  searchTauriBaseRefDetails,
  searchTauriBaseRefs
} from './tauri-git-base-ref-api'

type RuntimeEvent = {
  topic: string
  payload?: unknown
}

type RuntimeWorktreeLineageListResponse = {
  lineage: Record<string, WorktreeLineage>
  workspaceLineage?: Record<string, WorkspaceLineage>
}

export type RuntimeCreateWorktreeArgs = CreateWorktreeArgs & {
  parentWorktree?: string
  parentWorkspace?: string
  envParentWorkspace?: string
  cwdParentWorktree?: string
  noParent?: boolean
  lineageOrigin?: 'cli' | 'manual'
}

type RuntimeLineageUpdateResult = {
  lineage: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
}

type WorktreeWithRuntimeLineage = Worktree & {
  lineage?: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
}

type RepoChangedListener = Parameters<PreloadApi['repos']['onChanged']>[0]
type WorktreeChangedListener = Parameters<PreloadApi['worktrees']['onChanged']>[0]
type WorktreeCreateProgressListener = Parameters<PreloadApi['worktrees']['onCreateProgress']>[0]
type WorktreeBaseStatusListener = Parameters<PreloadApi['worktrees']['onBaseStatus']>[0]
type WorktreeRemoteBranchConflictListener = Parameters<
  PreloadApi['worktrees']['onRemoteBranchConflict']
>[0]

type RuntimeGitBaseStatusResult = {
  status: WorktreeBaseStatusEvent['status']
  base: string
  remote?: string
  behind?: number
  recentSubjects?: string[]
  conflict?: {
    remote: string
    branchName: string
  }
}

type RuntimeCreateWorktreeInternalResult = {
  worktree: WorktreeWithRuntimeLineage
  initialBaseStatus?: WorktreeBaseStatusEvent
}

const repoChangedListeners = new Set<RepoChangedListener>()
const worktreeChangedListeners = new Set<WorktreeChangedListener>()
const worktreeCreateProgressListeners = new Set<WorktreeCreateProgressListener>()
const worktreeBaseStatusListeners = new Set<WorktreeBaseStatusListener>()
const worktreeRemoteBranchConflictListeners = new Set<WorktreeRemoteBranchConflictListener>()
let projectEventPumpStarted = false
let worktreeEventPumpStarted = false

export function createPebbleProjectsApi(base: PreloadApi['projects']): PreloadApi['projects'] {
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

export function createPebbleReposApi(base: PreloadApi['repos']): PreloadApi['repos'] {
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
    clone: async ({ url, destination }) => {
      const project = await requestRuntimeJson<PebbleRuntimeProject>('/v1/projects/clone', {
        method: 'POST',
        timeoutMs: 10 * 60_000,
        body: { url, destination }
      })
      return mapRuntimeProjectToRepo(project, 'git')
    },
    remove: async ({ repoId }) => {
      await requestRuntimeJson<PebbleRuntimeProject>(`/v1/projects/${encodeURIComponent(repoId)}`, {
        method: 'DELETE'
      })
    },
    reorder: ({ orderedIds }) => persistRuntimeProjectSortOrder(orderedIds),
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
    getDefaultCreateProjectParent: resolveDefaultCreateProjectParent,
    getBaseRefDefault: ({ repoId }) => getTauriBaseRefDefault(readRepos(), repoId),
    searchBaseRefs: (args) => searchTauriBaseRefs(readRepos(), args),
    searchBaseRefDetails: (args) => searchTauriBaseRefDetails(readRepos(), args),
    onChanged: (callback) => subscribeRepoChanged(callback)
  }
}

export function createPebbleWorktreesApi(base: PreloadApi['worktrees']): PreloadApi['worktrees'] {
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
      const result = await createRuntimeWorktreeWithStatus(args)
      return {
        worktree: result.worktree,
        ...(result.initialBaseStatus ? { initialBaseStatus: result.initialBaseStatus } : {})
      } satisfies CreateWorktreeResult
    },
    remove: async ({ worktreeId, force }) => {
      const preservedBranch = await removeRuntimeWorktreeById(worktreeId, { force })
      return (preservedBranch ? { preservedBranch } : {}) satisfies RemoveWorktreeResult
    },
    updateMeta: async ({ worktreeId, updates }) => {
      return updateRuntimeWorktreeMeta(worktreeId, updates)
    },
    listLineage: readRuntimeWorktreeLineage,
    updateLineage: updateRuntimeWorktreeLineage,
    persistSortOrder: ({ orderedIds }) => persistRuntimeWorktreeSortOrder(orderedIds),
    prefetchCreateBase: (args) => prefetchRuntimeWorktreeCreateBase(args),
    resolvePrBase: (args) => resolveTauriPrBase(readRepos(), args),
    resolveMrBase: (args) => resolveTauriMrBase(readRepos(), args),
    forceDeletePreservedBranch: ({ worktreeId, branchName, expectedHead }) =>
      forceDeleteRuntimePreservedBranch(worktreeId, branchName, expectedHead),
    onChanged: (callback) => subscribeWorktreeChanged(callback),
    onCreateProgress: (callback) => subscribeWorktreeCreateProgress(callback),
    onBaseStatus: (callback) => subscribeWorktreeBaseStatus(callback),
    onRemoteBranchConflict: (callback) => subscribeWorktreeRemoteBranchConflict(callback)
  }
}

export async function readRepos(): Promise<Repo[]> {
  await ensurePebbleRuntimeProcess()
  const projects = await requestRuntimeJson<PebbleRuntimeProject[]>('/v1/projects', {
    method: 'GET'
  }).catch(() => [])
  return projects.map((project) => mapRuntimeProjectToRepo(project))
}

export async function persistRuntimeProjectSortOrder(
  orderedIds: string[]
): Promise<{ status: 'applied' | 'rejected' }> {
  if (orderedIds.length === 0) {
    return { status: 'rejected' }
  }
  await requestRuntimeJson<{ status: string }>('/v1/projects/reorder', {
    method: 'POST',
    body: { orderedIds }
  })
  return { status: 'applied' }
}

export async function readWorktrees(projectId?: string): Promise<Worktree[]> {
  await ensurePebbleRuntimeProcess()
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  const runtimeWorktrees = await requestRuntimeJson<PebbleRuntimeWorktree[]>(
    `/v1/worktrees${query}`,
    { method: 'GET' }
  ).catch(() => [])
  return runtimeWorktrees.map(mapRuntimeWorktreeToWorktree)
}

export async function createRuntimeWorktree(
  args: RuntimeCreateWorktreeArgs
): Promise<WorktreeWithRuntimeLineage> {
  return (await createRuntimeWorktreeWithStatus(args)).worktree
}

async function createRuntimeWorktreeWithStatus(
  args: RuntimeCreateWorktreeArgs
): Promise<RuntimeCreateWorktreeInternalResult> {
  emitWorktreeCreateProgress(args.creationId, 'fetching')
  const repo = (await readRepos()).find((entry) => entry.id === args.repoId)
  const parentPath = repo?.worktreeBasePath || repo?.path || ''
  const path = joinRuntimePath(parentPath, args.name)
  const lineageUpdate = await resolveCreateRuntimeWorktreeLineage(args)
  emitWorktreeCreateProgress(args.creationId, 'creating')
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
  const initialMetaUpdates: Partial<WorktreeMeta> = {
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
  }
  let worktree: WorktreeWithRuntimeLineage = applyWorktreeMeta(
    mapRuntimeWorktreeToWorktree(runtimeWorktree),
    initialMetaUpdates
  )
  if (hasRuntimeWorktreeMetaBody(initialMetaUpdates)) {
    worktree = await updateRuntimeWorktreeMeta(worktree.id, initialMetaUpdates)
  }
  if (lineageUpdate) {
    const updated = await writeRuntimeWorktreeLineage({
      worktreeId: worktree.id,
      ...lineageUpdate
    })
    worktree = { ...worktree, lineage: updated.lineage }
  }
  const initialBaseStatus = createInitialRuntimeBaseStatus(args.repoId, runtimeWorktree)
  if (initialBaseStatus) {
    emitRuntimeWorktreeBaseStatus(initialBaseStatus)
    void reconcileRuntimeWorktreeBaseStatus(worktree, runtimeWorktree).catch((error) => {
      emitRuntimeWorktreeBaseStatus({
        ...initialBaseStatus,
        status: 'unknown',
        recentSubjects: [getErrorMessage(error)]
      })
    })
  }
  return {
    worktree,
    ...(initialBaseStatus ? { initialBaseStatus } : {})
  }
}

export async function createRuntimeWorktreeResult(
  args: RuntimeCreateWorktreeArgs
): Promise<RuntimeWorktreeCreateResult> {
  const worktree = await createRuntimeWorktree(args)
  const lineageList = await readRuntimeWorktreeLineage().catch(() => ({
    lineage: {},
    workspaceLineage: {}
  }))
  const record = mapWorktreeToRuntimeRecord(worktree, lineageList)
  return {
    worktree: record,
    lineage: record.lineage,
    workspaceLineage: record.workspaceLineage ?? null,
    warnings: []
  }
}

export async function setRuntimeWorktreeMeta(params: unknown): Promise<WorktreeWithRuntimeLineage> {
  const selector = readObject(params)
  const worktreeId =
    readString(selector.worktreeId) ??
    readString(selector.worktree) ??
    readString(readObject(selector.worktree).id)
  if (!worktreeId) {
    throw new Error('Missing worktree id')
  }
  if (
    selector.noParent === true ||
    selector.parentWorktree !== undefined ||
    selector.parentWorktreeId !== undefined ||
    selector.parentWorkspace !== undefined
  ) {
    const updated = await writeRuntimeWorktreeLineage({
      worktreeId,
      noParent: selector.noParent === true,
      parentWorktreeId:
        readRuntimeWorktreeSelectorId(selector.parentWorktreeId) ??
        readRuntimeWorktreeSelectorId(selector.parentWorktree),
      parentWorkspace: readString(selector.parentWorkspace),
      origin: 'manual'
    })
    const worktree = (await readWorktrees()).find((entry) => entry.id === worktreeId)
    if (!worktree) {
      throw new Error(`Worktree not found: ${worktreeId}`)
    }
    return { ...worktree, lineage: updated.lineage }
  }
  const updates = readObject(params) as Partial<WorktreeMeta>
  return updateRuntimeWorktreeMeta(worktreeId, updates)
}

export async function readRuntimeWorktreeLineage(): Promise<RuntimeWorktreeLineageListResponse> {
  return requestRuntimeJson<RuntimeWorktreeLineageListResponse>('/v1/worktrees/lineage', {
    method: 'GET'
  })
}

async function resolveCreateRuntimeWorktreeLineage(
  args: RuntimeCreateWorktreeArgs
): Promise<Omit<Parameters<typeof writeRuntimeWorktreeLineage>[0], 'worktreeId'> | null> {
  if (args.noParent === true) {
    return null
  }
  const origin = args.lineageOrigin ?? 'manual'
  const explicitCaptureSource = origin === 'cli' ? 'explicit-cli-flag' : 'manual-action'
  if (args.parentWorkspace) {
    const parentWorkspace = normalizeRuntimeParentWorkspace(args.parentWorkspace)
    if (!parentWorkspace) {
      throw new Error(`Invalid parent workspace: ${args.parentWorkspace}`)
    }
    return {
      parentWorkspace,
      origin,
      captureSource: explicitCaptureSource,
      captureConfidence: 'explicit'
    }
  }
  if (args.parentWorktree) {
    return {
      parentWorktreeId: await resolveRuntimeWorktreeSelectorId(args.parentWorktree),
      origin,
      captureSource: explicitCaptureSource,
      captureConfidence: 'explicit'
    }
  }
  if (args.envParentWorkspace) {
    const parentWorkspace = normalizeRuntimeParentWorkspace(args.envParentWorkspace)
    if (parentWorkspace) {
      return {
        parentWorkspace,
        origin: 'cli',
        captureSource: 'env-workspace',
        captureConfidence: 'inferred'
      }
    }
  }
  if (args.cwdParentWorktree) {
    return {
      parentWorktreeId: await resolveRuntimeWorktreeSelectorId(args.cwdParentWorktree),
      origin: 'cli',
      captureSource: 'cwd-context',
      captureConfidence: 'inferred'
    }
  }
  return null
}

async function updateRuntimeWorktreeLineage(args: {
  worktreeId: string
  parentWorktreeId?: string
  noParent?: boolean
}): Promise<WorktreeLineage | null> {
  return (await writeRuntimeWorktreeLineage(args)).lineage
}

async function writeRuntimeWorktreeLineage(args: {
  worktreeId: string
  parentWorktreeId?: string
  parentWorkspace?: string
  noParent?: boolean
  origin?: 'cli' | 'manual'
  captureSource?: string
  captureConfidence?: string
}): Promise<RuntimeLineageUpdateResult> {
  const worktree = await requestRuntimeJson<PebbleRuntimeWorktree>(
    `/v1/worktrees/${encodeURIComponent(args.worktreeId)}`,
    {
      method: 'PATCH',
      body: {
        ...(args.parentWorktreeId ? { parentWorktreeId: args.parentWorktreeId } : {}),
        ...(args.parentWorkspace ? { parentWorkspace: args.parentWorkspace } : {}),
        ...(args.noParent === true ? { noParent: true } : {}),
        ...(args.origin ? { origin: args.origin } : {}),
        ...(args.captureSource || args.captureConfidence
          ? {
              capture: {
                ...(args.captureSource ? { source: args.captureSource } : {}),
                ...(args.captureConfidence ? { confidence: args.captureConfidence } : {})
              }
            }
          : {})
      }
    }
  )
  return {
    lineage: worktree.lineage ?? null,
    workspaceLineage: worktree.workspaceLineage ?? null
  }
}

async function updateRuntimeWorktreeMeta(
  worktreeId: string,
  updates: Partial<WorktreeMeta>
): Promise<WorktreeWithRuntimeLineage> {
  const body = toRuntimeWorktreeMetaBody(updates)
  if (Object.keys(body).length === 0) {
    const current = (await readWorktrees()).find((entry) => entry.id === worktreeId)
    if (!current) {
      throw new Error(`Worktree not found: ${worktreeId}`)
    }
    return current
  }
  const worktree = await requestRuntimeJson<PebbleRuntimeWorktree>(
    `/v1/worktrees/${encodeURIComponent(worktreeId)}`,
    { method: 'PATCH', body }
  )
  return mapRuntimeWorktreeToWorktree(worktree)
}

export async function persistRuntimeWorktreeSortOrder(orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) {
    return
  }
  await requestRuntimeJson<{ status: string }>('/v1/worktrees/sort-order', {
    method: 'POST',
    body: { orderedIds }
  })
}

function hasRuntimeWorktreeMetaBody(updates: Partial<WorktreeMeta>): boolean {
  return Object.keys(toRuntimeWorktreeMetaBody(updates)).length > 0
}

function toRuntimeWorktreeMetaBody(updates: Partial<WorktreeMeta>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (updates.displayName !== undefined) {
    body.displayName = updates.displayName
  }
  if (updates.comment !== undefined) {
    body.comment = updates.comment
  }
  if (updates.isArchived !== undefined) {
    body.isArchived = updates.isArchived
  }
  if (updates.isUnread !== undefined) {
    body.isUnread = updates.isUnread
  }
  if (updates.isPinned !== undefined) {
    body.isPinned = updates.isPinned
  }
  if (updates.sortOrder !== undefined) {
    body.sortOrder = updates.sortOrder
  }
  if (updates.manualOrder !== undefined) {
    body.manualOrder = updates.manualOrder
  }
  if (updates.workspaceStatus !== undefined) {
    body.workspaceStatus = updates.workspaceStatus
  }
  // Forward link references (including explicit null to clear) so the runtime
  // round-trips them instead of silently dropping the write.
  if (updates.linkedIssue !== undefined) {
    body.linkedIssue = updates.linkedIssue
  }
  if (updates.linkedPR !== undefined) {
    body.linkedPR = updates.linkedPR
  }
  if (updates.linkedLinearIssue !== undefined) {
    body.linkedLinearIssue = updates.linkedLinearIssue
  }
  return body
}

type PebbleRuntimeDeleteWorktreeResponse = PebbleRuntimeWorktree & {
  preservedBranch: PreservedWorktreeBranch | null
}

type PreservedBranchCleanupTarget = {
  projectId: string
  branchName: string
  head?: string
}

// Track the runtime project + preserved branch for each removed worktree so a
// later force-delete can resolve the repo after the worktree record is gone,
// mirroring Electron's preservedBranchCleanupByWorktreeId map.
const preservedBranchCleanupByWorktreeId = new Map<string, PreservedBranchCleanupTarget>()

export async function removeRuntimeWorktree(
  params: unknown
): Promise<PreservedWorktreeBranch | null> {
  const payload = readObject(params)
  const worktreeId =
    readString(payload.worktreeId) ??
    readString(payload.worktree) ??
    readString(readObject(payload.worktree).id)
  if (!worktreeId) {
    throw new Error('Missing worktree id')
  }
  return removeRuntimeWorktreeById(worktreeId, { force: readBoolean(payload.force) ?? false })
}

async function removeRuntimeWorktreeById(
  worktreeId: string,
  options: { force?: boolean }
): Promise<PreservedWorktreeBranch | null> {
  const response = await deleteRuntimeWorktree(worktreeId, options)
  const preservedBranch = response.preservedBranch ?? null
  if (preservedBranch) {
    preservedBranchCleanupByWorktreeId.set(worktreeId, {
      projectId: response.projectId,
      branchName: preservedBranch.branchName,
      ...(preservedBranch.head ? { head: preservedBranch.head } : {})
    })
  } else {
    preservedBranchCleanupByWorktreeId.delete(worktreeId)
  }
  return preservedBranch
}

async function deleteRuntimeWorktree(
  worktreeId: string,
  options: { force?: boolean }
): Promise<PebbleRuntimeDeleteWorktreeResponse> {
  return requestRuntimeJson<PebbleRuntimeDeleteWorktreeResponse>(
    `/v1/worktrees/${encodeURIComponent(worktreeId)}`,
    {
      method: 'DELETE',
      body: {
        executeGit: true,
        force: options.force === true
      }
    }
  )
}

async function forceDeleteRuntimePreservedBranch(
  worktreeId: string,
  branchName: string,
  expectedHead: string
): Promise<ForceDeleteWorktreeBranchResult> {
  const target = preservedBranchCleanupByWorktreeId.get(worktreeId)
  const projectId = target?.projectId
  if (!projectId) {
    throw new Error(`No preserved branch is tracked for workspace: ${worktreeId}`)
  }
  await requestRuntimeJson<{ deleted: boolean }>('/v1/worktrees/branches/force-delete', {
    method: 'POST',
    body: {
      projectId,
      branchName: target.branchName || branchName,
      // Prefer the head Git preserved at removal time; fall back to the caller's.
      expectedHead: target.head ?? expectedHead
    }
  })
  preservedBranchCleanupByWorktreeId.delete(worktreeId)
  return { deleted: true }
}

export function toCreateWorktreeArgs(params: unknown): RuntimeCreateWorktreeArgs {
  const payload = readObject(params)
  return {
    repoId:
      readRuntimeRepoSelectorId(payload.repo) ??
      readString(payload.repoId) ??
      readString(payload.projectId) ??
      '',
    name: readString(payload.name) ?? readString(payload.branch) ?? 'workspace',
    displayName: readString(payload.displayName),
    baseBranch: readString(payload.baseBranch) ?? readString(payload.base),
    branchNameOverride: readString(payload.branchNameOverride) ?? readString(payload.branch),
    parentWorktree: readString(payload.parentWorktree),
    parentWorkspace: normalizeRuntimeParentWorkspace(payload.parentWorkspace),
    envParentWorkspace: readString(payload.envParentWorkspace),
    cwdParentWorktree: readString(payload.cwdParentWorktree),
    noParent: payload.noParent === true,
    creationId: readString(payload.creationId),
    lineageOrigin: 'cli'
  } satisfies RuntimeCreateWorktreeArgs
}

export function getRuntimeRepoId(params: unknown): string | undefined {
  const payload = readObject(params)
  return (
    readRuntimeRepoSelectorId(payload.repo) ??
    readString(payload.repoId) ??
    readString(payload.projectId)
  )
}

function mapWorktreeToRuntimeRecord(
  worktree: WorktreeWithRuntimeLineage,
  lineageList: RuntimeWorktreeLineageListResponse
): RuntimeWorktreeRecord {
  const lineage = lineageList.lineage[worktree.id] ?? worktree.lineage ?? null
  const workspaceLineage = lineageList.workspaceLineage?.[`worktree:${worktree.id}`] ?? null
  const childWorktreeIds = Object.values(lineageList.lineage)
    .filter((entry) => entry.parentWorktreeId === worktree.id)
    .map((entry) => entry.worktreeId)
  return {
    ...worktree,
    parentWorktreeId: lineage?.parentWorktreeId ?? null,
    childWorktreeIds,
    lineage,
    workspaceLineage,
    git: mapWorktreeGitInfo(worktree)
  }
}

function mapWorktreeGitInfo(worktree: Worktree): GitWorktreeInfo {
  return {
    path: worktree.path,
    head: worktree.head,
    branch: worktree.branch,
    isBare: worktree.isBare,
    isSparse: worktree.isSparse,
    isMainWorktree: worktree.isMainWorktree
  }
}

function normalizeRuntimeParentWorkspace(
  value: unknown
): RuntimeCreateWorktreeArgs['parentWorkspace'] {
  const raw = readString(value)
  if (!raw) {
    return undefined
  }
  const workspaceKey = raw.startsWith('id:') ? raw.slice('id:'.length) : raw
  if (workspaceKey.startsWith('worktree:') || workspaceKey.startsWith('folder:')) {
    return workspaceKey as RuntimeCreateWorktreeArgs['parentWorkspace']
  }
  return undefined
}

function readRuntimeRepoSelectorId(value: unknown): string | undefined {
  const raw = readString(value)
  const selector = readObject(value)
  const objectId =
    readString(selector.id) ?? readString(selector.repoId) ?? readString(selector.projectId)
  if (objectId) {
    return objectId
  }
  if (!raw) {
    return undefined
  }
  return raw.startsWith('id:') ? raw.slice('id:'.length) : raw
}

async function resolveRuntimeWorktreeSelectorId(value: unknown): Promise<string> {
  const directId = readRuntimeWorktreeSelectorId(value)
  if (directId) {
    return directId
  }
  const selector = readString(value)
  if (!selector) {
    throw new Error('Missing parent worktree selector')
  }
  const worktrees = await readWorktrees()
  const match = findRuntimeWorktreeBySelector(worktrees, selector)
  if (!match) {
    throw new Error(`Parent worktree selector was not found: ${selector}`)
  }
  return match.id
}

function readRuntimeWorktreeSelectorId(value: unknown): string | undefined {
  const raw = readString(value)
  const selector = readObject(value)
  const objectId = readString(selector.id) ?? readString(selector.worktreeId)
  if (objectId) {
    return objectId
  }
  if (!raw) {
    return undefined
  }
  if (raw.startsWith('id:worktree:')) {
    return raw.slice('id:worktree:'.length)
  }
  if (raw.startsWith('worktree:')) {
    return raw.slice('worktree:'.length)
  }
  if (raw.startsWith('id:')) {
    return raw.slice('id:'.length)
  }
  return raw.includes(':') ? undefined : raw
}

function findRuntimeWorktreeBySelector(
  worktrees: Worktree[],
  selector: string
): Worktree | undefined {
  if (selector.startsWith('branch:')) {
    const branch = selector.slice('branch:'.length)
    return worktrees.find((entry) => entry.branch === branch)
  }
  if (selector.startsWith('path:')) {
    const path = selector.slice('path:'.length)
    return worktrees.find((entry) => entry.path === path)
  }
  if (selector.startsWith('name:')) {
    const name = selector.slice('name:'.length)
    return worktrees.find(
      (entry) => entry.displayName === name || pathBasename(entry.path) === name
    )
  }
  return undefined
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

async function resolveDefaultCreateProjectParent(): Promise<string> {
  return joinNativePath(await homeDir(), 'pebble', 'workspaces')
}

function noopUnsubscribe(): void {}

function subscribeWorktreeBaseStatus(callback: WorktreeBaseStatusListener): () => void {
  worktreeBaseStatusListeners.add(callback)
  return () => {
    worktreeBaseStatusListeners.delete(callback)
  }
}

function subscribeWorktreeRemoteBranchConflict(
  callback: WorktreeRemoteBranchConflictListener
): () => void {
  worktreeRemoteBranchConflictListeners.add(callback)
  return () => {
    worktreeRemoteBranchConflictListeners.delete(callback)
  }
}

function emitRuntimeWorktreeBaseStatus(event: WorktreeBaseStatusEvent): void {
  for (const listener of Array.from(worktreeBaseStatusListeners)) {
    listener(event)
  }
}

function emitRuntimeWorktreeRemoteBranchConflict(event: WorktreeRemoteBranchConflictEvent): void {
  for (const listener of Array.from(worktreeRemoteBranchConflictListeners)) {
    listener(event)
  }
}

function createInitialRuntimeBaseStatus(
  repoId: string,
  worktree: PebbleRuntimeWorktree
): WorktreeBaseStatusEvent | undefined {
  const base = worktree.base?.trim()
  const createdBaseSha = worktree.createdBaseSha?.trim()
  if (!base || !createdBaseSha) {
    return undefined
  }
  const remote = parseRemoteTrackingBase(base)?.remote
  return {
    repoId,
    worktreeId: worktree.id,
    status: 'checking',
    base,
    ...(remote ? { remote } : {})
  }
}

async function reconcileRuntimeWorktreeBaseStatus(
  worktree: Worktree,
  runtimeWorktree: PebbleRuntimeWorktree
): Promise<void> {
  const base = runtimeWorktree.base?.trim()
  const createdBaseSha = runtimeWorktree.createdBaseSha?.trim()
  if (!base || !createdBaseSha) {
    return
  }
  const result = await requestRuntimeJson<RuntimeGitBaseStatusResult>(
    '/v1/source-control/base-status',
    {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        projectId: worktree.repoId,
        worktreeId: worktree.id,
        baseRef: base,
        createdBaseSha,
        branchName: worktree.branch
      }
    }
  )
  emitRuntimeWorktreeBaseStatus({
    repoId: worktree.repoId,
    worktreeId: worktree.id,
    status: result.status,
    base: result.base || base,
    ...(result.remote ? { remote: result.remote } : {}),
    ...(typeof result.behind === 'number' ? { behind: result.behind } : {}),
    ...(result.recentSubjects?.length ? { recentSubjects: result.recentSubjects } : {})
  })
  if (result.conflict) {
    emitRuntimeWorktreeRemoteBranchConflict({
      repoId: worktree.repoId,
      worktreeId: worktree.id,
      remote: result.conflict.remote,
      branchName: result.conflict.branchName
    })
  }
}

async function prefetchRuntimeWorktreeCreateBase(args: {
  repoId: string
  baseBranch?: string
}): Promise<void> {
  const repo = (await readRepos()).find((entry) => entry.id === args.repoId)
  if (!repo || repo.kind === 'folder' || repo.connectionId) {
    return
  }
  const remoteBranch = parseRemoteTrackingBase(args.baseBranch)
  try {
    await requestRuntimeJson('/v1/source-control/mutate', {
      method: 'POST',
      timeoutMs: 10_000,
      body: {
        projectId: repo.id,
        operation: 'fetch',
        remoteName: remoteBranch?.remote ?? '',
        branchName: remoteBranch?.branch ?? ''
      }
    })
  } catch {
    // Why: this is an optimistic warm-up. The actual worktree create path still
    // performs its own fetch and reports user-visible failures there.
  }
}

function parseRemoteTrackingBase(
  baseBranch: string | undefined
): { remote: string; branch: string } | null {
  const normalized = baseBranch?.trim().replace(/^refs\/remotes\//, '')
  if (!normalized || normalized.startsWith('refs/') || normalized.includes('..')) {
    return null
  }
  const slashIndex = normalized.indexOf('/')
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
    return null
  }
  return {
    remote: normalized.slice(0, slashIndex),
    branch: normalized.slice(slashIndex + 1)
  }
}

function subscribeRepoChanged(callback: RepoChangedListener): () => void {
  repoChangedListeners.add(callback)
  ensureProjectEventPump()
  return () => {
    repoChangedListeners.delete(callback)
  }
}

function subscribeWorktreeChanged(callback: WorktreeChangedListener): () => void {
  worktreeChangedListeners.add(callback)
  ensureWorktreeEventPump()
  return () => {
    worktreeChangedListeners.delete(callback)
  }
}

function subscribeWorktreeCreateProgress(callback: WorktreeCreateProgressListener): () => void {
  worktreeCreateProgressListeners.add(callback)
  return () => {
    worktreeCreateProgressListeners.delete(callback)
  }
}

function emitWorktreeCreateProgress(
  creationId: string | undefined,
  phase: 'fetching' | 'creating'
): void {
  if (worktreeCreateProgressListeners.size === 0) {
    return
  }
  const event = creationId ? { creationId, phase } : { phase }
  for (const listener of worktreeCreateProgressListeners) {
    listener(event)
  }
}

function ensureProjectEventPump(): void {
  if (projectEventPumpStarted) {
    return
  }
  projectEventPumpStarted = true
  void pumpProjectEvents()
}

function ensureWorktreeEventPump(): void {
  if (worktreeEventPumpStarted) {
    return
  }
  worktreeEventPumpStarted = true
  void pumpWorktreeEvents()
}

async function pumpProjectEvents(): Promise<void> {
  for (;;) {
    const events = await readRuntimeEvents('project.changed')
    if (events.length === 0) {
      await delay(1000)
    }
    for (const entry of events) {
      if (isRuntimeTopic(entry, 'project.changed')) {
        emitTo(repoChangedListeners)
      }
    }
  }
}

async function pumpWorktreeEvents(): Promise<void> {
  for (;;) {
    const events = await readRuntimeEvents('worktree.changed')
    if (events.length === 0) {
      await delay(1000)
    }
    for (const entry of events) {
      const repoId = readRuntimeWorktreeEventRepoId(entry)
      if (repoId) {
        emitTo(worktreeChangedListeners, { repoId })
      }
    }
  }
}

async function readRuntimeEvents(topic: string): Promise<RuntimeEventStreamEntry[]> {
  const result = await readRuntimeEventStream(
    // Why: Tauri invokes still cross the macOS WebKit IPC path; short polling
    // keeps event pumps responsive even when the runtime has no new events.
    createRuntimeEventStreamCommand({ topic, limit: 20 })
  ).catch(() => null)
  return result?.transport === 'connected' ? result.events : []
}

function isRuntimeTopic(entry: RuntimeEventStreamEntry, topic: string): boolean {
  const event = parseRuntimeEvent(entry)
  return entry.topic === topic || event?.topic === topic
}

function readRuntimeWorktreeEventRepoId(entry: RuntimeEventStreamEntry): string | null {
  if (!isRuntimeTopic(entry, 'worktree.changed')) {
    return null
  }
  const event = parseRuntimeEvent(entry)
  const payload = readObject(event?.payload)
  const deleted = readObject(payload.deleted)
  const value = Object.keys(deleted).length > 0 ? deleted : payload
  return readString(value.projectId) ?? readString(value.repoId) ?? null
}

function parseRuntimeEvent(entry: RuntimeEventStreamEntry): RuntimeEvent | null {
  try {
    return JSON.parse(entry.data) as RuntimeEvent
  } catch {
    return null
  }
}

function emitTo<Callback extends (...args: never[]) => void>(
  listeners: Set<Callback>,
  ...args: Parameters<Callback>
): void {
  for (const listener of listeners) {
    listener(...args)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
