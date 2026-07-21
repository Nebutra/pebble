import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../../../packages/product-core/shared/workspace-cleanup'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { readRepos, readWorktrees } from './pebble-tauri-workspace-runtime-api'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'

type WorkspaceCleanupApi = PreloadApi['workspaceCleanup']
type UiApi = PreloadApi['ui']
const progressListeners = new Map<string, (progress: WorkspaceCleanupScanProgress) => void>()
let subscribed = false

export function createPebbleWorkspaceCleanupApi(ui: UiApi): WorkspaceCleanupApi {
  ensureProgressSubscription()
  return {
    scan: async (args = {}, onProgress) => {
      await ensurePebbleRuntimeProcess()
      const scanId = onProgress ? (args.scanId ?? crypto.randomUUID()) : args.scanId
      if (scanId && onProgress) {
        progressListeners.set(scanId, onProgress)
      }
      try {
        const connectionIds = await resolveCleanupConnectionIds(args)
        const [local, ...remote] = await Promise.all([
          requestLocalCleanupScan(args, scanId),
          ...connectionIds.map((connectionId) => requestRemoteCleanupScan(connectionId, args))
        ])
        const result = mergeCleanupScanResults(local, remote)
        if (scanId && onProgress && connectionIds.length > 0) {
          onProgress({
            ...result,
            scanId,
            scannedWorktreeCount: result.candidates.length,
            totalWorktreeCount: result.candidates.length,
            candidateMode: 'snapshot'
          })
        }
        return result
      } finally {
        if (scanId) {
          progressListeners.delete(scanId)
        }
      }
    },
    dismiss: async ({ dismissals }) => {
      const current = await ui.get()
      const next = { ...current.workspaceCleanup?.dismissals }
      for (const dismissal of dismissals) {
        if (dismissal.classifierVersion === 2 && dismissal.worktreeId && dismissal.fingerprint) {
          next[dismissal.worktreeId] = dismissal
        }
      }
      await ui.set({ workspaceCleanup: { dismissals: next } })
    },
    clearDismissals: () => ui.set({ workspaceCleanup: { dismissals: {} } }),
    hasKillableLocalProcesses: async (args) => {
      await ensurePebbleRuntimeProcess()
      const connectionId = args.connectionId?.trim()
      if (connectionId) {
        const response = await window.api.runtimeEnvironments.call({
          selector: connectionId,
          method: 'workspaceCleanup.processes',
          params: {
            worktreeId: args.worktreeId,
            worktreePath: args.worktreePath
          },
          timeoutMs: 15_000
        })
        if (!response.ok) {
          throw new Error(response.error.message || response.error.code)
        }
        return response.result as Awaited<
          ReturnType<WorkspaceCleanupApi['hasKillableLocalProcesses']>
        >
      }
      return requestRuntimeJson('/v1/workspace-cleanup/processes', {
        method: 'POST',
        body: args
      })
    }
  }
}

async function resolveCleanupConnectionIds(args: WorkspaceCleanupScanArgs): Promise<string[]> {
  const repos = await readRepos()
  if (!args.worktreeId) {
    return [...new Set(repos.flatMap((repo) => (repo.connectionId ? [repo.connectionId] : [])))]
  }
  const worktree = (await readWorktrees()).find((entry) => entry.id === args.worktreeId)
  const connectionId = repos.find((repo) => repo.id === worktree?.repoId)?.connectionId?.trim()
  return connectionId ? [connectionId] : []
}

function requestLocalCleanupScan(
  args: WorkspaceCleanupScanArgs,
  scanId?: string
): Promise<WorkspaceCleanupScanResult> {
  return requestRuntimeJson('/v1/workspace-cleanup/scan', {
    method: 'POST',
    body: { ...args, ...(scanId ? { scanId } : {}) },
    timeoutMs: 10 * 60_000
  })
}

async function requestRemoteCleanupScan(
  connectionId: string,
  args: WorkspaceCleanupScanArgs
): Promise<WorkspaceCleanupScanResult> {
  const response = await window.api.runtimeEnvironments.call({
    selector: connectionId,
    method: 'workspaceCleanup.scan',
    params: {
      worktreeId: args.worktreeId,
      skipGitWorktreeIds: args.skipGitWorktreeIds
    },
    timeoutMs: 10 * 60_000
  })
  if (!response.ok) {
    return {
      scannedAt: Date.now(),
      candidates: [],
      errors: [
        {
          repoId: connectionId,
          repoName: connectionId,
          message: response.error.message
        }
      ]
    }
  }
  const result = response.result as WorkspaceCleanupScanResult
  return {
    ...result,
    candidates: result.candidates.map((candidate) =>
      attachCleanupConnection(candidate, connectionId)
    )
  }
}

function attachCleanupConnection(
  candidate: WorkspaceCleanupCandidate,
  connectionId: string
): WorkspaceCleanupCandidate {
  return { ...candidate, connectionId }
}

function mergeCleanupScanResults(
  local: WorkspaceCleanupScanResult,
  remote: WorkspaceCleanupScanResult[]
): WorkspaceCleanupScanResult {
  return remote.reduce(
    (result, entry) => ({
      scannedAt: Math.max(result.scannedAt, entry.scannedAt),
      candidates: [...result.candidates, ...entry.candidates],
      errors: [...result.errors, ...entry.errors]
    }),
    local
  )
}

function ensureProgressSubscription(): void {
  if (subscribed) {
    return
  }
  subscribed = true
  void subscribeRuntimeEventPush((entry) => {
    if (entry.topic !== 'workspace-cleanup.progress') {
      return
    }
    try {
      const envelope = JSON.parse(entry.data) as {
        payload?: WorkspaceCleanupScanProgress
      }
      const progress = envelope.payload
      if (!progress?.scanId) {
        return
      }
      progressListeners.get(progress.scanId)?.(progress)
    } catch {
      // The final scan response remains authoritative after a malformed event.
    }
  })
}
