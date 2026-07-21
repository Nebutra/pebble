import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { KeybindingFileSnapshot } from '../../../packages/product-core/shared/keybindings'
import {
  readPersistentSettingsRaw,
  writePersistentSettingsRaw
} from '@/web/persistent-settings-backend'

const DOCUMENT_NAME = 'keybindings'
const STORAGE_KEY = 'pebble.web.keybindings.v1'

export function createTauriKeybindingsApi(
  base: PreloadApi['keybindings']
): PreloadApi['keybindings'] {
  const withNativePath = async (
    snapshot: KeybindingFileSnapshot
  ): Promise<KeybindingFileSnapshot> => ({
    ...snapshot,
    path: await documentPath()
  })

  const persist = async (snapshot: KeybindingFileSnapshot): Promise<KeybindingFileSnapshot> => {
    const contents =
      readPersistentSettingsRaw(STORAGE_KEY) ??
      JSON.stringify({
        version: 1,
        keybindings: snapshot.commonOverrides,
        platforms: snapshot.platformOverrides
      })
    await invoke('write_settings_document', { name: DOCUMENT_NAME, contents })
    return withNativePath({ ...snapshot, exists: true })
  }

  const reload = async (): Promise<KeybindingFileSnapshot> => {
    const contents = await invoke<string | null>('read_settings_document', {
      name: DOCUMENT_NAME
    })
    if (contents !== null) {
      writePersistentSettingsRaw(STORAGE_KEY, contents)
    }
    return withNativePath(await base.reload())
  }

  return {
    get: async () => withNativePath(await base.get()),
    ensureFile: async () => persist(await base.ensureFile()),
    setAction: async (args) => persist(await base.setAction(args)),
    reload,
    openFile: async () => {
      const snapshot = await persist(await base.ensureFile())
      await window.api.shell.openFilePath(snapshot.path)
      return snapshot
    },
    revealFile: async () => {
      const snapshot = await persist(await base.ensureFile())
      await window.api.shell.openInFileManager(snapshot.path)
      return snapshot
    },
    onChanged: (callback) =>
      base.onChanged((snapshot) => {
        void withNativePath(snapshot).then(callback)
      })
  }
}

function documentPath(): Promise<string> {
  return invoke<string>('settings_document_path', { name: DOCUMENT_NAME })
}
