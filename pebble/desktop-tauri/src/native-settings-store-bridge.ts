import { invoke } from '@tauri-apps/api/core'

import { registerPersistentSettingsBackend } from '@/web/persistent-settings-backend'
import { NativeDocumentBackend, type NativeDocumentIo } from './native-document-backend'

/** localStorage keys the renderer persists settings/onboarding/keybindings
 *  under, mapped to the native store's short document names. Keeping the map
 *  explicit means only these three keys leave localStorage; every other web
 *  persistence key stays on localStorage untouched. */
const NATIVE_DOCUMENTS: Record<string, string> = {
  'pebble.web.settings.v1': 'settings',
  'pebble.web.onboarding.v1': 'onboarding',
  'pebble.web.keybindings.v1': 'keybindings'
}

const tauriIo: NativeDocumentIo = {
  read: (documentName) => invoke<string | null>('read_settings_document', { name: documentName }),
  write: (documentName, contents) =>
    invoke('write_settings_document', { name: documentName, contents }),
  readLegacy: (key) => window.localStorage.getItem(key)
}

/** Install native file-backed persistence for the settings/onboarding/
 *  keybindings documents and kick off the async prime+migration. */
export function installNativeSettingsStore(): void {
  for (const [key, documentName] of Object.entries(NATIVE_DOCUMENTS)) {
    const backend = new NativeDocumentBackend(key, documentName, tauriIo)
    registerPersistentSettingsBackend(key, backend)
    void backend.prime()
  }
}
