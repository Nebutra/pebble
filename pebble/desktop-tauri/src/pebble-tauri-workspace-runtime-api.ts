import type { PreloadApi } from '../../../src/preload/api-types'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  DetectedWorktreeListResult,
  Project,
  RemoveWorktreeResult,
  Repo,
  Worktree,
  WorktreeMeta
} from '../../../src/shared/types'
import { MANAGED_WORKTREE_OWNERSHIP } from '../../../src/shared/worktree-ownership'
import { pickNativeDirectories, pickNativeDirectory } from './native-dialog-bridge'
import {
  ensurePebbleRuntimeProcess,
  getErrorMessage,
  readPebbleStatusOrNull,
  requestRuntimeJson
} from './pebble-tauri-runtime-transport'
import {
  applyWorktreeMeta,
  joinRuntimePath,
  mapRuntimeProjectToRepo,
  mapRuntimeWorktreeToWorktree,
  pathBasename,
  readObject,
  readString,
  type PebbleRuntimeProject,
  type PebbleRuntimeWorktree
} from './pebble-tauri-workspace-runtime-records'
import {
  getTauriBaseRefDefault,
  searchTauriBaseRefDetails,
  searchTauriBaseRefs
} from './tauri-git-base-ref-api'

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
    getBaseRefDefault: ({ repoId }) => getTauriBaseRefDefault(readRepos(), repoId),
    searchBaseRefs: (args) => searchTauriBaseRefs(readRepos(), args),
    searchBaseRefDetails: (args) => searchTauriBaseRefDetails(readRepos(), args),
    onChanged: () => noopUnsubscribe
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

export async function readRepos(): Promise<Repo[]> {
  await ensurePebbleRuntimeProcess()
  const projects = await requestRuntimeJson<PebbleRuntimeProject[]>('/v1/projects', {
    method: 'GET'
  }).catch(() => [])
  return projects.map((project) => mapRuntimeProjectToRepo(project))
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

export async function createRuntimeWorktree(args: CreateWorktreeArgs): Promise<Worktree> {
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

export async function setRuntimeWorktreeMeta(params: unknown): Promise<Worktree> {
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

export async function removeRuntimeWorktree(params: unknown): Promise<void> {
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

export function toCreateWorktreeArgs(params: unknown): CreateWorktreeArgs {
  const payload = readObject(params)
  return {
    repoId: readString(payload.repoId) ?? readString(payload.projectId) ?? '',
    name: readString(payload.name) ?? readString(payload.branch) ?? 'workspace',
    displayName: readString(payload.displayName),
    baseBranch: readString(payload.baseBranch) ?? readString(payload.base),
    branchNameOverride: readString(payload.branchNameOverride) ?? readString(payload.branch)
  }
}

export function getRuntimeRepoId(params: unknown): string | undefined {
  const payload = readObject(params)
  return readString(payload.repoId) ?? readString(payload.projectId)
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

function noopUnsubscribe(): void {}
