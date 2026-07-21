import { translate } from '@/i18n/i18n'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'

type BlockedTitleBusyState = {
  isCommitting: boolean
  isRemoteOperationActive: boolean
  hasUnresolvedConflicts: boolean
}

// Split out of source-control-primary-create-pr-intent-action.ts: maps the
// create-review blocked reason (plus busy state) to a localized tooltip title.
export function resolveCreatePrBlockedTitle(
  busy: BlockedTitleBusyState,
  blockedReason: HostedReviewCreationEligibility['blockedReason'],
  reviewLabel: string
): string {
  if (busy.isCommitting) {
    return translate(
      'auto.components.right.sidebar.source.control.primary.action.16aee3a5c1',
      'Commit in progress…'
    )
  }
  if (busy.isRemoteOperationActive) {
    return translate(
      'auto.components.right.sidebar.source.control.primary.action.b8e4f2a901',
      'Wait for the remote operation to finish.'
    )
  }
  if (busy.hasUnresolvedConflicts) {
    return translate(
      'auto.components.right.sidebar.source.control.primary.action.c9f3a1b802',
      'Resolve conflicts before creating a {{value0}}.',
      { value0: reviewLabel }
    )
  }
  switch (blockedReason) {
    case 'default_branch':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.e3b9d5f814',
        'Cannot create a {{value0}} from the default branch.',
        { value0: reviewLabel }
      )
    case 'dirty':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.f4c0e6a925',
        'Commit changes before creating a {{value0}}.',
        { value0: reviewLabel }
      )
    case 'no_upstream':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.a5d1f7b036',
        'Publish commits before creating a {{value0}}.',
        { value0: reviewLabel }
      )
    case 'needs_push':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.b6e2a8c147',
        'Push commits before creating a {{value0}}.',
        { value0: reviewLabel }
      )
    case 'needs_sync':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.c7f3b9d258',
        'Sync this branch before creating a {{value0}}.',
        { value0: reviewLabel }
      )
    case 'auth_required':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.d8a4c0e369',
        'Authenticate before creating a {{value0}}.',
        { value0: reviewLabel }
      )
    case 'detached_head':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.e9b5d1f470',
        'Check out a branch before creating a {{value0}}.',
        { value0: reviewLabel }
      )
    case 'existing_review':
    case 'fork_head_unsupported':
    case null:
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.f0c6e2a581',
        'This branch is not ready for a {{value0}} yet.',
        { value0: reviewLabel }
      )
    case 'unsupported_provider':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.5a49f8a19c',
        'Creating a {{value0}} is not available in this environment yet.',
        { value0: reviewLabel }
      )
  }
}
