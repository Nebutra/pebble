import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

export function installTauriDeveloperPermissionsApi(): void {
  window.api.developerPermissions = {
    getStatus: () => invoke('developer_permissions_status'),
    request: ({ id }) => invoke('developer_permissions_request', { id }),
    openSettings: async ({ id }) => {
      await invoke('developer_permissions_open_settings', { id })
    }
  } satisfies PreloadApi['developerPermissions']
}
