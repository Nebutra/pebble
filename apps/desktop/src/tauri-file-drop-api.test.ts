// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dragDropHandler, onDragDropEventMock } = vi.hoisted(() => {
  const holder: {
    current?: (event: {
      payload: { type: string; paths: string[]; position: { x: number; y: number } }
    }) => void
  } = {}
  return {
    dragDropHandler: holder,
    onDragDropEventMock: vi.fn(async (handler) => {
      holder.current = handler
      return () => undefined
    })
  }
})

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onDragDropEvent: onDragDropEventMock })
}))

import { installTauriFileDropApi } from './tauri-file-drop-api'

describe('installTauriFileDropApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    Object.assign(window, { __TAURI_INTERNALS__: {}, api: { ui: {} }, devicePixelRatio: 2 })
  })

  it('routes physical native drops to the canonical DOM target contract', async () => {
    const target = document.createElement('div')
    target.dataset.nativeFileDropTarget = 'terminal'
    target.dataset.terminalTabId = 'tab-1'
    document.body.appendChild(target)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
    const listener = vi.fn()

    installTauriFileDropApi()
    window.api.ui.onFileDrop(listener)
    await vi.waitFor(() => expect(dragDropHandler.current).toBeTypeOf('function'))
    dragDropHandler.current?.({
      payload: { type: 'drop', paths: ['/tmp/a.txt'], position: { x: 200, y: 100 } }
    })

    expect(document.elementFromPoint).toHaveBeenCalledWith(100, 50)
    expect(listener).toHaveBeenCalledWith({
      paths: ['/tmp/a.txt'],
      target: 'terminal',
      tabId: 'tab-1'
    })
  })
})
