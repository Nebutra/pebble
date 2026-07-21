import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSession
} from '../../../packages/product-core/shared/remote-workspace-types'
import type { WorkspaceSessionState } from '../../../packages/product-core/shared/types'
import { exportRemoteWorkspaceSession } from '../../../packages/product-core/shared/remote-workspace-session-projection'
import { getRepoIdFromWorktreeId } from '../../../packages/product-core/shared/worktree-id'
import {
  clientId,
  ensureWorkspacePush,
  fetchSnapshot,
  listeners,
  rememberSnapshot,
  resetRemoteWorkspaceSnapshotWatch,
  runtimePost,
  snapshots,
  stopWorkspacePush,
  syncTargetWatches,
  updatePollingState
} from './remote-workspace-snapshot-watch'

type RemoteWorkspaceApi = PreloadApi['remoteWorkspace']
const patchTails = new Map<string, Promise<void>>()

export function createPebbleRemoteWorkspaceApi(api: PreloadApi): RemoteWorkspaceApi {
  return {
    get: async ({ targetId }) => {
      if (!(await isConnected(api, targetId))) {
        return null
      }
      const snapshot = await fetchSnapshot(targetId).catch(() => null)
      if (snapshot) {
        rememberSnapshot(targetId, snapshot)
      }
      return snapshot
    },
    setForConnectedTargets: async ({ session, hydratedTargetIds }) => {
      if (!hydratedTargetIds?.length) {
        return []
      }
      const [connected, repos, persistedSession] = await Promise.all([
        connectedTargetIds(api),
        api.repos.list(),
        session ? Promise.resolve(session) : api.session.get()
      ])
      const allowed = new Set(hydratedTargetIds.filter((id) => connected.has(id)))
      const targetByRepoId = new Map(repos.map((repo) => [repo.id, repo.connectionId ?? null]))
      return Promise.all(
        [...allowed].map(async (targetId) => ({
          targetId,
          result: await queueTargetPatch(targetId, () =>
            patchTarget(
              targetId,
              exportSessionForTarget(persistedSession, targetId, targetByRepoId)
            )
          )
        }))
      )
    },
    listEnabledConnectedTargets: async () => [...(await connectedTargetIds(api))],
    listConnectedClients: async (args) => {
      const connected = await connectedTargetIds(api)
      const requested = args?.targetIds ? new Set(args.targetIds) : connected
      const targets = [...requested].filter((id) => connected.has(id))
      return Promise.all(
        targets.map(async (targetId) => {
          try {
            const result = await runtimePost<{
              clients: {
                clientId: string
                name: string
                lastSeenAt: number
              }[]
            }>('/v1/remote-workspace/presence', {
              targetId,
              clientId,
              clientName: 'This device'
            })
            return {
              targetId,
              clients: result.clients.map((client) => ({
                ...client,
                isCurrent: client.clientId === clientId
              }))
            }
          } catch {
            return { targetId, clients: [] }
          }
        })
      )
    },
    clientId: () => Promise.resolve(clientId),
    onChanged: (callback) => {
      listeners.add(callback)
      void ensureWorkspacePush()
      void syncTargetWatches()
      updatePollingState()
      return () => {
        listeners.delete(callback)
        if (listeners.size === 0) {
          void stopWorkspacePush()
        }
        updatePollingState()
      }
    }
  }
}

async function patchTarget(
  targetId: string,
  session: RemoteWorkspaceSession
): Promise<RemoteWorkspacePatchResult> {
  const current = snapshots.get(targetId) ?? (await fetchSnapshot(targetId).catch(() => undefined))
  if (current && sessionsEqual(current.session, session)) {
    return { ok: true, snapshot: current }
  }
  const request = (baseRevision: number): Promise<RemoteWorkspacePatchResult> =>
    runtimePost('/v1/remote-workspace/patch', {
      targetId,
      baseRevision,
      clientId,
      patch: { kind: 'replace-session', session }
    })
  let result = await request(current?.revision ?? 0)
  if (result.snapshot) {
    rememberSnapshot(targetId, result.snapshot)
  }
  if (
    !result.ok &&
    result.reason === 'stale-revision' &&
    current &&
    result.snapshot &&
    result.snapshot.revision < current.revision &&
    !sessionsEqual(result.snapshot.session, session)
  ) {
    result = await request(result.snapshot.revision)
    if (result.snapshot) {
      rememberSnapshot(targetId, result.snapshot)
    }
  }
  return result
}

function exportSessionForTarget(
  session: WorkspaceSessionState,
  targetId: string,
  targetByRepoId: Map<string, string | null>
): RemoteWorkspaceSession {
  return exportRemoteWorkspaceSession(session, {
    isTargetWorktree: (worktreeId) =>
      targetByRepoId.get(getRepoIdFromWorktreeId(worktreeId)) === targetId
  })
}

async function connectedTargetIds(api: PreloadApi): Promise<Set<string>> {
  const targets = await api.ssh.listTargets()
  const states = await Promise.all(
    targets.map(async (target) => ({
      id: target.id,
      state: await api.ssh.getState({ targetId: target.id })
    }))
  )
  return new Set(states.filter(({ state }) => state?.status === 'connected').map(({ id }) => id))
}

async function isConnected(api: PreloadApi, targetId: string): Promise<boolean> {
  return (await api.ssh.getState({ targetId }))?.status === 'connected'
}

async function queueTargetPatch<T>(targetId: string, operation: () => Promise<T>): Promise<T> {
  const previous = patchTails.get(targetId) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.catch(() => undefined).then(() => tail)
  patchTails.set(targetId, queued)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (patchTails.get(targetId) === queued) {
      patchTails.delete(targetId)
    }
  }
}

function sessionsEqual(left: RemoteWorkspaceSession, right: RemoteWorkspaceSession): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)])
  )
}

export async function resetTauriRemoteWorkspaceStateForTests(): Promise<void> {
  await resetRemoteWorkspaceSnapshotWatch()
  patchTails.clear()
}
