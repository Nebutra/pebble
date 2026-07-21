import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  FolderWorkspace,
  ProjectGroup
} from '../../../packages/product-core/shared/types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  mapRuntimeProjectToRepo,
  type PebbleRuntimeProject
} from './pebble-tauri-workspace-runtime-records'
import {
  readNullableString,
  readNumber,
  readObject,
  readRequiredString,
  toFolderWorkspaceCreateArgs,
  toFolderWorkspacePathStatusArgs,
  toProjectGroupCreateArgs,
  toProjectGroupImportNestedArgs,
  toProjectGroupScanNestedArgs
} from './tauri-project-group-rpc-arg-readers'
import {
  cancelRuntimeNestedScan,
  importRuntimeNestedRepos,
  scanRuntimeNestedRepos,
  subscribeNestedScanProgress
} from './tauri-nested-repo-scan-runtime'

type DeleteResult = {
  deleted: boolean
}
type ProjectGroupUpdateArgs = Parameters<PreloadApi['projectGroups']['update']>[0]['updates']
type FolderWorkspaceUpdateArgs = Parameters<PreloadApi['folderWorkspaces']['update']>[0]['updates']

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
      return handled(
        await window.api.projectGroups.scanNested(toProjectGroupScanNestedArgs(params))
      )
    case 'projectGroup.importNested':
      return handled(
        await window.api.projectGroups.importNested(toProjectGroupImportNestedArgs(params))
      )
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
