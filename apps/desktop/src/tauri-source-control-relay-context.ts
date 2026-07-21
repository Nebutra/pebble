import type { PullRequestDraftContext } from '../../../packages/product-core/shared/pull-request-generation'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  GENERATION_TIMEOUT_MS,
  sanitizeAgentFailureDetail
} from './tauri-source-control-generation-plan-runner'

export type CommitContextResult = {
  branch: string | null
  stagedSummary: string
  stagedPatch: string
}

export type PullRequestContextResult = PullRequestDraftContext | null

/** Response shape from the Go runtime's SSH-relay commit-context route (see
 * runtimecore.GitCommitTextGenerationContext / ssh_target_routes.go). */
type SshGitCommitContextResponse = {
  branch: string | null
  stagedSummary: string
  stagedPatch: string
}

/** Response shape from the Go runtime's SSH-relay pull-request-context route
 * (see runtimecore.GitPullRequestTextGenerationContext). */
type SshGitPullRequestContextResponse = {
  branch: string | null
  base: string
  branchChangedByPreparation: boolean
  currentTitle: string
  currentBody: string
  currentDraft: boolean
  commitSummary: string
  changeSummary: string
  patch: string
} | null

// Why a Go HTTP route rather than a new Tauri command: the Go runtime already
// owns the system-ssh exec (ProbeSshTarget's connection args) needed to run
// pebble-relay-worker on the remote host, so calling its route directly here
// mirrors tauri-ssh-targets-api.ts's established pattern instead of adding a
// second SSH-exec implementation in Rust.
export async function fetchSshCommitContext(
  connectionId: string,
  worktreePath: string
): Promise<CommitContextResult> {
  const response = await requestRuntimeJson<SshGitCommitContextResponse>(
    `/v1/ssh-targets/${encodeURIComponent(connectionId)}/git-text-generation-context`,
    {
      method: 'POST',
      body: { kind: 'commit', repoRoot: worktreePath },
      timeoutMs: GENERATION_TIMEOUT_MS
    }
  )
  return {
    branch: response.branch,
    stagedSummary: response.stagedSummary,
    stagedPatch: response.stagedPatch
  }
}

export async function fetchSshPullRequestContext(
  connectionId: string,
  args: {
    worktreePath: string
    base: string
    title: string
    body: string
    draft: boolean
  }
): Promise<PullRequestContextResult> {
  const response = await requestRuntimeJson<SshGitPullRequestContextResponse>(
    `/v1/ssh-targets/${encodeURIComponent(connectionId)}/git-text-generation-context`,
    {
      method: 'POST',
      body: {
        kind: 'pull-request',
        repoRoot: args.worktreePath,
        base: args.base,
        currentTitle: args.title,
        currentBody: args.body,
        currentDraft: args.draft
      },
      timeoutMs: GENERATION_TIMEOUT_MS
    }
  )
  if (!response) {
    return null
  }
  return {
    branch: response.branch,
    base: response.base,
    branchChangedByPreparation: response.branchChangedByPreparation,
    currentTitle: response.currentTitle,
    currentBody: response.currentBody,
    currentDraft: response.currentDraft,
    commitSummary: response.commitSummary,
    changeSummary: response.changeSummary,
    patch: response.patch
  }
}

export function describeRelayContextError(
  what: string,
  connectionId: string | undefined,
  error: unknown
): string {
  const rawDetail = error instanceof Error ? error.message : String(error)
  const detail = sanitizeAgentFailureDetail(rawDetail) ?? 'runtime unavailable'
  if (!connectionId) {
    return `Failed to read ${what} context: ${detail}`
  }
  return `Failed to read ${what} context from the SSH remote: ${detail}`
}
