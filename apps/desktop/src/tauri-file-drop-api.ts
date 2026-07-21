import { getCurrentWindow } from '@tauri-apps/api/window'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import {
  createNativeFileDropPayload,
  resolveNativeFileDropPath,
  type NativeFileDropPathEntry,
  type NativeFileDropPayload
} from '../../../packages/product-core/shared/native-file-drop'

type FileDropListener = (payload: NativeFileDropPayload) => void

const listeners = new Set<FileDropListener>()
let nativeListenerInstalled = false

export function installTauriFileDropApi(): void {
  if (!hasTauriInternals()) {
    return
  }
  const base = window.api.ui
  window.api.ui = {
    ...base,
    onFileDrop: (callback) => {
      listeners.add(callback)
      installNativeFileDropListener()
      return () => listeners.delete(callback)
    }
  } satisfies PreloadApi['ui']
}

function installNativeFileDropListener(): void {
  if (nativeListenerInstalled) {
    return
  }
  nativeListenerInstalled = true
  void getCurrentWindow().onDragDropEvent(({ payload }) => {
    if (payload.type !== 'drop' || payload.paths.length === 0) {
      return
    }
    const scale = window.devicePixelRatio || 1
    const element = document.elementFromPoint(
      payload.position.x / scale,
      payload.position.y / scale
    )
    const resolution = resolveNativeFileDropPath(readDropPath(element))
    if (resolution?.target === 'rejected') {
      return
    }
    const result = createNativeFileDropPayload(resolution, payload.paths)
    if (!result) {
      return
    }
    for (const listener of listeners) {
      listener(result)
    }
  })
}

function readDropPath(start: Element | null): NativeFileDropPathEntry[] {
  const entries: NativeFileDropPathEntry[] = []
  let element: Element | null = start
  while (element) {
    if (element instanceof HTMLElement) {
      entries.push({
        nativeFileDropTarget: element.dataset.nativeFileDropTarget,
        nativeFileDropDir: element.dataset.nativeFileDropDir,
        terminalTabId: element.dataset.terminalTabId,
        terminalPaneLeafId: element.dataset.terminalPaneLeafId ?? element.dataset.leafId
      })
    }
    const parent = element.parentElement
    if (parent) {
      element = parent
      continue
    }
    const root = element.getRootNode()
    element = root instanceof ShadowRoot ? root.host : null
  }
  return entries
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
