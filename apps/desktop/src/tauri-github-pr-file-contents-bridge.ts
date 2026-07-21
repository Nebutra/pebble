import type { GitHubPRFileContents } from '../../../packages/product-core/shared/types'
import {
  providerQuery,
  readProjectId,
  readWorktreeSelector,
  type ProviderSelectorParams
} from './tauri-provider-review-bridge'

type RuntimePostJson = <T>(
  path: string,
  options: { method: 'POST'; body?: unknown; timeoutMs?: number }
) => Promise<T>

type GitHubPRFileContentsParams = ProviderSelectorParams & {
  path?: unknown
  oldPath?: unknown
  status?: unknown
  headSha?: unknown
  baseSha?: unknown
}

export async function fetchGitHubPRFileContents(
  requestJson: RuntimePostJson,
  params: unknown
): Promise<GitHubPRFileContents> {
  const input = params as GitHubPRFileContentsParams
  const query = new URLSearchParams(await providerQuery(input, readWorktreeSelector(input), {}))
  const projectId = query.get('projectId') ?? readProjectId(input)
  if (!projectId) {
    throw new Error('GitHub PR file content requires a registered project')
  }
  const worktreeId = query.get('worktreeId')
  return requestJson('/v1/providers/github/pulls/file-contents', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      projectId,
      ...(worktreeId ? { worktreeId } : {}),
      file: {
        path: readString(input.path),
        oldPath: readString(input.oldPath),
        status: readStatus(input.status),
        headSha: readString(input.headSha),
        baseSha: readString(input.baseSha)
      }
    }
  })
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readStatus(value: unknown): string {
  return typeof value === 'string' ? value : 'modified'
}
