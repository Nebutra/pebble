import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

type IssueCommandRunnerResult = Awaited<ReturnType<PreloadApi['hooks']['createIssueCommandRunner']>>

export function createPebbleHooksApi(base: PreloadApi['hooks']): PreloadApi['hooks'] {
  return {
    ...base,
    createIssueCommandRunner: async (args) => {
      const { repoId, worktreePath, command } = args
      const repo = (await window.api.repos.list()).find((entry) => entry.id === repoId)
      if (!repo || repo.kind === 'folder' || repo.connectionId) {
        return base.createIssueCommandRunner(args)
      }
      return invoke<IssueCommandRunnerResult>('hooks_create_issue_command_runner', {
        input: {
          repoPath: repo.path,
          worktreePath,
          command
        }
      })
    }
  }
}
