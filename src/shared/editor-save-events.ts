export const PEBBLE_EDITOR_SAVE_DIRTY_FILES_EVENT = 'pebble:editor-save-dirty-files'
export const PEBBLE_EDITOR_PREPARE_HOT_EXIT_EVENT = 'pebble:editor-prepare-hot-exit'

export type EditorSaveDirtyFilesDetail = {
  claim: () => void
  resolve: () => void
  reject: (message: string) => void
}

export type EditorPrepareHotExitDetail = EditorSaveDirtyFilesDetail
