import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import {
  fetchGitHubRateLimit,
  fetchGitHubViewer,
  fetchGitHubAuthDiagnostic,
  fetchGitLabRateLimit,
  fetchGitLabViewer,
  fetchGitLabAuthDiagnostic
} from './tauri-provider-rate-limit-bridge'
import {
  fetchGitHubPRCheckDetails,
  fetchGitHubPRChecks,
  fetchGitHubPRForBranch,
  fetchGitLabIssues,
  fetchGitLabWorkItems,
  rerunGitHubPRChecks
} from './tauri-provider-review-bridge'
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
  fetchGitLabAssignableUsers,
  fetchGitLabIssue,
  fetchGitLabMergeRequest,
  fetchGitLabMergeRequestForBranch,
  fetchGitLabProjectRef
} from './tauri-gitlab-local-metadata-bridge'
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
  fetchGitHubLabels
} from './tauri-github-issue-metadata-bridge'
import { readProviderJson, writeProviderJson } from './pebble-tauri-runtime-provider-io'

function nativeGitHubRuntimeMethod<Key extends keyof PreloadApi['gh']>(
  _key: Key,
  method: string
): PreloadApi['gh'][Key] {
  // Why: direct preload calls and runtime RPC calls must share one native
  // dispatcher; otherwise an uncovered method silently re-enters Web pairing.
  return (async (params?: unknown) => {
    const response = await window.api.runtime.call({ method, params })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result
  }) as unknown as PreloadApi['gh'][Key]
}

export function createPebbleGitHubApi(
  base: PreloadApi['gh'],
  githubPRRefresh: Partial<PreloadApi['gh']>
): PreloadApi['gh'] {
  return {
    ...base,
    ...githubPRRefresh,
    // Why: the web preload is only a shape-compatible baseline; desktop PR
    // operations must never fall back to its paired-server transport.
    prForBranch: (args) => fetchGitHubPRForBranch(writeProviderJson, args),
    prChecks: (args) => fetchGitHubPRChecks(readProviderJson, args),
    prCheckDetails: (args) => fetchGitHubPRCheckDetails(readProviderJson, args),
    rerunPRChecks: (args) => rerunGitHubPRChecks(writeProviderJson, args),
    prComments: (args) => fetchGitHubPRComments(readProviderJson, args),
    repoSlug: nativeGitHubRuntimeMethod('repoSlug', 'github.repoSlug'),
    repoUpstream: nativeGitHubRuntimeMethod('repoUpstream', 'github.repoUpstream'),
    notifyWorkItemMutated: nativeGitHubRuntimeMethod(
      'notifyWorkItemMutated',
      'github.notifyWorkItemMutated'
    ),
    prFileContents: nativeGitHubRuntimeMethod('prFileContents', 'github.prFileContents'),
    resolveReviewThread: nativeGitHubRuntimeMethod(
      'resolveReviewThread',
      'github.resolveReviewThread'
    ),
    setPRFileViewed: nativeGitHubRuntimeMethod('setPRFileViewed', 'github.setPRFileViewed'),
    updatePRTitle: nativeGitHubRuntimeMethod('updatePRTitle', 'github.updatePRTitle'),
    mergePR: nativeGitHubRuntimeMethod('mergePR', 'github.mergePR'),
    setPRAutoMerge: nativeGitHubRuntimeMethod('setPRAutoMerge', 'github.setPRAutoMerge'),
    updatePRState: nativeGitHubRuntimeMethod('updatePRState', 'github.updatePRState'),
    requestPRReviewers: nativeGitHubRuntimeMethod(
      'requestPRReviewers',
      'github.requestPRReviewers'
    ),
    removePRReviewers: nativeGitHubRuntimeMethod('removePRReviewers', 'github.removePRReviewers'),
    updateIssue: nativeGitHubRuntimeMethod('updateIssue', 'github.updateIssue'),
    addIssueComment: nativeGitHubRuntimeMethod('addIssueComment', 'github.addIssueComment'),
    addPRReviewCommentReply: nativeGitHubRuntimeMethod(
      'addPRReviewCommentReply',
      'github.addPRReviewCommentReply'
    ),
    addPRReviewComment: nativeGitHubRuntimeMethod(
      'addPRReviewComment',
      'github.addPRReviewComment'
    ),
    listAccessibleProjects: nativeGitHubRuntimeMethod(
      'listAccessibleProjects',
      'github.project.listAccessible'
    ),
    resolveProjectRef: nativeGitHubRuntimeMethod('resolveProjectRef', 'github.project.resolveRef'),
    listProjectViews: nativeGitHubRuntimeMethod('listProjectViews', 'github.project.listViews'),
    getProjectViewTable: nativeGitHubRuntimeMethod(
      'getProjectViewTable',
      'github.project.viewTable'
    ),
    projectWorkItemDetailsBySlug: nativeGitHubRuntimeMethod(
      'projectWorkItemDetailsBySlug',
      'github.project.workItemDetailsBySlug'
    ),
    updateProjectItemField: nativeGitHubRuntimeMethod(
      'updateProjectItemField',
      'github.project.updateItemField'
    ),
    clearProjectItemField: nativeGitHubRuntimeMethod(
      'clearProjectItemField',
      'github.project.clearItemField'
    ),
    updateIssueBySlug: nativeGitHubRuntimeMethod(
      'updateIssueBySlug',
      'github.project.updateIssueBySlug'
    ),
    updatePullRequestBySlug: nativeGitHubRuntimeMethod(
      'updatePullRequestBySlug',
      'github.project.updatePullRequestBySlug'
    ),
    addIssueCommentBySlug: nativeGitHubRuntimeMethod(
      'addIssueCommentBySlug',
      'github.project.addIssueCommentBySlug'
    ),
    updateIssueCommentBySlug: nativeGitHubRuntimeMethod(
      'updateIssueCommentBySlug',
      'github.project.updateIssueCommentBySlug'
    ),
    deleteIssueCommentBySlug: nativeGitHubRuntimeMethod(
      'deleteIssueCommentBySlug',
      'github.project.deleteIssueCommentBySlug'
    ),
    listLabelsBySlug: nativeGitHubRuntimeMethod(
      'listLabelsBySlug',
      'github.project.listLabelsBySlug'
    ),
    listAssignableUsersBySlug: nativeGitHubRuntimeMethod(
      'listAssignableUsersBySlug',
      'github.project.listAssignableUsersBySlug'
    ),
    listIssueTypesBySlug: nativeGitHubRuntimeMethod(
      'listIssueTypesBySlug',
      'github.project.listIssueTypesBySlug'
    ),
    updateIssueTypeBySlug: nativeGitHubRuntimeMethod(
      'updateIssueTypeBySlug',
      'github.project.updateIssueTypeBySlug'
    ),
    viewer: () => fetchGitHubViewer(readProviderJson),
    diagnoseAuth: () => fetchGitHubAuthDiagnostic(readProviderJson),
    rateLimit: (args) => fetchGitHubRateLimit(readProviderJson, args),
    listIssues: (args) => fetchGitHubIssues(readProviderJson, args),
    listWorkItems: (args) => fetchGitHubWorkItems(readProviderJson, args),
    countWorkItems: (args) => countGitHubWorkItems(readProviderJson, args),
    listLabels: (args) => fetchGitHubLabels(readProviderJson, args),
    listAssignableUsers: (args) => fetchGitHubAssignableUsers(readProviderJson, args),
    createIssue: (args) => createGitHubIssue(writeProviderJson, args),
    issue: (args) => fetchGitHubIssue(readProviderJson, args),
    workItem: (args) => fetchGitHubWorkItem(readProviderJson, args),
    workItemByOwnerRepo: (args) => fetchGitHubWorkItem(readProviderJson, args),
    workItemDetails: (args) => fetchGitHubWorkItemDetails(readProviderJson, args)
  }
}

export function createPebbleGitLabApi(base: PreloadApi['gl']): PreloadApi['gl'] {
  return {
    ...base,
    viewer: () => fetchGitLabViewer(readProviderJson),
    diagnoseAuth: () => fetchGitLabAuthDiagnostic(readProviderJson),
    rateLimit: (args) => fetchGitLabRateLimit(readProviderJson, args),
    projectSlug: (args) => fetchGitLabProjectRef(readProviderJson, args),
    mrForBranch: (args) => fetchGitLabMergeRequestForBranch(readProviderJson, args),
    mr: (args) => fetchGitLabMergeRequest(readProviderJson, args),
    issue: (args) => fetchGitLabIssue(readProviderJson, args),
    // Why: the canonical API declaration historically names these rows as
    // work items, while Electron actually returns GitLabIssueInfo here.
    listIssues: ((args) =>
      fetchGitLabIssues(readProviderJson, args)) as PreloadApi['gl']['listIssues'],
    listWorkItems: (args) => fetchGitLabWorkItems(readProviderJson, args),
    listLabels: (args) => fetchGitLabLabels(readProviderJson, args),
    listAssignableUsers: (args) => fetchGitLabAssignableUsers(readProviderJson, args),
    createIssue: (args) => createGitLabIssue(writeProviderJson, args),
    updateIssue: (args) => updateGitLabIssue(writeProviderJson, args),
    addIssueComment: (args) => addGitLabIssueComment(writeProviderJson, args),
    todos: (args) => fetchGitLabTodos(readProviderJson, args),
    workItemDetails: (args) => fetchGitLabWorkItemDetails(readProviderJson, args),
    workItemByPath: (args) => fetchGitLabWorkItemByPath(readProviderJson, args)
  }
}
