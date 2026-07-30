import type { RuntimeRpcResponse } from '../../../packages/product-core/shared/runtime-rpc-envelope'
import { okRuntimeRpc } from './pebble-runtime-rpc-response'
import { getProviderJson, postProviderJson } from './pebble-runtime-provider-json'
import {
  fetchAccessibleGitHubProjects,
  fetchGitHubProjectAssignableUsers,
  fetchGitHubProjectIssueTypes,
  fetchGitHubProjectLabels,
  fetchGitHubProjectWorkItemDetails,
  addGitHubProjectIssueComment,
  deleteGitHubProjectIssueComment,
  updateGitHubProjectIssue,
  updateGitHubProjectIssueComment,
  updateGitHubProjectPullRequest,
  clearGitHubProjectItemField,
  updateGitHubProjectIssueType,
  updateGitHubProjectItemField,
  fetchGitHubProjectViewTable,
  fetchGitHubProjectViews,
  resolveGitHubProjectRef
} from './tauri-github-project-catalog-bridge'

export async function dispatchGitHubProjectRuntimeMethod(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown> | null> {
  switch (method) {
    case 'github.project.resolveRef':
      return okRuntimeRpc(await resolveGitHubProjectRef(getProviderJson, params))
    case 'github.project.listViews':
      return okRuntimeRpc(await fetchGitHubProjectViews(getProviderJson, params))
    case 'github.project.viewTable':
      return okRuntimeRpc(await fetchGitHubProjectViewTable(postProviderJson, params))
    case 'github.project.listAccessible':
      return okRuntimeRpc(await fetchAccessibleGitHubProjects(getProviderJson))
    case 'github.project.listLabelsBySlug':
      return okRuntimeRpc(await fetchGitHubProjectLabels(getProviderJson, params))
    case 'github.project.listAssignableUsersBySlug':
      return okRuntimeRpc(await fetchGitHubProjectAssignableUsers(getProviderJson, params))
    case 'github.project.listIssueTypesBySlug':
      return okRuntimeRpc(await fetchGitHubProjectIssueTypes(getProviderJson, params))
    case 'github.project.workItemDetailsBySlug':
      return okRuntimeRpc(await fetchGitHubProjectWorkItemDetails(getProviderJson, params))
    case 'github.project.updateIssueBySlug':
      return okRuntimeRpc(await updateGitHubProjectIssue(postProviderJson, params))
    case 'github.project.updatePullRequestBySlug':
      return okRuntimeRpc(await updateGitHubProjectPullRequest(postProviderJson, params))
    case 'github.project.addIssueCommentBySlug':
      return okRuntimeRpc(await addGitHubProjectIssueComment(postProviderJson, params))
    case 'github.project.updateIssueCommentBySlug':
      return okRuntimeRpc(await updateGitHubProjectIssueComment(postProviderJson, params))
    case 'github.project.deleteIssueCommentBySlug':
      return okRuntimeRpc(await deleteGitHubProjectIssueComment(postProviderJson, params))
    case 'github.project.updateItemField':
      return okRuntimeRpc(await updateGitHubProjectItemField(postProviderJson, params))
    case 'github.project.clearItemField':
      return okRuntimeRpc(await clearGitHubProjectItemField(postProviderJson, params))
    case 'github.project.updateIssueTypeBySlug':
      return okRuntimeRpc(await updateGitHubProjectIssueType(postProviderJson, params))
    default:
      return null
  }
}
