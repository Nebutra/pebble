import { track } from '@/lib/telemetry'
import type { EventProps } from '../../../../shared/telemetry-events'

export type PebbleCliFeatureTipSource = EventProps<'pebble_cli_feature_tip_shown'>['source']
export type PebbleCliFeatureTipSetupResult = EventProps<'pebble_cli_feature_tip_setup_result'>['result']
export type CmdJPaletteFeatureTipSource = EventProps<'cmd_j_palette_feature_tip_shown'>['source']

export function getPebbleCliFeatureTipTelemetrySource(value: unknown): PebbleCliFeatureTipSource {
  return value === 'app_open' ? 'app_open' : 'manual'
}

export function trackPebbleCliFeatureTipShown(source: PebbleCliFeatureTipSource): void {
  track('pebble_cli_feature_tip_shown', { source })
}

export function trackPebbleCliFeatureTipSetupClicked(source: PebbleCliFeatureTipSource): void {
  track('pebble_cli_feature_tip_setup_clicked', { source })
}

export function trackPebbleCliFeatureTipSetupResult(
  source: PebbleCliFeatureTipSource,
  result: PebbleCliFeatureTipSetupResult
): void {
  track('pebble_cli_feature_tip_setup_result', { source, result })
}

export function trackCmdJPaletteFeatureTipShown(source: CmdJPaletteFeatureTipSource): void {
  track('cmd_j_palette_feature_tip_shown', { source })
}

export function trackCmdJPaletteFeatureTipAcknowledged(source: CmdJPaletteFeatureTipSource): void {
  track('cmd_j_palette_feature_tip_acknowledged', { source })
}
