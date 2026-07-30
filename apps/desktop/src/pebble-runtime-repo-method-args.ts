import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { getRuntimeRepoId } from './pebble-tauri-workspace-runtime-api'
import {
  readRuntimeObject,
  readRuntimeRequiredString,
  readRuntimeString
} from './pebble-runtime-param-coercion'

export function toRepoAddArgs(params: unknown): Parameters<PreloadApi['repos']['add']>[0] {
  const input = readRuntimeObject(params)
  return {
    path: readRuntimeRequiredString(input.path, 'repo path'),
    kind: readRuntimeString(input.kind) === 'folder' ? 'folder' : 'git'
  }
}

export function toRepoCreateArgs(params: unknown): Parameters<PreloadApi['repos']['create']>[0] {
  const input = readRuntimeObject(params)
  return {
    parentPath: readRuntimeRequiredString(input.parentPath, 'parent path'),
    name: readRuntimeRequiredString(input.name, 'repo name'),
    kind: readRuntimeString(input.kind) === 'folder' ? 'folder' : 'git'
  }
}

export function toRepoCloneArgs(params: unknown): Parameters<PreloadApi['repos']['clone']>[0] {
  const input = readRuntimeObject(params)
  return {
    url: readRuntimeRequiredString(input.url, 'clone url'),
    destination: readRuntimeRequiredString(input.destination, 'clone destination')
  }
}

export function toRepoUpdateArgs(params: unknown): Parameters<PreloadApi['repos']['update']>[0] {
  const input = readRuntimeObject(params)
  return {
    repoId: requireRepoId(params),
    updates: readRuntimeObject(input.updates)
  }
}

export function requireRepoId(params: unknown): string {
  const repoId = getRuntimeRepoId(params)
  if (!repoId) {
    throw new Error('Missing repo id')
  }
  return repoId
}

export function toConnectionParams(params: unknown): { connectionId: string } {
  const connectionId =
    typeof params === 'object' && params !== null && 'connectionId' in params
      ? String(params.connectionId)
      : ''
  return { connectionId }
}

export function toOrderedIds(params: unknown): string[] {
  if (typeof params !== 'object' || params === null) {
    return []
  }
  const orderedIds = (params as Record<string, unknown>).orderedIds
  return Array.isArray(orderedIds)
    ? orderedIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
}
