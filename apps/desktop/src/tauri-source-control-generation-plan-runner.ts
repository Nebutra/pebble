import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import {
  cleanGeneratedCommitMessage,
  extractAgentErrorMessage
} from '../../../packages/product-core/shared/commit-message-prompt'
import type {
  getCommitMessageAgentSpec,
  CommitMessageAgentCapability,
  CommitMessageModelCapability
} from '../../../packages/product-core/shared/commit-message-agent-spec'
import type { CommitMessagePlan } from '../../../packages/product-core/shared/commit-message-plan'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

export const GENERATION_TIMEOUT_MS = 60_000
export const MAX_AGENT_OUTPUT_BYTES = 4 * 1024 * 1024

export type ModelDiscoveryResult = Awaited<
  ReturnType<PreloadApi['git']['discoverCommitMessageModels']>
>

export type ExecutePlanResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  canceled: boolean
  spawnError: string | null
}

export type InternalTextGenerationResult =
  | { success: true; rawOutput: string; agentLabel?: string }
  | { success: false; error: string; canceled?: boolean }

export async function runTauriPlan(
  plan: CommitMessagePlan,
  cwd: string,
  operation: 'commit-message' | 'pull-request-fields',
  emptyResultName: string,
  connectionId?: string
): Promise<InternalTextGenerationResult> {
  const result = await executeTauriPlan(plan, cwd, operation, connectionId)
  if (result.spawnError) {
    return {
      success: false,
      error: formatNativeSpawnFailure(
        result.spawnError,
        plan.label,
        plan.binary,
        'generate source-control text',
        Boolean(connectionId)
      )
    }
  }
  if (result.canceled) {
    return { success: false, error: 'Generation canceled.', canceled: true }
  }
  if (result.timedOut) {
    return {
      success: false,
      error: `Generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s.`
    }
  }
  if (result.exitCode !== 0) {
    return {
      success: false,
      error: formatAgentCliFailureMessage(plan.label, result.stdout, result.stderr, result.exitCode)
    }
  }
  const cleaned = cleanGeneratedCommitMessage(result.stdout)
  if (!cleaned) {
    const detail = extractAgentErrorMessage(result.stdout, result.stderr)
    return {
      success: false,
      error: detail
        ? formatAgentCliFailureMessage(plan.label, result.stdout, result.stderr, result.exitCode)
        : `${plan.label} returned an empty ${emptyResultName}.`
    }
  }
  return { success: true, rawOutput: cleaned, agentLabel: plan.label }
}

export function executeTauriPlan(
  plan: CommitMessagePlan,
  cwd: string,
  operation: 'commit-message' | 'pull-request-fields' | 'model-discovery',
  connectionId?: string
): Promise<ExecutePlanResult> {
  return requestRuntimeJson<ExecutePlanResult>('/v1/providers/text-generation/execute', {
    method: 'POST',
    body: {
      laneKey: generationLaneKey(operation, cwd, connectionId),
      target: connectionId ? { kind: 'ssh', sshTargetId: connectionId } : { kind: 'local' },
      cwd,
      binary: plan.binary,
      args: plan.args,
      stdinPayload: plan.stdinPayload,
      timeoutMs: GENERATION_TIMEOUT_MS,
      maxOutputBytes: MAX_AGENT_OUTPUT_BYTES
    },
    timeoutMs: GENERATION_TIMEOUT_MS + 10_000
  })
}

export function cancelTauriGeneration(
  operation: 'commit-message' | 'pull-request-fields',
  cwd: string,
  connectionId?: string
): Promise<void> {
  return requestRuntimeJson('/v1/providers/text-generation/cancel', {
    method: 'POST',
    body: { laneKey: generationLaneKey(operation, cwd, connectionId) },
    timeoutMs: 5_000
  })
}

function generationLaneKey(operation: string, cwd: string, connectionId?: string): string {
  return `${operation}:${connectionId ? `ssh:${connectionId}` : 'local'}:${cwd}`
}

export function formatAgentCliFailureMessage(
  label: string,
  stdout: string,
  stderr: string,
  exitCode: number | null
): string {
  const detail = sanitizeAgentFailureDetail(extractAgentErrorMessage(stdout, stderr))
  return detail
    ? `${label} CLI command failed: ${detail}`
    : `${label} CLI command failed with code ${exitCode}.`
}

export function formatNativeSpawnFailure(
  code: string,
  label: string,
  binary: string,
  action: string,
  remote: boolean
): string {
  const location = remote ? ' on the SSH target' : ''
  switch (code) {
    case 'binary_not_found':
      return `${binary} not found on PATH${location}. Install ${label} there to ${action}.`
    case 'cwd_unavailable':
      return `The source-control workspace is unavailable${location}.`
    case 'output_limit_exceeded':
      return `${label} returned too much output.`
    case 'ssh_unavailable':
      return 'The SSH target could not run text generation. Check the connection and remote agent installation.'
    case 'invalid_request':
      return 'Pebble rejected an unsafe text-generation request.'
    default:
      return `${label} could not be started${location}. Check the agent configuration and try again.`
  }
}

export function sanitizeAgentFailureDetail(detail: string | null): string | null {
  const trimmed = detail
    ?.replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!trimmed) {
    return null
  }
  const redacted = trimmed
    .replace(/[A-Za-z]:[\\/](?:[^\s"'`<>\\/|:*?]+[\\/])*[^\s"'`<>\\/|:*?]+/g, '[path]')
    .replace(/(^|[\s"'`(])\/(?:[^\s"'`<>/]+\/)*[^\s"'`<>/]+/g, '$1[path]')
  return redacted.length > 240 ? `${redacted.slice(0, 240).trimEnd()}...` : redacted
}

export function toModelDiscoveryCapability(
  spec: NonNullable<ReturnType<typeof getCommitMessageAgentSpec>>,
  models: CommitMessageModelCapability[] = spec.models,
  defaultModelId = spec.defaultModelId
): Extract<ModelDiscoveryResult, { success: true }> {
  return {
    success: true,
    capability: {
      id: spec.id,
      label: spec.label,
      modelSource: spec.modelSource,
      defaultModelId,
      models
    } satisfies CommitMessageAgentCapability,
    models,
    defaultModelId
  }
}
