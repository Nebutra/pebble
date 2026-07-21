import { invoke } from '@tauri-apps/api/core'
import { getVersion as getTauriAppVersion } from '@tauri-apps/api/app'

import type {
  DiagnosticsBundlePayload,
  DiagnosticsStatusPayload,
  DiagnosticsUploadPayload,
  PreloadApi
} from '../../../packages/product-core/shared/preload-api-types'

let appVersionPromise: Promise<string> | null = null

export function createPebbleDiagnosticsApi(
  base: PreloadApi['diagnostics']
): PreloadApi['diagnostics'] {
  return {
    ...base,
    getStatus: () => invoke<DiagnosticsStatusPayload>('diagnostics_get_status'),
    collectBundle: async (lookbackMinutes) =>
      invoke<DiagnosticsBundlePayload>('diagnostics_collect_bundle', {
        input: {
          lookbackMinutes,
          appVersion: await readAppVersion()
        }
      }),
    openBundlePreview: (bundleSubmissionId) =>
      invoke<void>('diagnostics_open_bundle_preview', {
        input: { bundleSubmissionId }
      }),
    discardBundlePreview: (bundleSubmissionId) =>
      invoke<void>('diagnostics_discard_bundle_preview', {
        input: { bundleSubmissionId }
      }),
    uploadBundle: (bundleSubmissionId) =>
      invoke<DiagnosticsUploadPayload>('diagnostics_upload_bundle', {
        input: { bundleSubmissionId }
      }),
    deleteBundle: (ticketId) =>
      invoke<void>('diagnostics_delete_bundle', {
        input: { ticketId }
      })
  }
}

function readAppVersion(): Promise<string> {
  appVersionPromise ??= getTauriAppVersion()
  return appVersionPromise
}
