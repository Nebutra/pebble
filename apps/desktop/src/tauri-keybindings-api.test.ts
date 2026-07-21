import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { KeybindingFileSnapshot } from '../../../packages/product-core/shared/keybindings'
import { createTauriKeybindingsApi } from './tauri-keybindings-api'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const snapshot: KeybindingFileSnapshot = {
  path: 'Browser local storage',
  platform: 'darwin',
  exists: false,
  overrides: {},
  commonOverrides: {},
  platformOverrides: {},
  diagnostics: []
}

describe('Tauri keybindings API', () => {
  const openFilePath = vi.fn(async () => true)
  const openInFileManager = vi.fn(async () => ({ ok: true as const }))
  const storage = new Map<string, string>()
  const base = {
    get: vi.fn(async () => snapshot),
    ensureFile: vi.fn(async () => snapshot),
    setAction: vi.fn(async () => ({ ...snapshot, exists: true })),
    reload: vi.fn(async () => ({ ...snapshot, exists: true })),
    openFile: vi.fn(async () => snapshot),
    revealFile: vi.fn(async () => snapshot),
    onChanged: vi.fn(() => () => undefined)
  } satisfies PreloadApi['keybindings']

  beforeEach(() => {
    vi.clearAllMocks()
    storage.clear()
    vi.stubGlobal('window', {
      api: { shell: { openFilePath, openInFileManager } },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value)
      }
    })
    invoke.mockImplementation(async (command: string) => {
      if (command === 'settings_document_path') {
        return '/native/settings-store/keybindings.json'
      }
      if (command === 'read_settings_document') {
        return null
      }
      if (command === 'write_settings_document') {
        return undefined
      }
      throw new Error(`unexpected command ${command}`)
    })
  })

  it('opens and reveals the allowlisted native document', async () => {
    const api = createTauriKeybindingsApi(base)

    const opened = await api.openFile()
    const revealed = await api.revealFile()

    expect(opened.path).toBe('/native/settings-store/keybindings.json')
    expect(revealed.exists).toBe(true)
    expect(openFilePath).toHaveBeenCalledWith('/native/settings-store/keybindings.json')
    expect(openInFileManager).toHaveBeenCalledWith('/native/settings-store/keybindings.json')
  })

  it('flushes action changes to the native document immediately', async () => {
    const api = createTauriKeybindingsApi(base)
    await api.setAction({ actionId: 'app.settings', bindings: ['Mod+Comma'] })

    expect(invoke).toHaveBeenCalledWith(
      'write_settings_document',
      expect.objectContaining({ name: 'keybindings', contents: expect.any(String) })
    )
  })
})
