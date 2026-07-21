import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { TelemetryConsentState } from '../../../packages/product-core/shared/telemetry-consent-types'

export type TauriTelemetryApi = Pick<
  PreloadApi,
  'telemetryTrack' | 'telemetrySetOptIn' | 'telemetryGetConsentState' | 'telemetryAcknowledgeBanner'
>

export function createTauriTelemetryApi(): TauriTelemetryApi {
  return {
    telemetryTrack: (name, props) => invoke<void>('telemetry_track', { name, props }),
    telemetrySetOptIn: (optedIn) => invoke<void>('telemetry_set_opt_in', { optedIn }),
    telemetryGetConsentState: () => invoke<TelemetryConsentState>('telemetry_get_consent_state'),
    telemetryAcknowledgeBanner: () => invoke<void>('telemetry_acknowledge_banner')
  }
}
