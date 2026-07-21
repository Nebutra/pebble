import { translate } from '@/i18n/i18n'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import { supportsHostedReviewCreation } from '../../../../shared/hosted-review-creation-providers'
import type {
  HostedReviewCreationEligibility,
  HostedReviewInfo,
  HostedReviewProvider
} from '../../../../shared/hosted-review'
import type { PrimaryAction, PrimaryActionInputs } from './source-control-primary-action-types'
import { resolveCreatePrIntentEligibility } from './source-control-create-pr-intent-state'
import { canClickBlockedCreateReviewReason } from './source-control-create-review-blocked-action'
import { resolveCreatePrBlockedTitle } from './source-control-create-pr-blocked-title'

export function resolveProvisionalHostedReviewProvider(input: {
  hostedReview?: Pick<HostedReviewInfo, 'provider'> | null
  hostedReviewCreationState?: {
    repoId: string
    data: Pick<HostedReviewCreationEligibility, 'provider'>
  } | null
  activeRepoId?: string | null
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
}): HostedReviewProvider {
  if (input.hostedReview?.provider && supportsHostedReviewCreation(input.hostedReview.provider)) {
    return input.hostedReview.provider
  }
  if (
    input.hostedReviewCreationState &&
    input.activeRepoId === input.hostedReviewCreationState.repoId &&
    supportsHostedReviewCreation(input.hostedReviewCreationState.data.provider)
  ) {
    return input.hostedReviewCreationState.data.provider
  }
  if (input.linkedGitLabMR != null) {
    return 'gitlab'
  }
  if (input.linkedAzureDevOpsPR != null) {
    return 'azure-devops'
  }
  if (input.linkedGiteaPR != null) {
    return 'gitea'
  }
  if (input.linkedGitHubPR != null || input.fallbackGitHubPR != null) {
    return 'github'
  }
  return 'github'
}

export function buildLoadingHostedReviewCreationEligibility(
  provider: HostedReviewProvider
): HostedReviewCreationEligibility {
  return {
    provider,
    review: null,
    canCreate: false,
    blockedReason: null,
    nextAction: null
  }
}

function shouldOfferCreatePrHeaderChrome(
  hostedReviewCreation: HostedReviewCreationEligibility | null | undefined
): hostedReviewCreation is HostedReviewCreationEligibility {
  if (!supportsHostedReviewCreation(hostedReviewCreation?.provider)) {
    return false
  }
  const blockedReason = hostedReviewCreation?.blockedReason
  return blockedReason !== 'existing_review' && blockedReason !== 'unsupported_provider'
}

function buildCreatePrHeaderAction(
  hostedReviewCreation: HostedReviewCreationEligibility,
  title: string,
  disabled: boolean
): PrimaryAction {
  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(hostedReviewCreation.provider)
  )
  return {
    kind: 'create_pr',
    label: translate(
      'auto.components.right.sidebar.source.control.primary.action.e7ffa46946',
      'Create {{value0}}',
      { value0: copy.shortLabel }
    ),
    title,
    disabled
  }
}

export function resolveDisabledCreatePrHeaderAction(
  inputs: Pick<
    PrimaryActionInputs,
    'hostedReviewCreation' | 'isCommitting' | 'isRemoteOperationActive' | 'hasUnresolvedConflicts'
  >
): PrimaryAction | null {
  const { hostedReviewCreation } = inputs
  if (!shouldOfferCreatePrHeaderChrome(hostedReviewCreation)) {
    return null
  }

  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(hostedReviewCreation.provider)
  )

  const title = resolveCreatePrBlockedTitle(
    {
      isCommitting: inputs.isCommitting,
      isRemoteOperationActive: inputs.isRemoteOperationActive,
      hasUnresolvedConflicts: inputs.hasUnresolvedConflicts
    },
    hostedReviewCreation.blockedReason,
    copy.reviewLabel
  )

  const blockedByBusyState =
    inputs.isCommitting || inputs.isRemoteOperationActive || inputs.hasUnresolvedConflicts
  const disabled =
    blockedByBusyState || !canClickBlockedCreateReviewReason(hostedReviewCreation.blockedReason)
  return buildCreatePrHeaderAction(hostedReviewCreation, title, disabled)
}

export function resolveCreatePrIntentInFlightPrimaryAction(
  inputs?: Pick<PrimaryActionInputs, 'hostedReviewCreation'>
): PrimaryAction {
  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(inputs?.hostedReviewCreation?.provider)
  )

  return {
    kind: 'create_pr_intent',
    label: translate(
      'auto.components.right.sidebar.source.control.primary.action.e7ffa46946',
      'Create {{value0}}',
      { value0: copy.shortLabel }
    ),
    title: translate(
      'auto.components.right.sidebar.source.control.primary.action.d37e68f61d',
      'Preparing branch for review…'
    ),
    disabled: true
  }
}

export function resolveCreatePrIntentPrimaryAction(
  inputs: PrimaryActionInputs
): PrimaryAction | null {
  const createPrIntent = resolveCreatePrIntentEligibility({
    stagedCount: inputs.stagedCount,
    hasStageableChanges: inputs.hasStageableChanges,
    hasMessage: inputs.hasMessage,
    hasUnresolvedConflicts: inputs.hasUnresolvedConflicts,
    upstreamStatus: inputs.upstreamStatus,
    hostedReviewCreation: inputs.hostedReviewCreation,
    branchCommitsAhead: inputs.branchCommitsAhead,
    hasCurrentBranch: inputs.hasCurrentBranch
  })
  if (!createPrIntent.eligible) {
    return null
  }
  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(inputs.hostedReviewCreation?.provider)
  )
  return {
    kind: 'create_pr_intent',
    label: translate(
      'auto.components.right.sidebar.source.control.primary.action.e7ffa46946',
      'Create {{value0}}',
      { value0: copy.shortLabel }
    ),
    title: translate(
      'auto.components.right.sidebar.source.control.primary.action.c72e5e65d1',
      'Prepare this branch and create a {{value0}}',
      { value0: copy.reviewLabel }
    ),
    disabled: false
  }
}

function resolveLoadingCreatePrHeaderAction(
  hostedReviewCreation: HostedReviewCreationEligibility
): PrimaryAction | null {
  if (!shouldOfferCreatePrHeaderChrome(hostedReviewCreation)) {
    return null
  }
  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(hostedReviewCreation.provider)
  )
  return buildCreatePrHeaderAction(
    hostedReviewCreation,
    translate(
      'auto.components.right.sidebar.source.control.primary.action.h3i4j5k607',
      'Checking whether this branch can create a {{value0}}…',
      { value0: copy.reviewLabel }
    ),
    true
  )
}

export function resolveCreatePrHeaderAction(inputs: PrimaryActionInputs): PrimaryAction | null {
  if (inputs.isPrIntentInFlight) {
    return resolveCreatePrIntentInFlightPrimaryAction(inputs)
  }

  if (inputs.isHostedReviewCreationLoading && inputs.hostedReviewCreation) {
    return resolveLoadingCreatePrHeaderAction(inputs.hostedReviewCreation)
  }

  if (inputs.isCommitting || inputs.isRemoteOperationActive || inputs.hasUnresolvedConflicts) {
    return resolveDisabledCreatePrHeaderAction(inputs)
  }

  if (inputs.hostedReviewCreation?.canCreate) {
    const copy = localizedHostedReviewCopy(
      resolveSupportedHostedReviewCopyProvider(inputs.hostedReviewCreation.provider)
    )
    return {
      kind: 'create_pr',
      label: translate(
        'auto.components.right.sidebar.source.control.primary.action.e7ffa46946',
        'Create {{value0}}',
        { value0: copy.shortLabel }
      ),
      title: translate(
        'auto.components.right.sidebar.source.control.primary.action.946a8a05ea',
        'Create a {{value0}} for this branch',
        { value0: copy.reviewLabel }
      ),
      disabled: false
    }
  }

  const createPrIntent = resolveCreatePrIntentPrimaryAction(inputs)
  if (createPrIntent) {
    return createPrIntent
  }

  // Why: blocked notices are only for states the preparation intent cannot
  // safely resolve, such as auth/default-branch/unsafe sync blockers.
  if (canClickBlockedCreateReviewReason(inputs.hostedReviewCreation?.blockedReason)) {
    return resolveDisabledCreatePrHeaderAction(inputs)
  }

  return resolveDisabledCreatePrHeaderAction(inputs)
}
