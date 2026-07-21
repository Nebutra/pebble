import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { createTauriExternalFileImportApi } from './tauri-external-file-import-api'
import {
  fsChangedCallbacks,
  ensureFsChangedListener,
  releaseFsChangedListenerIfIdle
} from './tauri-file-watch-fs-changed'
import { unwatchRemoteWorktree, watchRemoteWorktree } from './tauri-file-watch-remote'

const localWatchCounts = new Map<string, number>()

export function createPebbleFileWatchApi(base: PreloadApi['fs']): PreloadApi['fs'] {
  const nativeFileApi = createTauriExternalFileImportApi(base)
  return {
    ...nativeFileApi,
    watchWorktree: async (args) => {
      if (args.connectionId) {
        await watchRemoteWorktree(args)
        return
      }
      const key = args.worktreePath
      const count = localWatchCounts.get(key) ?? 0
      localWatchCounts.set(key, count + 1)
      if (count > 0) {
        return
      }
      try {
        await invoke('fs_watch_worktree', { input: args })
      } catch (error) {
        releaseLocalWatchCount(key)
        throw error
      }
    },
    unwatchWorktree: async (args) => {
      if (args.connectionId) {
        unwatchRemoteWorktree(args)
        return
      }
      const key = args.worktreePath
      const count = localWatchCounts.get(key) ?? 0
      if (count <= 1) {
        localWatchCounts.delete(key)
        await invoke('fs_unwatch_worktree', { input: args })
        return
      }
      localWatchCounts.set(key, count - 1)
    },
    onFsChanged: (callback) => {
      fsChangedCallbacks.add(callback)
      ensureFsChangedListener()
      return () => {
        fsChangedCallbacks.delete(callback)
        releaseFsChangedListenerIfIdle()
      }
    }
  }
}

function releaseLocalWatchCount(key: string): void {
  const count = localWatchCounts.get(key) ?? 0
  if (count <= 1) {
    localWatchCounts.delete(key)
    return
  }
  localWatchCounts.set(key, count - 1)
}
