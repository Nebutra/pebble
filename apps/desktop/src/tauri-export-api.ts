import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

export function createPebbleExportApi(): PreloadApi['export'] {
  return {
    htmlToPdf: (args) => invoke('export_html_to_pdf', { input: args })
  }
}
