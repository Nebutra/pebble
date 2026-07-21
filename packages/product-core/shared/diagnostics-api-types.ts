export type DiagnosticsStatusPayload = {
  readonly localFileEnabled: boolean
  readonly bundleEnabled: boolean
  readonly traceFilePath: string
  readonly traceFamilySize: number
  readonly disabledReason?:
    | 'do_not_track'
    | 'pebble_telemetry_disabled'
    | 'pebble_diagnostics_disabled'
    | 'ci'
}

export type DiagnosticsBundlePayload = {
  readonly bundleSubmissionId: string
  readonly bytes: number
  readonly spanCount: number
}

export type DiagnosticsUploadPayload = { readonly ticketId: string } | { readonly canceled: true }
