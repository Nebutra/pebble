import { ONBOARDING_FINAL_STEP, ONBOARDING_FLOW_VERSION } from '../../../src/shared/constants'
import { CONTEXTUAL_TOUR_IDS } from '../../../src/shared/contextual-tours'
import {
  FEATURE_INTERACTION_IDS,
  type FeatureInteractionState
} from '../../../src/shared/feature-interactions'
import { FEATURE_TIP_IDS } from '../../../src/shared/feature-tips'
import type { OnboardingState, PersistedUIState } from '../../../src/shared/types'

const DEV_SHOW_FIRST_RUN_EDUCATION_STORAGE_KEY = 'pebble.dev.showFirstRunEducation'

export function installTauriDevEducationSuppression(): void {
  if (!import.meta.env.DEV || shouldShowFirstRunEducation()) {
    return
  }

  const onboardingBase = window.api.onboarding
  window.api.onboarding = {
    ...onboardingBase,
    get: async () => {
      const next = suppressOnboarding(await onboardingBase.get())
      persistSuppressedOnboarding(onboardingBase, next)
      return next
    }
  }

  const uiBase = window.api.ui
  window.api.ui = {
    ...uiBase,
    get: async () => {
      const next = suppressUI(await uiBase.get())
      persistSuppressedUI(uiBase, next)
      return next
    },
    recordFeatureInteraction: async (id) => suppressUI(await uiBase.recordFeatureInteraction(id))
  }
}

function shouldShowFirstRunEducation(): boolean {
  return window.localStorage.getItem(DEV_SHOW_FIRST_RUN_EDUCATION_STORAGE_KEY) === '1'
}

function suppressOnboarding(onboarding: OnboardingState): OnboardingState {
  if (onboarding.closedAt !== null) {
    return onboarding
  }
  return {
    ...onboarding,
    flowVersion: ONBOARDING_FLOW_VERSION,
    closedAt: Date.now(),
    outcome: 'completed',
    lastCompletedStep: ONBOARDING_FINAL_STEP
  }
}

function persistSuppressedOnboarding(
  onboarding: typeof window.api.onboarding,
  next: OnboardingState
): void {
  if (next.closedAt === null) {
    return
  }
  void onboarding
    .update({
      flowVersion: next.flowVersion,
      closedAt: next.closedAt,
      outcome: next.outcome,
      lastCompletedStep: next.lastCompletedStep
    })
    .catch(console.error)
}

function suppressUI(ui: PersistedUIState): PersistedUIState {
  return {
    ...ui,
    featureTipsSeenIds: mergeUnique(ui.featureTipsSeenIds, FEATURE_TIP_IDS),
    contextualToursSeenIds: mergeUnique(ui.contextualToursSeenIds, CONTEXTUAL_TOUR_IDS),
    contextualToursAutoEligible: false,
    featureInteractions: fillFeatureInteractions(ui.featureInteractions)
  }
}

function persistSuppressedUI(ui: typeof window.api.ui, next: PersistedUIState): void {
  void ui
    .set({
      featureTipsSeenIds: next.featureTipsSeenIds,
      contextualToursSeenIds: next.contextualToursSeenIds,
      contextualToursAutoEligible: next.contextualToursAutoEligible,
      featureInteractions: next.featureInteractions
    })
    .catch(console.error)
}

function mergeUnique<const T extends string>(
  current: readonly T[] | undefined,
  additions: readonly T[]
): T[] {
  return [...new Set([...(current ?? []), ...additions])]
}

function fillFeatureInteractions(
  current: FeatureInteractionState | undefined
): FeatureInteractionState {
  const next: FeatureInteractionState = { ...current }
  const now = Date.now()
  for (const id of FEATURE_INTERACTION_IDS) {
    next[id] ??= {
      firstInteractedAt: now,
      interactionCount: 1
    }
  }
  return next
}
