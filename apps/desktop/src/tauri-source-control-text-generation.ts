import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import {
  buildCommitMessagePrompt,
  splitGeneratedCommitMessage
} from '../../../packages/product-core/shared/commit-message-generation'
import { planCommitMessageGeneration } from '../../../packages/product-core/shared/commit-message-plan'
import {
  buildPullRequestFieldsPrompt,
  parseGeneratedPullRequestFields
} from '../../../packages/product-core/shared/pull-request-generation'
import { renderSourceControlActionCommandTemplate } from '../../../packages/product-core/shared/source-control-ai-actions'
import type { ResolvedSourceControlAiGenerationParams } from '../../../packages/product-core/shared/source-control-ai'
import {
  appendTauriHugeFolderToGitignore,
  findTauriHugeFoldersToIgnore
} from './tauri-git-huge-folder-api'
import { cancelTauriGeneration, runTauriPlan } from './tauri-source-control-generation-plan-runner'
import {
  type CommitContextResult,
  type PullRequestContextResult,
  describeRelayContextError,
  fetchSshCommitContext,
  fetchSshPullRequestContext
} from './tauri-source-control-relay-context'
import { discoverTauriCommitMessageModels } from './tauri-commit-message-model-discovery'

export { cancelTauriGeneration } from './tauri-source-control-generation-plan-runner'
export { discoverTauriCommitMessageModels } from './tauri-commit-message-model-discovery'

type CommitGenerationResult = Awaited<ReturnType<PreloadApi['git']['generateCommitMessage']>>
type PullRequestGenerationResult = Awaited<
  ReturnType<PreloadApi['git']['generatePullRequestFields']>
>

export function createPebbleGitTextGenerationApi(base: PreloadApi['git']): PreloadApi['git'] {
  return {
    ...base,
    findHugeFoldersToIgnore: ({ worktreePath }) => findTauriHugeFoldersToIgnore(worktreePath),
    appendGitignore: ({ worktreePath, folderName }) =>
      appendTauriHugeFolderToGitignore(worktreePath, folderName),
    generateCommitMessage: generateTauriCommitMessage,
    discoverCommitMessageModels: discoverTauriCommitMessageModels,
    cancelGenerateCommitMessage: async ({ worktreePath, connectionId }) => {
      await cancelTauriGeneration('commit-message', worktreePath, connectionId)
    },
    generatePullRequestFields: generateTauriPullRequestFields,
    cancelGeneratePullRequestFields: async ({ worktreePath, connectionId }) => {
      await cancelTauriGeneration('pull-request-fields', worktreePath, connectionId)
    }
  }
}

export async function generateTauriCommitMessage(args: {
  worktreePath: string
  connectionId?: string
  sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
}): Promise<CommitGenerationResult> {
  const params = args.sourceControlAiResolvedParams
  if (!params) {
    return {
      success: false,
      error: 'Source Control AI settings are not resolved yet.'
    }
  }

  let context: CommitContextResult
  try {
    context = args.connectionId
      ? await fetchSshCommitContext(args.connectionId, args.worktreePath)
      : await invoke<CommitContextResult>('source_control_text_generation_commit_context', {
          input: { cwd: args.worktreePath }
        })
  } catch (error) {
    return {
      success: false,
      error: describeRelayContextError('commit message', args.connectionId, error)
    }
  }
  if (!context.stagedSummary.trim() && !context.stagedPatch.trim()) {
    return { success: false, error: 'No staged changes to summarize.' }
  }

  const basePrompt = buildCommitMessagePrompt(context, '')
  const prompt =
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
          basePrompt,
          branch: context.branch ?? '(detached)',
          stagedFiles: context.stagedSummary,
          stagedPatch: context.stagedPatch
        })
      : buildCommitMessagePrompt(context, params.customPrompt ?? '')
  const planned = planCommitMessageGeneration(params, prompt)
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }
  const result = await runTauriPlan(
    planned.plan,
    args.worktreePath,
    'commit-message',
    'message',
    args.connectionId
  )
  if (!result.success) {
    return result
  }
  try {
    const message = splitGeneratedCommitMessage(result.rawOutput).message.replace(/\s+$/, '')
    return { success: true, message, agentLabel: result.agentLabel }
  } catch {
    return {
      success: false,
      error: 'Generated commit message could not be parsed.'
    }
  }
}

export async function generateTauriPullRequestFields(args: {
  worktreePath: string
  connectionId?: string
  base: string
  title: string
  body: string
  draft: boolean
  sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
}): Promise<PullRequestGenerationResult> {
  const params = args.sourceControlAiResolvedParams
  if (!params) {
    return {
      success: false,
      error: 'Source Control AI settings are not resolved yet.'
    }
  }

  let context: PullRequestContextResult
  try {
    context = args.connectionId
      ? await fetchSshPullRequestContext(args.connectionId, args)
      : await invoke<PullRequestContextResult>(
          'source_control_text_generation_pull_request_context',
          {
            input: {
              cwd: args.worktreePath,
              base: args.base,
              currentTitle: args.title,
              currentBody: args.body,
              currentDraft: args.draft
            }
          }
        )
  } catch (error) {
    return {
      success: false,
      error: describeRelayContextError('pull request details', args.connectionId, error)
    }
  }
  if (!context) {
    return { success: false, error: 'No branch changes to summarize.' }
  }

  const basePrompt = buildPullRequestFieldsPrompt(context, '')
  const prompt =
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
          basePrompt,
          branch: context.branch ?? '(detached)',
          baseBranch: context.base,
          currentTitle: context.currentTitle,
          currentBody: context.currentBody,
          commitSummary: context.commitSummary,
          changedFiles: context.changeSummary,
          patch: context.patch
        })
      : buildPullRequestFieldsPrompt(context, params.customPrompt ?? '')
  const planned = planCommitMessageGeneration(params, prompt)
  if (!planned.ok) {
    return {
      success: false,
      error: planned.error,
      branchChangedByPreparation: context.branchChangedByPreparation
    }
  }

  const result = await runTauriPlan(
    planned.plan,
    args.worktreePath,
    'pull-request-fields',
    'details',
    args.connectionId
  )
  if (!result.success) {
    return {
      ...result,
      branchChangedByPreparation: context.branchChangedByPreparation
    }
  }
  try {
    return {
      success: true,
      fields: parseGeneratedPullRequestFields(result.rawOutput, context),
      agentLabel: result.agentLabel,
      branchChangedByPreparation: context.branchChangedByPreparation
    }
  } catch {
    return {
      success: false,
      error: 'Generated pull request details could not be parsed.',
      branchChangedByPreparation: context.branchChangedByPreparation
    }
  }
}
