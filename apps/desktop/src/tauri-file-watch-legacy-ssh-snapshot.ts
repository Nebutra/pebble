import type { FsChangedPayload } from '../../../packages/product-core/shared/types'
import { resolveRuntimePath } from '../../../packages/product-core/shared/cross-platform-path'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

// Snapshot read + diff for the legacy SSH poll fallback, split out of
// tauri-file-watch-remote.ts.
export type FileWatchSnapshotEntry = {
  path: string
  size: number
  mtimeNanos: number
  isDirectory: boolean
}

export async function readLegacySshSnapshot(
  projectId: string,
  worktreeId: string
): Promise<Map<string, FileWatchSnapshotEntry>> {
  const query = new URLSearchParams({ projectId, worktreeId })
  const entries = await requestRuntimeJson<FileWatchSnapshotEntry[]>(
    `/v1/files/watch-snapshot?${query.toString()}`,
    { method: 'GET', timeoutMs: 60_000 }
  )
  return new Map(entries.map((entry) => [entry.path, entry]))
}

export function diffFileWatchSnapshots(
  worktreePath: string,
  previous: Map<string, FileWatchSnapshotEntry>,
  next: Map<string, FileWatchSnapshotEntry>
): FsChangedPayload['events'] {
  const events: FsChangedPayload['events'] = []
  for (const [path, entry] of next) {
    const prior = previous.get(path)
    if (!prior) {
      events.push({
        kind: 'create',
        absolutePath: resolveRuntimePath(worktreePath, path),
        isDirectory: entry.isDirectory
      })
    } else if (
      prior.size !== entry.size ||
      prior.mtimeNanos !== entry.mtimeNanos ||
      prior.isDirectory !== entry.isDirectory
    ) {
      events.push({
        kind: 'update',
        absolutePath: resolveRuntimePath(worktreePath, path),
        isDirectory: entry.isDirectory
      })
    }
  }
  for (const [path, entry] of previous) {
    if (!next.has(path)) {
      events.push({
        kind: 'delete',
        absolutePath: resolveRuntimePath(worktreePath, path),
        isDirectory: entry.isDirectory
      })
    }
  }
  return events
}
