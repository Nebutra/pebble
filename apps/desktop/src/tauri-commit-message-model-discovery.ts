import { homeDir } from '@tauri-apps/api/path'

import { getCommitMessageAgentSpec } from '../../../packages/product-core/shared/commit-message-agent-spec'
import { planAgentBinary } from '../../../packages/product-core/shared/commit-message-plan'
import type { TuiAgent } from '../../../packages/product-core/shared/types'
import {
  GENERATION_TIMEOUT_MS,
  type ModelDiscoveryResult,
  executeTauriPlan,
  formatAgentCliFailureMessage,
  formatNativeSpawnFailure,
  toModelDiscoveryCapability
} from './tauri-source-control-generation-plan-runner'

export async function discoverTauriCommitMessageModels(args: {
  agentId: string
  worktreePath?: string
  connectionId?: string
}): Promise<ModelDiscoveryResult> {
  const spec = getCommitMessageAgentSpec(args.agentId as TuiAgent)
  if (!spec) {
    return {
      success: false,
      error: `Agent "${args.agentId}" does not support AI commit messages.`
    }
  }
  if (spec.modelSource === 'static' || !spec.modelDiscovery) {
    return toModelDiscoveryCapability(spec)
  }
  const command = planAgentBinary(spec.modelDiscovery.binary, undefined)
  if (!command.ok) {
    return { success: false, error: command.error }
  }
  const cwd = args.worktreePath?.trim() || (await homeDir())
  const result = await executeTauriPlan(
    {
      binary: command.binary,
      args: [...command.prefixArgs, ...spec.modelDiscovery.args],
      stdinPayload: null,
      label: spec.label
    },
    cwd,
    'model-discovery',
    args.connectionId
  )
  if (result.spawnError) {
    return {
      success: false,
      error: formatNativeSpawnFailure(
        result.spawnError,
        spec.label,
        spec.modelDiscovery.binary,
        'discover models',
        Boolean(args.connectionId)
      )
    }
  }
  if (result.canceled) {
    return { success: false, error: 'Model discovery canceled.' }
  }
  if (result.timedOut) {
    return {
      success: false,
      error: `${spec.label} model discovery timed out after ${GENERATION_TIMEOUT_MS / 1000}s.`
    }
  }
  if (result.exitCode !== 0) {
    return {
      success: false,
      error: formatAgentCliFailureMessage(spec.label, result.stdout, result.stderr, result.exitCode)
    }
  }
  let models = spec.modelDiscovery.parse(result.stdout)
  if (models.length === 0 && result.stderr.trim()) {
    models = spec.modelDiscovery.parse(result.stderr)
  }
  if (models.length === 0) {
    return spec.models.length > 0
      ? toModelDiscoveryCapability(spec, spec.models, spec.defaultModelId)
      : {
          success: false,
          error: `${spec.label} returned no available models.`
        }
  }
  const defaultModelId = models.some((model) => model.id === spec.defaultModelId)
    ? spec.defaultModelId
    : models[0].id
  return toModelDiscoveryCapability(spec, models, defaultModelId)
}
