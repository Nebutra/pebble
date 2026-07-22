// Shared consent-state shape, serializable across the main/renderer IPC
// boundary. Lives in `shared/` rather than main so the Privacy pane
// (renderer-side) can import the type without pulling in main-only code.
//
// The native telemetry bridge produces this discriminated union from persisted
// settings. Keeping it here as the source of truth means the bridge getter returns
// this exact shape and the Privacy pane renders helper text by pattern-
// matching the `reason` without re-deriving the rules.

export type TelemetryConsentState =
  | { effective: 'enabled' }
  | {
      effective: 'disabled'
      reason: 'do_not_track' | 'pebble_disabled' | 'ci' | 'user_opt_out'
    }
  | { effective: 'pending_banner' }
