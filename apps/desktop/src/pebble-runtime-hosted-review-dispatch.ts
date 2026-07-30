import type { RuntimeRpcResponse } from '../../../packages/product-core/shared/runtime-rpc-envelope'
import { okRuntimeRpc } from './pebble-runtime-rpc-response'
import {
  addTauriHostedInlineReviewComment,
  addTauriHostedReviewComment,
  createTauriHostedReview,
  mergeTauriHostedReview,
  readTauriHostedReviewCreationEligibility,
  readTauriHostedReviewForBranch,
  replyTauriHostedReviewComment,
  resolveTauriHostedReviewThread,
  setTauriHostedReviewAutoMerge,
  setTauriHostedReviewFileViewed,
  updateTauriHostedReview
} from './pebble-runtime-hosted-review-calls'

export async function dispatchHostedReviewRuntimeMethod(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown> | null> {
  switch (method) {
    case 'hostedReview.forBranch':
      return okRuntimeRpc(await readTauriHostedReviewForBranch(params))
    case 'hostedReview.getCreationEligibility':
      return okRuntimeRpc(await readTauriHostedReviewCreationEligibility(params))
    case 'hostedReview.create':
      return okRuntimeRpc(await createTauriHostedReview(params))
    case 'github.updatePR':
      return okRuntimeRpc(
        await updateTauriHostedReview('github', params, {
          fromUpdates: true
        })
      )
    case 'github.updatePRTitle':
      return okRuntimeRpc(
        await updateTauriHostedReview('github', params, {
          titleField: 'title'
        })
      )
    case 'github.mergePR':
      return okRuntimeRpc(await mergeTauriHostedReview('github', params, 'squash'))
    case 'github.setPRAutoMerge':
      return okRuntimeRpc(await setTauriHostedReviewAutoMerge(params))
    case 'github.addIssueComment':
      return okRuntimeRpc(await addTauriHostedReviewComment('github', params))
    case 'github.addPRReviewComment':
      return okRuntimeRpc(await addTauriHostedInlineReviewComment('github', params))
    case 'github.addPRReviewCommentReply':
      return okRuntimeRpc(await replyTauriHostedReviewComment(params))
    case 'github.resolveReviewThread':
      return okRuntimeRpc(await resolveTauriHostedReviewThread('github', params))
    case 'github.setPRFileViewed':
      return okRuntimeRpc(await setTauriHostedReviewFileViewed(params))
    case 'github.updatePRState':
      return okRuntimeRpc(
        await updateTauriHostedReview('github', params, {
          fromUpdates: true
        })
      )
    case 'github.requestPRReviewers':
      return okRuntimeRpc(
        await updateTauriHostedReview('github', params, {
          reviewersField: 'addReviewers'
        })
      )
    case 'github.removePRReviewers':
      return okRuntimeRpc(
        await updateTauriHostedReview('github', params, {
          reviewersField: 'removeReviewers'
        })
      )
    case 'gitlab.updateMR':
      return okRuntimeRpc(
        await updateTauriHostedReview('gitlab', params, {
          fromUpdates: true
        })
      )
    case 'gitlab.updateMRState':
      return okRuntimeRpc(
        await updateTauriHostedReview('gitlab', params, {
          stateField: 'state'
        })
      )
    case 'gitlab.updateMRReviewers':
      return okRuntimeRpc(
        await updateTauriHostedReview('gitlab', params, {
          reviewerIdsField: 'reviewerIds'
        })
      )
    case 'gitlab.mergeMR':
      return okRuntimeRpc(await mergeTauriHostedReview('gitlab', params, 'merge'))
    case 'gitlab.addMRComment':
      return okRuntimeRpc(await addTauriHostedReviewComment('gitlab', params))
    case 'gitlab.addMRInlineComment':
      return okRuntimeRpc(await addTauriHostedInlineReviewComment('gitlab', params))
    case 'gitlab.resolveMRDiscussion':
      return okRuntimeRpc(await resolveTauriHostedReviewThread('gitlab', params))
    default:
      return null
  }
}
