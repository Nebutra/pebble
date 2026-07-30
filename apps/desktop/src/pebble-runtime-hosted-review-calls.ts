import type {
  CreateHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewInfo
} from '../../../packages/product-core/shared/hosted-review'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { getProviderJson } from './pebble-runtime-provider-json'
import {
  createHostedReview,
  fetchHostedReviewCreationEligibility,
  fetchHostedReviewForBranch,
  updateHostedReview,
  mergeHostedReview,
  setHostedReviewAutoMerge,
  addHostedReviewComment,
  addHostedInlineReviewComment,
  replyHostedReviewComment,
  resolveHostedReviewThread,
  setHostedReviewFileViewed,
  type UpdateHostedReviewResult
} from './tauri-provider-review-bridge'

export async function readTauriHostedReviewForBranch(
  params: unknown
): Promise<HostedReviewInfo | null> {
  await ensurePebbleRuntimeProcess()
  return fetchHostedReviewForBranch(getProviderJson, params)
}

export async function readTauriHostedReviewCreationEligibility(
  params: unknown
): Promise<HostedReviewCreationEligibility> {
  await ensurePebbleRuntimeProcess()
  return fetchHostedReviewCreationEligibility(getProviderJson, params)
}

export async function createTauriHostedReview(params: unknown): Promise<CreateHostedReviewResult> {
  await ensurePebbleRuntimeProcess()
  return createHostedReview(requestRuntimeJson, params)
}

// Maps the renderer's per-operation github.*/gitlab.* RPC param shapes
// (prNumber/iid, updates.{title,body,state}, reviewers) onto the Go runtime's
// single provider-neutral update route.
export async function updateTauriHostedReview(
  provider: 'github' | 'gitlab',
  params: unknown,
  shape: {
    fromUpdates?: boolean
    titleField?: 'title'
    stateField?: 'state'
    reviewersField?: 'addReviewers' | 'removeReviewers'
    reviewerIdsField?: 'reviewerIds'
  }
): Promise<UpdateHostedReviewResult> {
  await ensurePebbleRuntimeProcess()
  const input = (params ?? {}) as Record<string, unknown>
  const number = input.prNumber ?? input.iid
  const updates = (input.updates ?? {}) as Record<string, unknown>
  const body: Record<string, unknown> = { ...input, number }
  if (shape.fromUpdates) {
    if (typeof updates.title === 'string') {
      body.title = updates.title
    }
    if (typeof updates.body === 'string') {
      body.body = updates.body
    }
    if (typeof updates.state === 'string') {
      body.state = updates.state
    }
    if (typeof updates.draft === 'boolean') {
      body.draft = updates.draft
    }
    if (provider === 'github' && typeof updates.baseRefName === 'string') {
      body.baseRefName = updates.baseRefName
    }
    if (provider === 'gitlab' && typeof updates.targetBranch === 'string') {
      body.targetBranch = updates.targetBranch
    }
  }
  if (shape.titleField) {
    body.title = input[shape.titleField]
  }
  if (shape.stateField) {
    body.state = input[shape.stateField]
  }
  if (shape.reviewersField && Array.isArray(input.reviewers)) {
    body[shape.reviewersField] = input.reviewers
  }
  if (shape.reviewerIdsField && Array.isArray(input[shape.reviewerIdsField])) {
    body.reviewerIds = input[shape.reviewerIdsField]
  }
  return updateHostedReview(requestRuntimeJson, { ...body, provider })
}

export async function mergeTauriHostedReview(
  provider: 'github' | 'gitlab',
  params: unknown,
  defaultMethod: 'merge' | 'squash'
): Promise<UpdateHostedReviewResult> {
  await ensurePebbleRuntimeProcess()
  const input = (params ?? {}) as Record<string, unknown>
  return mergeHostedReview(requestRuntimeJson, {
    ...input,
    provider,
    number: input.prNumber ?? input.iid,
    method: input.method ?? defaultMethod
  })
}

export async function setTauriHostedReviewAutoMerge(
  params: unknown
): Promise<UpdateHostedReviewResult> {
  await ensurePebbleRuntimeProcess()
  const input = (params ?? {}) as Record<string, unknown>
  return setHostedReviewAutoMerge(requestRuntimeJson, {
    ...input,
    number: input.prNumber,
    method: input.method ?? 'squash'
  })
}

export async function addTauriHostedReviewComment(provider: 'github' | 'gitlab', params: unknown) {
  await ensurePebbleRuntimeProcess()
  const input = (params ?? {}) as Record<string, unknown>
  return addHostedReviewComment(requestRuntimeJson, {
    ...input,
    provider,
    number: input.number ?? input.iid
  })
}

export async function addTauriHostedInlineReviewComment(
  provider: 'github' | 'gitlab',
  params: unknown
) {
  await ensurePebbleRuntimeProcess()
  const outer = (params ?? {}) as Record<string, unknown>
  const nested =
    outer.input && typeof outer.input === 'object' ? (outer.input as Record<string, unknown>) : {}
  return addHostedInlineReviewComment(requestRuntimeJson, {
    ...outer,
    ...nested,
    provider,
    number: outer.prNumber ?? outer.iid
  })
}

export async function replyTauriHostedReviewComment(params: unknown) {
  await ensurePebbleRuntimeProcess()
  const input = (params ?? {}) as Record<string, unknown>
  return replyHostedReviewComment(requestRuntimeJson, { ...input, number: input.prNumber })
}

export async function resolveTauriHostedReviewThread(
  provider: 'github' | 'gitlab',
  params: unknown
) {
  await ensurePebbleRuntimeProcess()
  const input = (params ?? {}) as Record<string, unknown>
  return resolveHostedReviewThread(requestRuntimeJson, {
    ...input,
    provider,
    number: input.iid,
    threadId: input.threadId ?? input.discussionId,
    resolved: input.resolve ?? input.resolved
  })
}

export async function setTauriHostedReviewFileViewed(params: unknown) {
  await ensurePebbleRuntimeProcess()
  return setHostedReviewFileViewed(requestRuntimeJson, params)
}
