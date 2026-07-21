import type {
  discoverTauriCommitMessageModels,
  generateTauriCommitMessage,
  generateTauriPullRequestFields
} from './tauri-source-control-text-generation'

export type RuntimeGitRpcResult = {
  handled: boolean
  result?: unknown
}

export function handled(result: unknown): RuntimeGitRpcResult {
  return { handled: true, result }
}

export function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function readRequiredString(value: unknown, label: string): string {
  const text = readString(value)
  if (!text) {
    throw new Error(`${label} is required`)
  }
  return text
}

export function readWorktreePath(params: unknown): string {
  return readRequiredString(readObject(params).worktreePath, 'worktree path')
}

export function readCommitGenerationParams(
  params: unknown
): Parameters<typeof generateTauriCommitMessage>[0] {
  const input = readObject(params)
  return {
    worktreePath: readWorktreePath(input),
    ...(readString(input.connectionId) ? { connectionId: readString(input.connectionId)! } : {}),
    ...(input.sourceControlAiResolvedParams
      ? {
          sourceControlAiResolvedParams: input.sourceControlAiResolvedParams as Parameters<
            typeof generateTauriCommitMessage
          >[0]['sourceControlAiResolvedParams']
        }
      : {})
  }
}

export function readPullRequestGenerationParams(
  params: unknown
): Parameters<typeof generateTauriPullRequestFields>[0] {
  const input = readObject(params)
  return {
    worktreePath: readWorktreePath(input),
    ...(readString(input.connectionId) ? { connectionId: readString(input.connectionId)! } : {}),
    base: readRequiredString(input.base, 'pull request base'),
    title: typeof input.title === 'string' ? input.title : '',
    body: typeof input.body === 'string' ? input.body : '',
    draft: input.draft === true,
    ...(input.sourceControlAiResolvedParams
      ? {
          sourceControlAiResolvedParams: input.sourceControlAiResolvedParams as Parameters<
            typeof generateTauriPullRequestFields
          >[0]['sourceControlAiResolvedParams']
        }
      : {})
  }
}

export function readModelDiscoveryParams(
  params: unknown
): Parameters<typeof discoverTauriCommitMessageModels>[0] {
  const input = readObject(params)
  return {
    agentId: readRequiredString(input.agentId, 'commit message agent'),
    ...(readString(input.worktreePath) ? { worktreePath: readString(input.worktreePath)! } : {})
  }
}
