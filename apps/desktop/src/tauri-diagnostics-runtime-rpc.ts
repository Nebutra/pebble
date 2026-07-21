import { invoke } from '@tauri-apps/api/core'

import { ORPHAN_WORKTREE_ID } from '../../../packages/product-core/shared/constants'
import type { MemorySnapshot } from '../../../packages/product-core/shared/types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { readRepos, readWorktrees } from './pebble-tauri-workspace-runtime-api'

type RuntimeRpcResult = { handled: boolean; result?: unknown }

type RuntimeSession = {
  id: string
  worktreeId?: string
  tabId?: string
  leafId?: string
  pid?: number
  status: string
}

const HISTORY_CAPACITY = 60
const memoryHistoryByKey = new Map<string, number[]>()

export async function callTauriDiagnosticsRuntimeRpc(method: string): Promise<RuntimeRpcResult> {
  if (method !== 'diagnostics.memory') {
    return { handled: false }
  }
  return {
    handled: true,
    result: await readTauriMemorySnapshot()
  }
}

export async function readTauriMemorySnapshot(): Promise<MemorySnapshot> {
  const [sessions, worktrees, repos] = await Promise.all([
    requestRuntimeJson<RuntimeSession[]>('/v1/sessions', { method: 'GET' }),
    readWorktrees(),
    readRepos()
  ])
  const worktreeById = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const input = sessions
    .filter(
      (session) =>
        session.pid && session.pid > 0 && !['exited', 'failed', 'stopped'].includes(session.status)
    )
    .map((session) => {
      const worktree = session.worktreeId ? worktreeById.get(session.worktreeId) : undefined
      const repoId = worktree?.projectId ?? worktree?.repoId ?? ORPHAN_WORKTREE_ID
      const repo = repoById.get(repoId)
      return {
        sessionId: session.id,
        paneKey: session.tabId && session.leafId ? `${session.tabId}:${session.leafId}` : null,
        pid: session.pid as number,
        worktreeId: worktree?.id ?? ORPHAN_WORKTREE_ID,
        worktreeName: worktree?.displayName ?? 'Unattributed terminals',
        repoId,
        repoName: repo?.displayName ?? 'Other'
      }
    })
  const snapshot = await invoke<MemorySnapshot>('diagnostics_memory_snapshot', { sessions: input })
  snapshot.app.history = pushMemoryHistory('__app__', snapshot.app.memory)
  for (const worktree of snapshot.worktrees) {
    worktree.history = pushMemoryHistory(worktree.worktreeId, worktree.memory)
  }
  return snapshot
}

function pushMemoryHistory(key: string, memory: number): number[] {
  const history = [...(memoryHistoryByKey.get(key) ?? []), memory].slice(-HISTORY_CAPACITY)
  memoryHistoryByKey.set(key, history)
  return history
}

export function clearTauriDiagnosticsMemoryHistoryForTests(): void {
  memoryHistoryByKey.clear()
}
