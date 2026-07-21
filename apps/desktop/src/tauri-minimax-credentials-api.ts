import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { hasTauriInternals } from './pebble-runtime-http-bridge'

type MiniMaxCredentialsApi = PreloadApi['minimaxCredentials']

export function createPebbleMiniMaxCredentialsApi(
  base: MiniMaxCredentialsApi
): MiniMaxCredentialsApi {
  if (!hasTauriInternals()) {
    return { ...base }
  }
  return {
    getStatus: () => invoke('minimax_credentials_get_status'),
    saveCookie: (cookie) => invoke('minimax_credentials_save_cookie', { cookie }),
    clearCookie: () => invoke('minimax_credentials_clear_cookie')
  }
}
