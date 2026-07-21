import type { FeatureTipId } from '../../../../shared/feature-tips'

export function getTauriUnavailableFeatureTipIds(): readonly FeatureTipId[] {
  // Tauri owns cloud and local dictation now, so shell selection must not
  // silently remove the canonical voice onboarding flow.
  return []
}
