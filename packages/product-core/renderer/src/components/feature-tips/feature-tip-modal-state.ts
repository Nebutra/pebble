import type { GlobalSettings } from '../../../../shared/types'
import type { FeatureInteractionState } from '../../../../shared/feature-interactions'
import {
  FEATURE_TIPS,
  getCompletedFeatureTipIds,
  getOrderedUnseenFeatureTips,
  isFeatureTipId,
  type FeatureTip,
  type FeatureTipId
} from '../../../../shared/feature-tips'

export function getFeatureTipForModal(args: {
  cliInstalled: boolean
  modalData: Record<string, unknown>
  seenTipIds: readonly FeatureTipId[]
  featureInteractions: FeatureInteractionState
  settings: { voice?: GlobalSettings['voice'] } | null | undefined
  suppressedTipIds?: readonly FeatureTipId[]
}): FeatureTip | null {
  const suppressedTipIds = new Set<FeatureTipId>(args.suppressedTipIds)

  const modalTipId = isFeatureTipId(args.modalData.tipId) ? args.modalData.tipId : null
  if (modalTipId) {
    if (suppressedTipIds.has(modalTipId)) {
      return null
    }
    return FEATURE_TIPS.find((tip) => tip.id === modalTipId) ?? null
  }

  const hiddenTipIds = new Set<FeatureTipId>(args.seenTipIds)
  for (const tipId of suppressedTipIds) {
    hiddenTipIds.add(tipId)
  }

  const pendingTips = getOrderedUnseenFeatureTips({
    seenTipIds: hiddenTipIds,
    completedTipIds: getCompletedFeatureTipIds({
      cliInstalled: args.cliInstalled,
      voiceDictationEnabled: args.settings?.voice?.enabled === true,
      featureInteractions: args.featureInteractions
    })
  })

  return pendingTips[0] ?? null
}
