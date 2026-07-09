import { invoke } from '@tauri-apps/api/core'

import type {
  DiagnosticsBundlePayload,
  DiagnosticsStatusPayload,
  DiagnosticsUploadPayload,
  PreloadApi
} from '../../../src/preload/api-types'
import rootPackage from '../../../package.json'

export function createPebbleDiagnosticsApi(
  base: PreloadApi['diagnostics']
): PreloadApi['diagnostics'] {
  return {
    ...base,
    getStatus: () => invoke<DiagnosticsStatusPayload>('diagnostics_get_status'),
    collectBundle: (lookbackMinutes) =>
      invoke<DiagnosticsBundlePayload>('diagnostics_collect_bundle', {
        input: {
          lookbackMinutes,
          appVersion: rootPackage.version
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
