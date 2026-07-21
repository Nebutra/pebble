import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import {
  cancelTauriGeneration,
  discoverTauriCommitMessageModels,
  generateTauriCommitMessage,
  generateTauriPullRequestFields
} from './tauri-source-control-text-generation'
import {
  type RuntimeGitRpcResult,
  handled,
  readCommitGenerationParams,
  readModelDiscoveryParams,
  readPullRequestGenerationParams,
  readWorktreePath
} from './tauri-git-rpc-value-readers'
import {
  checkIgnored,
  readBranchCompare,
  readBranchDiff,
  readCommitCompare,
  readCommitDiff,
  readGitConflictOperation,
  readGitDiff,
  readGitHistory,
  readGitStatus,
  readGitUpstreamStatus,
  readRemoteCommitUrl,
  readRemoteFileUrl,
  readRepositoryIdentity,
  readSubmoduleStatus
} from './tauri-git-read-commands'
import {
  checkoutBranch,
  mutateGit,
  readLocalBranches,
  syncFork
} from './tauri-git-mutation-commands'

const GIT_METHOD_ALIASES: Record<string, string> = {
  syncFork: 'forkSync'
}

export function createTauriGitRuntimeApi(base: PreloadApi['git']): PreloadApi['git'] {
  return new Proxy(base, {
    get(target, property, receiver) {
      const fallback = Reflect.get(target, property, receiver)
      if (typeof property !== 'string' || typeof fallback !== 'function') {
        return fallback
      }
      return async (params?: unknown) => {
        const runtimeMethod = `git.${GIT_METHOD_ALIASES[property] ?? property}`
        const response = await callTauriGitRuntimeRpc(runtimeMethod, params ?? {})
        if (response.handled) {
          return response.result
        }
        return fallback.call(target, params)
      }
    }
  }) as PreloadApi['git']
}

export async function callTauriGitRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeGitRpcResult> {
  switch (method) {
    case 'github.repoSlug':
      return handled((await readRepositoryIdentity(params)).slug)
    case 'github.repoUpstream':
      return handled((await readRepositoryIdentity(params)).upstream)
    case 'git.status':
      return handled(await readGitStatus(params))
    case 'git.checkIgnored':
      return handled(await checkIgnored(params))
    case 'git.submoduleStatus':
      return handled(await readSubmoduleStatus(params))
    case 'git.diff':
      return handled(await readGitDiff(params))
    case 'git.branchCompare':
      return handled(await readBranchCompare(params))
    case 'git.commitCompare':
      return handled(await readCommitCompare(params))
    case 'git.history':
      return handled(await readGitHistory(params))
    case 'git.branchDiff':
      return handled(await readBranchDiff(params))
    case 'git.commitDiff':
      return handled(await readCommitDiff(params))
    case 'git.upstreamStatus':
      return handled(await readGitUpstreamStatus(params))
    case 'git.conflictOperation':
      return handled(await readGitConflictOperation(params))
    case 'git.abortMerge':
      return handled(await mutateGit('abortMerge', params))
    case 'git.abortRebase':
      return handled(await mutateGit('abortRebase', params))
    case 'git.checkout':
      return handled(await checkoutBranch(params))
    case 'git.localBranches':
      return handled(await readLocalBranches(params))
    case 'git.stage':
      return handled(await mutateGit('stage', params))
    case 'git.bulkStage':
      return handled(await mutateGit('bulkStage', params))
    case 'git.unstage':
      return handled(await mutateGit('unstage', params))
    case 'git.bulkUnstage':
      return handled(await mutateGit('bulkUnstage', params))
    case 'git.discard':
      return handled(await mutateGit('discard', params))
    case 'git.bulkDiscard':
      return handled(await mutateGit('bulkDiscard', params))
    case 'git.commit':
      return handled(await mutateGit('commit', params))
    case 'git.generateCommitMessage':
      return handled(await generateTauriCommitMessage(readCommitGenerationParams(params)))
    case 'git.discoverCommitMessageModels':
      return handled(await discoverTauriCommitMessageModels(readModelDiscoveryParams(params)))
    case 'git.cancelGenerateCommitMessage':
      await cancelTauriGeneration('commit-message', readWorktreePath(params))
      return handled({ ok: true })
    case 'git.generatePullRequestFields':
      return handled(await generateTauriPullRequestFields(readPullRequestGenerationParams(params)))
    case 'git.cancelGeneratePullRequestFields':
      await cancelTauriGeneration('pull-request-fields', readWorktreePath(params))
      return handled({ ok: true })
    case 'git.fetch':
      return handled(await mutateGit('fetch', params))
    case 'git.forkSync':
      return handled(await syncFork(params))
    case 'git.pull':
      return handled(await mutateGit('pull', params))
    case 'git.push':
      return handled(await mutateGit('push', params))
    case 'git.fastForward':
      return handled(await mutateGit('fastForward', params))
    case 'git.rebaseFromBase':
      return handled(await mutateGit('rebaseFromBase', params))
    case 'git.remoteFileUrl':
      return handled(await readRemoteFileUrl(params))
    case 'git.remoteCommitUrl':
      return handled(await readRemoteCommitUrl(params))
    default:
      return { handled: false }
  }
}
