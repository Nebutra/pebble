import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

export function installTauriClipboardApi(): void {
  if (!hasTauriInternals()) {
    return
  }
  const base = window.api.ui
  window.api.ui = {
    ...base,
    readClipboardText: () => invoke<string>('clipboard_read_text'),
    readSelectionClipboardText: () => invoke<string>('clipboard_read_selection_text'),
    writeClipboardText: (text) => invoke<void>('clipboard_write_text', { text }),
    writeSelectionClipboardText: (text) => invoke<void>('clipboard_write_selection_text', { text }),
    writeClipboardFile: (args) => {
      if (typeof args !== 'string' && args.connectionId) {
        return base.writeClipboardFile(args)
      }
      const filePath = typeof args === 'string' ? args : args.filePath
      return invoke<{ ok: boolean; reason?: string }>('clipboard_write_file', { filePath })
    },
    performNativePaste: (options) => {
      void invoke<boolean>('perform_native_paste', {
        mode: options?.mode ?? 'paste'
      })
    },
    saveClipboardImageAsTempFile: (args) => {
      if (args?.connectionId || args?.runtimeEnvironmentId) {
        return base.saveClipboardImageAsTempFile(args)
      }
      return invoke<string | null>('clipboard_save_image_as_temp_file')
    },
    writeClipboardImage: (dataUrl) => invoke<void>('clipboard_write_image', { dataUrl })
  } satisfies PreloadApi['ui']
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
