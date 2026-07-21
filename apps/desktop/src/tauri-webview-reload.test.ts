import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { reloadTauriWebview, toggleTauriDevtools } from './tauri-webview-reload'

describe('reloadTauriWebview', () => {
  beforeEach(() => invokeMock.mockReset())

  it('routes force reload through the native cache-clearing command', () => {
    invokeMock.mockResolvedValue(undefined)
    reloadTauriWebview(true)
    expect(invokeMock).toHaveBeenCalledWith('webview_reload', { ignoreCache: true })
  })

  it('routes developer tools toggling through the native webview command', async () => {
    invokeMock.mockResolvedValue(true)
    await expect(toggleTauriDevtools()).resolves.toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('webview_toggle_devtools')
  })
})
