import { z } from 'zod'

import { isFeatureInteractionId, type FeatureInteractionId } from './feature-interactions'
import { isFeatureTipId } from './feature-tips'
import { normalizeWorktreeCardProperties } from './worktree-card-properties'
import type { WorkspaceHostOrder, WorkspaceHostScope } from './types'

const NullableString = z.string().nullable()
const StringArray = z.array(z.string())
const FeatureTipIds = z.array(z.custom(isFeatureTipId, { message: 'Unknown feature tip id' }))
const UnknownRecord = z.record(z.string(), z.unknown())
const UnknownRecordArray = z.array(UnknownRecord)
const WorktreeCardProperties = z
  .array(
    z.enum([
      'status',
      'unread',
      'ci',
      'branch',
      'issue',
      'linear-issue',
      'pr',
      'automation',
      'comment',
      'ports',
      'inline-agents'
    ])
  )
  .transform((value) => normalizeWorktreeCardProperties(value))
const WorkspaceStatusDefinition = z.object({
  id: z.string(),
  label: z.string(),
  color: z.string().optional(),
  icon: z.string().optional()
})
const TaskResumeState = z
  .object({
    githubMode: z.enum(['items', 'project']).optional(),
    githubItemsPreset: z.string().nullable().optional(),
    githubItemsQuery: z.string().optional(),
    githubProjectHiddenFieldIdsByView: z.record(z.string(), z.array(z.string())).optional(),
    linearPreset: z.enum(['assigned', 'created', 'all', 'completed']).optional(),
    linearQuery: z.string().optional()
  })
  .strict()
const WorkspaceCleanupDismissal = z
  .object({
    worktreeId: z.string(),
    dismissedAt: z.number().finite(),
    fingerprint: z.string(),
    classifierVersion: z.number().finite()
  })
  .strict()
const FeatureInteractionRecord = z
  .object({
    firstInteractedAt: z.number().finite().nonnegative(),
    interactionCount: z.number().int().positive().optional()
  })
  .strict()
const FeatureInteractions = z
  .record(z.string(), FeatureInteractionRecord)
  .superRefine((value, ctx) => {
    for (const id of Object.keys(value)) {
      if (!isFeatureInteractionId(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown feature interaction id: ${id}`,
          path: [id]
        })
      }
    }
  })
const WorkspaceHostScopeSchema = z.custom<WorkspaceHostScope>(
  (value) =>
    value === 'all' ||
    value === 'local' ||
    (typeof value === 'string' &&
      ((value.startsWith('ssh:') && value.length > 4) ||
        (value.startsWith('runtime:') && value.length > 8))),
  { message: 'Unknown workspace host scope' }
)
const WorkspaceHostIdSchema = z.custom<WorkspaceHostOrder[number]>(
  (value) =>
    value === 'local' ||
    (typeof value === 'string' &&
      ((value.startsWith('ssh:') && value.length > 4) ||
        (value.startsWith('runtime:') && value.length > 8))),
  { message: 'Unknown workspace host id' }
)

export const ClientUiUpdateSchema = z
  .object({
    lastActiveRepoId: NullableString.optional(),
    lastActiveWorktreeId: NullableString.optional(),
    sidebarWidth: z.number().finite().optional(),
    rightSidebarOpen: z.boolean().optional(),
    rightSidebarTab: z
      .enum(['explorer', 'search', 'vault', 'source-control', 'checks', 'ports'])
      .optional(),
    rightSidebarExplorerView: z.enum(['files', 'search']).optional(),
    rightSidebarWidth: z.number().finite().optional(),
    markdownTocPanelWidth: z.number().finite().optional(),
    groupBy: z.enum(['none', 'workspace-status', 'repo', 'pr-status']).optional(),
    showWorkspaceLineage: z.boolean().optional(),
    sortBy: z.enum(['name', 'smart', 'recent', 'repo', 'manual']).optional(),
    projectOrderBy: z.enum(['manual', 'recent']).optional(),
    showActiveOnly: z.boolean().optional(),
    hideSleepingWorkspaces: z.boolean().optional(),
    showSleepingWorkspaces: z.boolean().optional(),
    showInactiveWorkspaces: z.boolean().optional(),
    workspaceHostScope: WorkspaceHostScopeSchema.optional(),
    visibleWorkspaceHostIds: z.array(WorkspaceHostIdSchema).nullable().optional(),
    workspaceHostOrder: z.array(WorkspaceHostIdSchema).optional(),
    hideDefaultBranchWorkspace: z.boolean().optional(),
    hideAutomationGeneratedWorkspaces: z.boolean().optional(),
    filterRepoIds: StringArray.optional(),
    collapsedGroups: StringArray.optional(),
    uiZoomLevel: z.number().finite().optional(),
    editorFontZoomLevel: z.number().finite().optional(),
    worktreeCardProperties: WorktreeCardProperties.optional(),
    _worktreeCardModeDefaulted: z.boolean().optional(),
    agentActivityDisplayMode: z.enum(['compact', 'full']).optional(),
    workspaceStatuses: z.array(WorkspaceStatusDefinition).optional(),
    workspaceBoardOpacity: z.number().finite().optional(),
    workspaceBoardColumnWidth: z.number().finite().optional(),
    syncTaskStatusFromWorkspaceBoard: z.boolean().optional(),
    _workspaceStatusesDefaultOrderMigrated: z.boolean().optional(),
    _workspaceStatusesReorderedDefaultRepaired: z.boolean().optional(),
    _workspaceStatusesDefaultWorkflowMigrated: z.boolean().optional(),
    _workspaceStatusesDefaultVisualsMigrated: z.boolean().optional(),
    statusBarItems: z
      .array(
        z.enum([
          'claude',
          'codex',
          'gemini',
          'opencode-go',
          'kimi',
          'minimax',
          'ssh',
          'resource-usage',
          'ports'
        ])
      )
      .optional(),
    _portsStatusBarDefaultAdded: z.boolean().optional(),
    _kimiStatusBarDefaultAdded: z.boolean().optional(),
    _minimaxStatusBarDefaultAdded: z.boolean().optional(),
    statusBarVisible: z.boolean().optional(),
    dismissedUpdateVersion: NullableString.optional(),
    lastUpdateCheckAt: z.number().finite().nullable().optional(),
    pendingUpdateNudgeId: NullableString.optional(),
    dismissedUpdateNudgeId: NullableString.optional(),
    notificationPermissionRequested: z.boolean().optional(),
    updateReassuranceSeen: z.boolean().optional(),
    acknowledgedAgentsByPaneKey: z.record(z.string(), z.number().finite()).optional(),
    browserDefaultUrl: NullableString.optional(),
    browserDefaultSearchEngine: z
      .enum(['google', 'duckduckgo', 'bing', 'kagi'])
      .nullable()
      .optional(),
    browserDefaultZoomLevel: z.number().finite().optional(),
    browserKagiSessionLink: NullableString.optional(),
    windowBounds: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite(),
        height: z.number().finite()
      })
      .nullable()
      .optional(),
    windowMaximized: z.boolean().optional(),
    _sortBySmartMigrated: z.boolean().optional(),
    _inlineAgentsDefaultedForExperiment: z.boolean().optional(),
    _inlineAgentsDefaultedForAllUsers: z.boolean().optional(),
    trustedPebbleHooks: z.record(z.string(), z.unknown()).optional(),
    setupScriptPromptDismissedRepoIds: StringArray.optional(),
    projectOrderManualDefaultNoticeDismissed: z.boolean().optional(),
    usageEmptyStateDismissed: z.boolean().optional(),
    petVisible: z.boolean().optional(),
    petId: z.string().optional(),
    customPets: UnknownRecordArray.optional(),
    petSize: z.number().finite().optional(),
    sidekickVisible: z.boolean().optional(),
    sidekickId: z.string().optional(),
    customSidekicks: UnknownRecordArray.optional(),
    sidekickSize: z.number().finite().optional(),
    taskResumeState: TaskResumeState.optional(),
    workspaceCleanup: z
      .object({ dismissals: z.record(z.string(), WorkspaceCleanupDismissal) })
      .strict()
      .optional(),
    featureTipsSeenIds: FeatureTipIds.optional(),
    featureInteractions: FeatureInteractions.optional(),
    contextualToursSeenIds: StringArray.optional(),
    contextualToursAutoEligible: z.boolean().optional()
  })
  .strict()
  .default({})

export const FeatureInteractionIdSchema = z.custom<FeatureInteractionId>(isFeatureInteractionId, {
  message: 'Unknown feature interaction id'
})
