import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

export function createPebbleFeedbackApi(): PreloadApi['feedback'] {
  return {
    submit: (args) => invoke('feedback_submit', { input: args })
  }
}
