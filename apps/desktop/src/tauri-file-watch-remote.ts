import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { RuntimeRpcResponse } from '../../../packages/product-core/shared/runtime-rpc-envelope'
import type { FsChangedPayload } from '../../../packages/product-core/shared/types'
import { normalizeRuntimePathForComparison } from '../../../packages/product-core/shared/cross-platform-path'
import { dispatchFsChangedPayload } from './tauri-file-watch-fs-changed'
import {
  diffFileWatchSnapshots,
  type FileWatchSnapshotEntry,
  readLegacySshSnapshot
} from './tauri-file-watch-legacy-ssh-snapshot'

const LEGACY_SSH_WATCH_INTERVAL_MS = 2_000

const remoteWatchStates = new Map<string, RemoteWatchState>()

type RuntimeFileWatchEvent =
  | { type: 'ready'; subscriptionId: string }
  | { type: 'changed'; worktree: string; events: FsChangedPayload['events'] }
  | { type: 'end' }

type RuntimeEnvironmentSubscriptionHandle = Awaited<
  ReturnType<PreloadApi['runtimeEnvironments']['subscribe']>
>

type RemoteWatchState = {
  key: string
  count: number
  connectionId: string
  worktreePath: string
  start: Promise<void>
  unsubscribe: (() => void) | null
  remoteSubscriptionId: string | null
  pollTimer: ReturnType<typeof setTimeout> | null
  pollInFlight: boolean
  snapshot: Map<string, FileWatchSnapshotEntry> | null
  closed: boolean
}

// Remote (SSH) worktree watching, split out of tauri-file-watch-api.ts. Uses the
// runtime files.watch subscription when available and falls back to a snapshot
// diff poll for legacy SSH hosts.
export async function watchRemoteWorktree(args: {
  worktreePath: string
  connectionId?: string
}): Promise<void> {
  const connectionId = args.connectionId?.trim()
  if (!connectionId) {
    return
  }
  const key = getRemoteWatchKey(connectionId, args.worktreePath)
  const existing = remoteWatchStates.get(key)
  if (existing) {
    existing.count += 1
    await existing.start
    return
  }

  const state: RemoteWatchState = {
    key,
    count: 1,
    connectionId,
    worktreePath: args.worktreePath,
    start: Promise.resolve(),
    unsubscribe: null,
    remoteSubscriptionId: null,
    pollTimer: null,
    pollInFlight: false,
    snapshot: null,
    closed: false
  }
  remoteWatchStates.set(key, state)
  state.start = startRemoteWorktreeWatch(state).catch((error) => {
    if (remoteWatchStates.get(key) === state) {
      remoteWatchStates.delete(key)
    }
    state.closed = true
    throw error
  })
  await state.start
}

export function unwatchRemoteWorktree(args: {
  worktreePath: string
  connectionId?: string
}): void {
  const connectionId = args.connectionId?.trim()
  if (!connectionId) {
    return
  }
  const key = getRemoteWatchKey(connectionId, args.worktreePath)
  const state = remoteWatchStates.get(key)
  if (!state) {
    return
  }
  if (state.count > 1) {
    state.count -= 1
    return
  }
  closeRemoteWorktreeWatch(state)
}

async function startRemoteWorktreeWatch(state: RemoteWatchState): Promise<void> {
  const worktree = await resolveRemoteWatchWorktree(state.connectionId, state.worktreePath)
  try {
    const handle = await window.api.runtimeEnvironments.subscribe(
      {
        selector: state.connectionId,
        method: 'files.watch',
        params: { worktree: toRuntimeWorktreeSelector(worktree.id) },
        timeoutMs: 15_000
      },
      {
        onResponse: (response) => handleRemoteWatchResponse(state, response),
        onError: (error) => {
          console.warn('[tauri-file-watch] remote watcher error', {
            connectionId: state.connectionId,
            worktreePath: state.worktreePath,
            error: error.message
          })
        },
        onClose: () => {
          if (remoteWatchStates.get(state.key) === state) {
            remoteWatchStates.delete(state.key)
          }
          state.closed = true
          state.unsubscribe = null
        }
      }
    )
    bindRemoteWatchHandle(state, handle)
  } catch {
    await startLegacySshWatch(state, worktree.repoId, worktree.id)
  }
}

async function startLegacySshWatch(
  state: RemoteWatchState,
  projectId: string,
  worktreeId: string
): Promise<void> {
  state.snapshot = await readLegacySshSnapshot(projectId, worktreeId)
  const poll = async (): Promise<void> => {
    if (state.closed || state.pollInFlight) {
      return
    }
    state.pollInFlight = true
    try {
      const next = await readLegacySshSnapshot(projectId, worktreeId)
      const events = diffFileWatchSnapshots(state.worktreePath, state.snapshot ?? new Map(), next)
      state.snapshot = next
      if (events.length > 0) {
        dispatchFsChangedPayload({ worktreePath: state.worktreePath, events })
      }
    } catch (error) {
      console.warn('[tauri-file-watch] legacy SSH watcher poll failed', {
        connectionId: state.connectionId,
        worktreePath: state.worktreePath,
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      state.pollInFlight = false
      if (!state.closed) {
        state.pollTimer = globalThis.setTimeout(poll, LEGACY_SSH_WATCH_INTERVAL_MS)
      }
    }
  }
  state.pollTimer = globalThis.setTimeout(poll, LEGACY_SSH_WATCH_INTERVAL_MS)
}

function bindRemoteWatchHandle(
  state: RemoteWatchState,
  handle: RuntimeEnvironmentSubscriptionHandle
): void {
  state.unsubscribe = handle.unsubscribe
  if (!state.closed && remoteWatchStates.get(state.key) === state) {
    return
  }
  handle.unsubscribe()
  state.unsubscribe = null
  unwatchRemoteRuntimeFileWatch(state)
}

async function resolveRemoteWatchWorktree(connectionId: string, worktreePath: string) {
  const [repos, worktrees] = await Promise.all([
    window.api.repos.list(),
    window.api.worktrees.listAll()
  ])
  const normalizedPath = normalizeRuntimePathForComparison(worktreePath)
  const worktree = worktrees.find((candidate) => {
    if (normalizeRuntimePathForComparison(candidate.path) !== normalizedPath) {
      return false
    }
    const repo = repos.find((entry) => entry.id === candidate.repoId)
    return repo?.connectionId === connectionId
  })
  if (!worktree) {
    throw new Error(`Remote worktree not found for ${worktreePath}`)
  }
  return worktree
}

function handleRemoteWatchResponse(
  state: RemoteWatchState,
  response: RuntimeRpcResponse<unknown>
): void {
  let event: RuntimeFileWatchEvent
  try {
    event = unwrapRemoteWatchEvent(response)
  } catch (error) {
    console.warn('[tauri-file-watch] invalid remote watcher event', {
      connectionId: state.connectionId,
      worktreePath: state.worktreePath,
      error: error instanceof Error ? error.message : String(error)
    })
    return
  }
  if (event.type === 'ready') {
    state.remoteSubscriptionId = event.subscriptionId
    if (state.closed) {
      unwatchRemoteRuntimeFileWatch(state)
    }
    return
  }
  if (event.type !== 'changed') {
    return
  }
  dispatchFsChangedPayload({
    worktreePath: state.worktreePath,
    events: event.events
  })
}

function unwrapRemoteWatchEvent(response: RuntimeRpcResponse<unknown>): RuntimeFileWatchEvent {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const event = response.result
  if (!isRemoteWatchEvent(event)) {
    throw new Error('Invalid remote file watch event')
  }
  return event
}

function isRemoteWatchEvent(value: unknown): value is RuntimeFileWatchEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false
  }
  const type = value.type
  if (type === 'end') {
    return true
  }
  if (type === 'ready') {
    return typeof (value as { subscriptionId?: unknown }).subscriptionId === 'string'
  }
  return type === 'changed' && Array.isArray((value as { events?: unknown }).events)
}

function closeRemoteWorktreeWatch(state: RemoteWatchState): void {
  state.closed = true
  remoteWatchStates.delete(state.key)
  state.unsubscribe?.()
  state.unsubscribe = null
  if (state.pollTimer !== null) {
    globalThis.clearTimeout(state.pollTimer)
    state.pollTimer = null
  }
  unwatchRemoteRuntimeFileWatch(state)
}

function unwatchRemoteRuntimeFileWatch(state: RemoteWatchState): void {
  if (!state.remoteSubscriptionId) {
    return
  }
  void window.api.runtimeEnvironments
    .call({
      selector: state.connectionId,
      method: 'files.unwatch',
      params: { subscriptionId: state.remoteSubscriptionId },
      timeoutMs: 5_000
    })
    .catch(() => {})
}

function getRemoteWatchKey(connectionId: string, worktreePath: string): string {
  return `${connectionId}\0${normalizeRuntimePathForComparison(worktreePath)}`
}
