import type { RuntimeRpcResponse } from '../../../packages/product-core/shared/runtime-rpc-envelope'
import { okRuntimeRpc } from './pebble-runtime-rpc-response'
import { getProviderJson, postProviderJson } from './pebble-runtime-provider-json'
import { readGitLabRateLimitParams, readRateLimitParams } from './pebble-runtime-native-providers'
import {
  fetchGitHubPRCheckDetails,
  fetchGitHubPRChecks,
  fetchGitLabJobTrace,
  fetchGitLabIssues,
  fetchGitLabMRs,
  fetchGitLabWorkItems,
  fetchGitHubPRForBranch,
  fetchReviewWorkItems,
  rerunGitHubPRChecks,
  retryGitLabJob
} from './tauri-provider-review-bridge'
import {
  fetchGitHubRateLimit,
  fetchGitHubViewer,
  fetchGitHubAuthDiagnostic,
  fetchGitLabRateLimit,
  fetchGitLabViewer,
  fetchGitLabAuthDiagnostic
} from './tauri-provider-rate-limit-bridge'
import {
  addGitLabIssueComment,
  createGitLabIssue,
  fetchGitLabLabels,
  updateGitLabIssue
} from './tauri-gitlab-issue-mutation-bridge'
import {
  fetchGitLabTodos,
  fetchGitLabWorkItemByPath,
  fetchGitLabWorkItemDetails
} from './tauri-gitlab-work-item-details-bridge'
import {
  fetchGitHubIssue,
  fetchGitHubIssues,
  fetchGitHubPRComments,
  fetchGitHubWorkItem,
  fetchGitHubWorkItemDetails,
  fetchGitHubWorkItems
} from './tauri-github-work-items-bridge'
import {
  countGitHubWorkItems,
  createGitHubIssue,
  fetchGitHubAssignableUsers,
  fetchGitHubLabels,
  updateGitHubIssue
} from './tauri-github-issue-metadata-bridge'
import { fetchGitHubPRFileContents } from './tauri-github-pr-file-contents-bridge'
import { dispatchGitHubProjectRuntimeMethod } from './pebble-runtime-github-project-dispatch'

export async function dispatchProviderReadRuntimeMethod(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown> | null> {
  switch (method) {
    case 'github.prChecks':
      return okRuntimeRpc(await fetchGitHubPRChecks(getProviderJson, params))
    case 'github.prForBranch':
      return okRuntimeRpc(await fetchGitHubPRForBranch(postProviderJson, params))
    case 'github.rateLimit':
      return okRuntimeRpc(await fetchGitHubRateLimit(getProviderJson, readRateLimitParams(params)))
    case 'github.viewer':
      return okRuntimeRpc(await fetchGitHubViewer(getProviderJson))
    case 'github.diagnoseAuth':
      return okRuntimeRpc(await fetchGitHubAuthDiagnostic(getProviderJson))
    case 'github.prCheckDetails':
      return okRuntimeRpc(await fetchGitHubPRCheckDetails(getProviderJson, params))
    case 'github.rerunPRChecks':
      return okRuntimeRpc(await rerunGitHubPRChecks(postProviderJson, params))
    case 'github.listIssues':
      return okRuntimeRpc(await fetchGitHubIssues(getProviderJson, params))
    case 'github.listWorkItems':
      return okRuntimeRpc(await fetchGitHubWorkItems(getProviderJson, params))
    case 'github.countWorkItems':
      return okRuntimeRpc(await countGitHubWorkItems(getProviderJson, params))
    case 'github.listLabels':
      return okRuntimeRpc(await fetchGitHubLabels(getProviderJson, params))
    case 'github.listAssignableUsers':
      return okRuntimeRpc(await fetchGitHubAssignableUsers(getProviderJson, params))
    case 'github.createIssue':
      return okRuntimeRpc(await createGitHubIssue(postProviderJson, params))
    case 'github.updateIssue':
      return okRuntimeRpc(await updateGitHubIssue(postProviderJson, params))
    case 'github.issue':
      return okRuntimeRpc(await fetchGitHubIssue(getProviderJson, params))
    case 'github.workItem':
    case 'github.workItemByOwnerRepo':
      return okRuntimeRpc(await fetchGitHubWorkItem(getProviderJson, params))
    case 'github.workItemDetails':
      return okRuntimeRpc(await fetchGitHubWorkItemDetails(getProviderJson, params))
    case 'github.prFileContents':
      return okRuntimeRpc(await fetchGitHubPRFileContents(postProviderJson, params))
    case 'github.prComments':
      return okRuntimeRpc(await fetchGitHubPRComments(getProviderJson, params))
    case 'gitlab.listMRs':
      return okRuntimeRpc(await fetchGitLabMRs(getProviderJson, params))
    case 'gitlab.listIssues':
      return okRuntimeRpc(await fetchGitLabIssues(getProviderJson, params))
    case 'gitlab.listWorkItems':
      return okRuntimeRpc(await fetchGitLabWorkItems(getProviderJson, params))
    case 'gitlab.listLabels':
      return okRuntimeRpc(await fetchGitLabLabels(getProviderJson, params))
    case 'gitlab.createIssue':
      return okRuntimeRpc(await createGitLabIssue(postProviderJson, params))
    case 'gitlab.updateIssue':
      return okRuntimeRpc(await updateGitLabIssue(postProviderJson, params))
    case 'gitlab.addIssueComment':
      return okRuntimeRpc(await addGitLabIssueComment(postProviderJson, params))
    case 'gitlab.todos':
      return okRuntimeRpc(await fetchGitLabTodos(getProviderJson, params))
    case 'gitlab.workItemDetails':
      return okRuntimeRpc(await fetchGitLabWorkItemDetails(getProviderJson, params))
    case 'gitlab.workItemByPath':
      return okRuntimeRpc(await fetchGitLabWorkItemByPath(getProviderJson, params))
    case 'gitlab.rateLimit':
      return okRuntimeRpc(
        await fetchGitLabRateLimit(getProviderJson, readGitLabRateLimitParams(params))
      )
    case 'gitlab.viewer':
      return okRuntimeRpc(await fetchGitLabViewer(getProviderJson))
    case 'gitlab.diagnoseAuth':
      return okRuntimeRpc(await fetchGitLabAuthDiagnostic(getProviderJson))
    case 'gitlab.jobTrace':
      return okRuntimeRpc(await fetchGitLabJobTrace(postProviderJson, params))
    case 'gitlab.retryJob':
      return okRuntimeRpc(await retryGitLabJob(postProviderJson, params))
    // Provider-neutral list for the REST-backed providers (bitbucket,
    // azure-devops, gitea); params carry the provider discriminator.
    case 'providerReview.listWorkItems':
      return okRuntimeRpc(await fetchReviewWorkItems(getProviderJson, params))
    default:
      return dispatchGitHubProjectRuntimeMethod(method, params)
  }
}
