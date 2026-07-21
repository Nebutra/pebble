import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { installTauriClipboardApi } from './tauri-clipboard-api'

describe('installTauriClipboardApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.window = {
      __TAURI_INTERNALS__: {},
      api: {
        ui: {
          saveClipboardImageAsTempFile: vi.fn(() => Promise.resolve('/remote/image.png')),
          writeClipboardFile: vi.fn(() => Promise.resolve({ ok: true }))
        }
      }
    } as unknown as Window & typeof globalThis
  })

  it('uses native clipboard commands for local text and images', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'clipboard_read_text') {
        return Promise.resolve('hello')
      }
      if (command === 'clipboard_read_selection_text') {
        return Promise.resolve('primary')
      }
      if (command === 'clipboard_write_file') {
        return Promise.resolve({ ok: true })
      }
      if (command === 'clipboard_save_image_as_temp_file') {
        return Promise.resolve('/tmp/image.png')
      }
      return Promise.resolve(undefined)
    })
    installTauriClipboardApi()

    await expect(window.api.ui.readClipboardText()).resolves.toBe('hello')
    await expect(window.api.ui.readSelectionClipboardText()).resolves.toBe('primary')
    await window.api.ui.writeClipboardText('world')
    await window.api.ui.writeSelectionClipboardText('selection')
    await expect(window.api.ui.writeClipboardFile('/tmp/report.pdf')).resolves.toEqual({ ok: true })
    window.api.ui.performNativePaste()
    window.api.ui.performNativePaste({ mode: 'paste-and-match-style' })
    await expect(window.api.ui.saveClipboardImageAsTempFile()).resolves.toBe('/tmp/image.png')
    expect(invokeMock).toHaveBeenCalledWith('clipboard_read_text')
    expect(invokeMock).toHaveBeenCalledWith('clipboard_read_selection_text')
    expect(invokeMock).toHaveBeenCalledWith('clipboard_write_text', { text: 'world' })
    expect(invokeMock).toHaveBeenCalledWith('clipboard_write_selection_text', {
      text: 'selection'
    })
    expect(invokeMock).toHaveBeenCalledWith('clipboard_write_file', {
      filePath: '/tmp/report.pdf'
    })
    expect(invokeMock).toHaveBeenCalledWith('perform_native_paste', {
      mode: 'paste'
    })
    expect(invokeMock).toHaveBeenCalledWith('perform_native_paste', {
      mode: 'paste-and-match-style'
    })
    expect(invokeMock).toHaveBeenCalledWith('clipboard_save_image_as_temp_file')
  })

  it('keeps remote image persistence on the runtime transport', async () => {
    const remote = window.api.ui.saveClipboardImageAsTempFile
    installTauriClipboardApi()
    await expect(
      window.api.ui.saveClipboardImageAsTempFile({ connectionId: 'ssh-1' })
    ).resolves.toBe('/remote/image.png')
    expect(remote).toHaveBeenCalledWith({ connectionId: 'ssh-1' })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('keeps remote files on the runtime materialization path', async () => {
    const remote = window.api.ui.writeClipboardFile
    installTauriClipboardApi()
    await expect(
      window.api.ui.writeClipboardFile({ filePath: '/remote/report.pdf', connectionId: 'ssh-1' })
    ).resolves.toEqual({ ok: true })
    expect(remote).toHaveBeenCalledWith({
      filePath: '/remote/report.pdf',
      connectionId: 'ssh-1'
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
