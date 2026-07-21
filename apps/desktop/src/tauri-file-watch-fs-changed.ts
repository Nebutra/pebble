import { listen } from '@tauri-apps/api/event'
import type { FsChangedPayload } from '../../../packages/product-core/shared/types'

// Fan-out of fs-changed payloads to renderer callbacks; split out of
// tauri-file-watch-api.ts so both the local and remote watch paths share one
// dispatcher without a circular import.
const FS_CHANGED_EVENT = 'pebble:fs-changed'

export const fsChangedCallbacks = new Set<(payload: FsChangedPayload) => void>()
let fsChangedUnlistenPromise: Promise<() => void> | null = null

export function dispatchFsChangedPayload(payload: FsChangedPayload): void {
  for (const callback of Array.from(fsChangedCallbacks)) {
    callback(payload)
  }
}

export function ensureFsChangedListener(): void {
  if (fsChangedUnlistenPromise) {
    return
  }
  fsChangedUnlistenPromise = listen<FsChangedPayload>(FS_CHANGED_EVENT, (event) => {
    dispatchFsChangedPayload(event.payload)
  })
}

export function releaseFsChangedListenerIfIdle(): void {
  if (fsChangedCallbacks.size > 0 || !fsChangedUnlistenPromise) {
    return
  }
  void fsChangedUnlistenPromise.then((unlisten) => unlisten())
  fsChangedUnlistenPromise = null
}
