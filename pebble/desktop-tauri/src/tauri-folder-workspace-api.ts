import type { PreloadApi } from '../../../src/preload/api-types'
import type {
  FolderWorkspace,
  NestedRepoScanResult,
  ProjectGroup,
  ProjectGroupImportResult
} from '../../../src/shared/types'
import { normalizeFolderWorkspaceLinkedTask } from '../../../src/shared/folder-workspaces'
import { isTuiAgent } from '../../../src/shared/tui-agent-config'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { mapRuntimeProjectToRepo, type PebbleRuntimeProject } from './pebble-tauri-workspace-runtime-records'

type DeleteResult = {
  deleted: boolean
}
type ProjectGroupCreateArgs = Parameters<PreloadApi['projectGroups']['create']>[0]
type ProjectGroupUpdateArgs = Parameters<PreloadApi['projectGroups']['update']>[0]['updates']
type ProjectGroupScanNestedArgs = Parameters<PreloadApi['projectGroups']['scanNested']>[0]
type ProjectGroupImportNestedArgs = Parameters<PreloadApi['projectGroups']['importNested']>[0]
type NestedScanProgressListener = Parameters<
  PreloadApi['projectGroups']['onNestedScanProgress']
>[0]
type FolderWorkspaceCreateArgs = Parameters<PreloadApi['folderWorkspaces']['create']>[0]
type FolderWorkspaceUpdateArgs = Parameters<PreloadApi['folderWorkspaces']['update']>[0]['updates']
type FolderWorkspacePathStatusArgs = Parameters<PreloadApi['folderWorkspaces']['getPathStatus']>[0]

type ActiveNestedScan = {
  canceled: boolean
}

const nestedScanProgressListeners = new Set<NestedScanProgressListener>()
const activeNestedScans = new Map<string, ActiveNestedScan>()

export function createPebbleProjectGroupsApi(
  base: PreloadApi['projectGroups']
): PreloadApi['projectGroups'] {
  return {
    ...base,
    list: readRuntimeProjectGroups,
    create: (args) =>
      requestRuntimeJson<ProjectGroup>('/v1/project-groups', {
        method: 'POST',
        body: args
      }),
    update: ({ groupId, updates }) =>
      requestRuntimeJson<ProjectGroup | null>(`/v1/project-groups/${encodeURIComponent(groupId)}`, {
        method: 'PATCH',
        body: updates
      }),
    delete: async ({ groupId }) => {
      const result = await requestRuntimeJson<DeleteResult>(
        `/v1/project-groups/${encodeURIComponent(groupId)}`,
        { method: 'DELETE' }
      )
      return result.deleted
    },
    moveProject: async ({ projectId, groupId, order }) => {
      const project = await requestRuntimeJson<PebbleRuntimeProject>(
        '/v1/project-groups/move-project',
        {
          method: 'POST',
          body: { projectId, groupId, order }
        }
      )
      return mapRuntimeProjectToRepo(project)
    },
    scanNested: (args) => scanRuntimeNestedRepos(args),
    cancelNestedScan: ({ scanId }) => cancelRuntimeNestedScan(scanId),
    onNestedScanProgress: (callback) => subscribeNestedScanProgress(callback),
    importNested: (args) => importRuntimeNestedRepos(args)
  }
}

export function createPebbleFolderWorkspacesApi(
  base: PreloadApi['folderWorkspaces']
): PreloadApi['folderWorkspaces'] {
  return {
    ...base,
    list: readRuntimeFolderWorkspaces,
    getPathStatus: (args) =>
      requestRuntimeJson('/v1/folder-workspaces/path-status', {
        method: 'POST',
        body: args
      }),
    create: (args) =>
      requestRuntimeJson<FolderWorkspace>('/v1/folder-workspaces', {
        method: 'POST',
        body: args
      }),
    update: ({ folderWorkspaceId, updates }) =>
      requestRuntimeJson<FolderWorkspace | null>(
        `/v1/folder-workspaces/${encodeURIComponent(folderWorkspaceId)}`,
        {
          method: 'PATCH',
          body: { updates }
        }
      ),
    delete: async ({ folderWorkspaceId }) => {
      const result = await requestRuntimeJson<DeleteResult>(
        `/v1/folder-workspaces/${encodeURIComponent(folderWorkspaceId)}`,
        { method: 'DELETE' }
      )
      return result.deleted
    }
  }
}

export function readRuntimeProjectGroups(): Promise<ProjectGroup[]> {
  return requestRuntimeJson<ProjectGroup[]>('/v1/project-groups', { method: 'GET' })
}

export function readRuntimeFolderWorkspaces(): Promise<FolderWorkspace[]> {
  return requestRuntimeJson<FolderWorkspace[]>('/v1/folder-workspaces', { method: 'GET' })
}

export async function callTauriProjectGroupRuntimeRpc(
  method: string,
  params: unknown
): Promise<{ handled: boolean; result?: unknown }> {
  switch (method) {
    case 'projectGroup.list':
      return handled({ groups: await window.api.projectGroups.list() })
    case 'projectGroup.create':
      return handled({
        group: await window.api.projectGroups.create(toProjectGroupCreateArgs(params))
      })
    case 'projectGroup.update': {
      const input = readObject(params)
      return handled({
        group: await window.api.projectGroups.update({
          groupId: readRequiredString(input.groupId, 'project group id'),
          updates: readObject(input.updates) as ProjectGroupUpdateArgs
        })
      })
    }
    case 'projectGroup.delete':
      return handled(
        await window.api.projectGroups.delete({
          groupId: readRequiredString(readObject(params).groupId, 'project group id')
        })
      )
    case 'projectGroup.moveProject': {
      const input = readObject(params)
      const repo = await window.api.projectGroups.moveProject({
        projectId: readRequiredString(input.repo ?? input.projectId, 'project id'),
        groupId: readNullableString(input.groupId),
        order: readNumber(input.order)
      })
      return handled({ repo })
    }
    case 'projectGroup.scanNested':
      return handled(await window.api.projectGroups.scanNested(toProjectGroupScanNestedArgs(params)))
    case 'projectGroup.importNested':
      return handled(await window.api.projectGroups.importNested(toProjectGroupImportNestedArgs(params)))
    default:
      return { handled: false }
  }
}

export async function callTauriFolderWorkspaceRuntimeRpc(
  method: string,
  params: unknown
): Promise<{ handled: boolean; result?: unknown }> {
  switch (method) {
    case 'folderWorkspace.list':
      return handled({ folderWorkspaces: await window.api.folderWorkspaces.list() })
    case 'folderWorkspace.create':
      return handled({
        folderWorkspace: await window.api.folderWorkspaces.create(
          toFolderWorkspaceCreateArgs(params)
        )
      })
    case 'folderWorkspace.update': {
      const input = readObject(params)
      return handled({
        folderWorkspace: await window.api.folderWorkspaces.update({
          folderWorkspaceId: readRequiredString(input.folderWorkspaceId, 'folder workspace id'),
          updates: readObject(input.updates) as FolderWorkspaceUpdateArgs
        })
      })
    }
    case 'folderWorkspace.delete':
      return handled({
        deleted: await window.api.folderWorkspaces.delete({
          folderWorkspaceId: readRequiredString(
            readObject(params).folderWorkspaceId,
            'folder workspace id'
          )
        })
      })
    case 'folderWorkspace.getPathStatus':
      return handled({
        status: await window.api.folderWorkspaces.getPathStatus(
          toFolderWorkspacePathStatusArgs(params)
        )
      })
    default:
      return { handled: false }
  }
}

function handled(result: unknown): { handled: true; result: unknown } {
  return { handled: true, result }
}

function readRuntimeNestedRepos(args: ProjectGroupScanNestedArgs): Promise<NestedRepoScanResult> {
  const params = {
    path: args.path,
    options: readObjectOrUndefined(args.options)
  }
  if (args.connectionId) {
    return callRemoteRuntimeResult<NestedRepoScanResult>(
      args.connectionId,
      'projectGroup.scanNested',
      params
    )
  }
  return requestRuntimeJson<NestedRepoScanResult>('/v1/project-groups/scan-nested', {
    method: 'POST',
    body: params,
    timeoutMs: 20_000
  })
}

async function scanRuntimeNestedRepos(
  args: ProjectGroupScanNestedArgs
): Promise<NestedRepoScanResult> {
  const scanId = readOptionalString(args.scanId)
  const activeScan = scanId ? startNestedScan(scanId) : null
  try {
    const scan = await readRuntimeNestedRepos(args)
    const result = activeScan?.canceled ? toStoppedNestedScan(scan) : scan
    if (scanId) {
      emitNestedScanProgress(scanId, result)
    }
    return result
  } finally {
    if (scanId && activeNestedScans.get(scanId) === activeScan) {
      activeNestedScans.delete(scanId)
    }
  }
}

function startNestedScan(scanId: string): ActiveNestedScan {
  const previous = activeNestedScans.get(scanId)
  if (previous) {
    previous.canceled = true
  }
  const activeScan: ActiveNestedScan = { canceled: false }
  activeNestedScans.set(scanId, activeScan)
  return activeScan
}

function cancelRuntimeNestedScan(scanId: string): Promise<boolean> {
  const activeScan = activeNestedScans.get(scanId)
  if (!activeScan) {
    return Promise.resolve(false)
  }
  activeScan.canceled = true
  return Promise.resolve(true)
}

function subscribeNestedScanProgress(callback: NestedScanProgressListener): () => void {
  nestedScanProgressListeners.add(callback)
  return () => {
    nestedScanProgressListeners.delete(callback)
  }
}

function emitNestedScanProgress(scanId: string, scan: NestedRepoScanResult): void {
  for (const listener of nestedScanProgressListeners) {
    listener({ scanId, scan })
  }
}

function toStoppedNestedScan(scan: NestedRepoScanResult): NestedRepoScanResult {
  return {
    ...scan,
    repos: [],
    stopped: true
  }
}

function importRuntimeNestedRepos(
  args: ProjectGroupImportNestedArgs
): Promise<ProjectGroupImportResult> {
  const body = {
    parentPath: args.parentPath,
    groupName: args.groupName,
    projectPaths: args.projectPaths,
    mode: args.mode
  }
  if (args.connectionId) {
    return callRemoteRuntimeResult<ProjectGroupImportResult>(
      args.connectionId,
      'projectGroup.importNested',
      body
    )
  }
  return requestRuntimeJson<ProjectGroupImportResult>('/v1/project-groups/import-nested', {
    method: 'POST',
    body,
    timeoutMs: 30_000
  })
}

async function callRemoteRuntimeResult<TResult>(
  selector: string,
  method: string,
  params: unknown
): Promise<TResult> {
  const response = await window.api.runtimeEnvironments.call({
    selector,
    method,
    params,
    timeoutMs: 30_000
  })
  if (!response.ok) {
    throw new Error(response.error.message || response.error.code)
  }
  return response.result as TResult
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function toProjectGroupScanNestedArgs(params: unknown): ProjectGroupScanNestedArgs {
  const input = readObject(params)
  return {
    path: readRequiredString(input.path, 'folder path'),
    ...(hasOwn(input, 'connectionId') ? { connectionId: readOptionalString(input.connectionId) } : {}),
    ...(hasOwn(input, 'scanId') ? { scanId: readOptionalString(input.scanId) } : {}),
    ...(hasOwn(input, 'options') ? { options: readObjectOrUndefined(input.options) } : {})
  }
}

function toProjectGroupImportNestedArgs(params: unknown): ProjectGroupImportNestedArgs {
  const input = readObject(params)
  const mode = input.mode === 'separate' ? 'separate' : 'group'
  return {
    parentPath: readRequiredString(input.parentPath, 'parent folder path'),
    groupName: readOptionalString(input.groupName) ?? '',
    projectPaths: readStringArray(input.projectPaths),
    mode,
    ...(hasOwn(input, 'connectionId') ? { connectionId: readOptionalString(input.connectionId) } : {}),
    ...(hasOwn(input, 'scanId') ? { scanId: readOptionalString(input.scanId) } : {})
  }
}

function toProjectGroupCreateArgs(params: unknown): ProjectGroupCreateArgs {
  const input = readObject(params)
  const createdFrom = readProjectGroupCreatedFrom(input.createdFrom)
  return {
    name: readRequiredString(input.name, 'project group name'),
    ...(hasOwn(input, 'parentPath') ? { parentPath: readNullableString(input.parentPath) } : {}),
    ...(hasOwn(input, 'connectionId') ? { connectionId: readNullableString(input.connectionId) } : {}),
    ...(hasOwn(input, 'parentGroupId') ? { parentGroupId: readNullableString(input.parentGroupId) } : {}),
    ...(createdFrom ? { createdFrom } : {})
  }
}

function toFolderWorkspaceCreateArgs(params: unknown): FolderWorkspaceCreateArgs {
  const input = readObject(params)
  const name = readOptionalString(input.name)
  const linkedTask = normalizeFolderWorkspaceLinkedTask(input.linkedTask)
  return {
    projectGroupId: readRequiredString(input.projectGroupId, 'project group id'),
    ...(name ? { name } : {}),
    ...(hasOwn(input, 'folderPath') ? { folderPath: readNullableString(input.folderPath) } : {}),
    ...(hasOwn(input, 'connectionId') ? { connectionId: readNullableString(input.connectionId) } : {}),
    ...(hasOwn(input, 'linkedTask') ? { linkedTask } : {}),
    ...(isTuiAgent(input.createdWithAgent) ? { createdWithAgent: input.createdWithAgent } : {}),
    ...(typeof input.pendingFirstAgentMessageRename === 'boolean'
      ? { pendingFirstAgentMessageRename: input.pendingFirstAgentMessageRename }
      : {})
  }
}

function toFolderWorkspacePathStatusArgs(params: unknown): FolderWorkspacePathStatusArgs {
  const input = readObject(params)
  const scope = readRequiredString(input.scope, 'folder workspace path status scope')
  if (scope === 'folder-workspace') {
    return {
      scope,
      folderWorkspaceId: readRequiredString(input.folderWorkspaceId, 'folder workspace id')
    }
  }
  if (scope === 'project-group') {
    return {
      scope,
      projectGroupId: readRequiredString(input.projectGroupId, 'project group id')
    }
  }
  if (scope === 'path') {
    return {
      scope,
      path: readRequiredString(input.path, 'folder path'),
      ...(hasOwn(input, 'connectionId') ? { connectionId: readNullableString(input.connectionId) } : {})
    }
  }
  throw new Error(`Unsupported folder workspace path status scope: ${scope}`)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  throw new Error(`Missing ${label}`)
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function readProjectGroupCreatedFrom(value: unknown): ProjectGroup['createdFrom'] | undefined {
  return value === 'manual' || value === 'folder-scan' || value === 'migration' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
