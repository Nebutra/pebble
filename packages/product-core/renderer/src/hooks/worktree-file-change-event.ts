import type { FsChangedPayload } from '../../../shared/types'

export const PEBBLE_WORKTREE_FILE_CHANGE_EVENT = 'pebble:worktree-file-change'

export type WorktreeFileChangeEventDetail = {
  payload: FsChangedPayload
  runtimeEnvironmentId: string | null
}
