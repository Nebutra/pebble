import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { ProjectGroup } from '../../../packages/product-core/shared/types'
import { normalizeFolderWorkspaceLinkedTask } from '../../../packages/product-core/shared/folder-workspaces'
import { isTuiAgent } from '../../../packages/product-core/shared/tui-agent-config'

export type ProjectGroupCreateArgs = Parameters<PreloadApi['projectGroups']['create']>[0]
export type ProjectGroupScanNestedArgs = Parameters<PreloadApi['projectGroups']['scanNested']>[0]
export type ProjectGroupImportNestedArgs = Parameters<
  PreloadApi['projectGroups']['importNested']
>[0]
export type FolderWorkspaceCreateArgs = Parameters<PreloadApi['folderWorkspaces']['create']>[0]
export type FolderWorkspacePathStatusArgs = Parameters<
  PreloadApi['folderWorkspaces']['getPathStatus']
>[0]

export function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function readObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

export function toProjectGroupScanNestedArgs(params: unknown): ProjectGroupScanNestedArgs {
  const input = readObject(params)
  return {
    path: readRequiredString(input.path, 'folder path'),
    ...(hasOwn(input, 'connectionId')
      ? { connectionId: readOptionalString(input.connectionId) }
      : {}),
    ...(hasOwn(input, 'scanId') ? { scanId: readOptionalString(input.scanId) } : {}),
    ...(hasOwn(input, 'options') ? { options: readObjectOrUndefined(input.options) } : {})
  }
}

export function toProjectGroupImportNestedArgs(params: unknown): ProjectGroupImportNestedArgs {
  const input = readObject(params)
  const mode = input.mode === 'separate' ? 'separate' : 'group'
  return {
    parentPath: readRequiredString(input.parentPath, 'parent folder path'),
    groupName: readOptionalString(input.groupName) ?? '',
    projectPaths: readStringArray(input.projectPaths),
    mode,
    ...(hasOwn(input, 'connectionId')
      ? { connectionId: readOptionalString(input.connectionId) }
      : {}),
    ...(hasOwn(input, 'scanId') ? { scanId: readOptionalString(input.scanId) } : {})
  }
}

export function toProjectGroupCreateArgs(params: unknown): ProjectGroupCreateArgs {
  const input = readObject(params)
  const createdFrom = readProjectGroupCreatedFrom(input.createdFrom)
  return {
    name: readRequiredString(input.name, 'project group name'),
    ...(hasOwn(input, 'parentPath') ? { parentPath: readNullableString(input.parentPath) } : {}),
    ...(hasOwn(input, 'connectionId')
      ? { connectionId: readNullableString(input.connectionId) }
      : {}),
    ...(hasOwn(input, 'parentGroupId')
      ? { parentGroupId: readNullableString(input.parentGroupId) }
      : {}),
    ...(createdFrom ? { createdFrom } : {})
  }
}

export function toFolderWorkspaceCreateArgs(params: unknown): FolderWorkspaceCreateArgs {
  const input = readObject(params)
  const name = readOptionalString(input.name)
  const linkedTask = normalizeFolderWorkspaceLinkedTask(input.linkedTask)
  return {
    projectGroupId: readRequiredString(input.projectGroupId, 'project group id'),
    ...(name ? { name } : {}),
    ...(hasOwn(input, 'folderPath') ? { folderPath: readNullableString(input.folderPath) } : {}),
    ...(hasOwn(input, 'connectionId')
      ? { connectionId: readNullableString(input.connectionId) }
      : {}),
    ...(hasOwn(input, 'linkedTask') ? { linkedTask } : {}),
    ...(isTuiAgent(input.createdWithAgent) ? { createdWithAgent: input.createdWithAgent } : {}),
    ...(typeof input.pendingFirstAgentMessageRename === 'boolean'
      ? { pendingFirstAgentMessageRename: input.pendingFirstAgentMessageRename }
      : {})
  }
}

export function toFolderWorkspacePathStatusArgs(params: unknown): FolderWorkspacePathStatusArgs {
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
      ...(hasOwn(input, 'connectionId')
        ? { connectionId: readNullableString(input.connectionId) }
        : {})
    }
  }
  throw new Error(`Unsupported folder workspace path status scope: ${scope}`)
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

export function readRequiredString(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  throw new Error(`Missing ${label}`)
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

export function readProjectGroupCreatedFrom(value: unknown): ProjectGroup['createdFrom'] | undefined {
  return value === 'manual' || value === 'folder-scan' || value === 'migration' ? value : undefined
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
