import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";

import type { PreloadApi } from "../../../src/preload/api-types";
import {
  buildCommitMessagePrompt,
  splitGeneratedCommitMessage,
  type CommitMessageDraftContext,
} from "../../../src/shared/commit-message-generation";
import {
  cleanGeneratedCommitMessage,
  extractAgentErrorMessage,
} from "../../../src/shared/commit-message-prompt";
import {
  getCommitMessageAgentSpec,
  type CommitMessageAgentCapability,
  type CommitMessageModelCapability,
} from "../../../src/shared/commit-message-agent-spec";
import {
  planAgentBinary,
  planCommitMessageGeneration,
  type CommitMessagePlan,
} from "../../../src/shared/commit-message-plan";
import {
  buildPullRequestFieldsPrompt,
  parseGeneratedPullRequestFields,
  type PullRequestDraftContext,
} from "../../../src/shared/pull-request-generation";
import { renderSourceControlActionCommandTemplate } from "../../../src/shared/source-control-ai-actions";
import type { ResolvedSourceControlAiGenerationParams } from "../../../src/shared/source-control-ai";
import type { TuiAgent } from "../../../src/shared/types";

const GENERATION_TIMEOUT_MS = 60_000;
const MAX_AGENT_OUTPUT_BYTES = 4 * 1024 * 1024;

type CommitGenerationResult = Awaited<
  ReturnType<PreloadApi["git"]["generateCommitMessage"]>
>;
type PullRequestGenerationResult = Awaited<
  ReturnType<PreloadApi["git"]["generatePullRequestFields"]>
>;
type ModelDiscoveryResult = Awaited<
  ReturnType<PreloadApi["git"]["discoverCommitMessageModels"]>
>;

type CommitContextResult = {
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
};

type PullRequestContextResult = PullRequestDraftContext | null;

type ExecutePlanResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  canceled: boolean;
  spawnError: string | null;
};

type InternalTextGenerationResult =
  | { success: true; rawOutput: string; agentLabel?: string }
  | { success: false; error: string; canceled?: boolean };

export function createPebbleGitTextGenerationApi(
  base: PreloadApi["git"],
): PreloadApi["git"] {
  return {
    ...base,
    generateCommitMessage: generateTauriCommitMessage,
    discoverCommitMessageModels: discoverTauriCommitMessageModels,
    cancelGenerateCommitMessage: async ({ worktreePath }) => {
      await cancelTauriGeneration("commit-message", worktreePath);
    },
    generatePullRequestFields: generateTauriPullRequestFields,
    cancelGeneratePullRequestFields: async ({ worktreePath }) => {
      await cancelTauriGeneration("pull-request-fields", worktreePath);
    },
  };
}

async function generateTauriCommitMessage(args: {
  worktreePath: string;
  connectionId?: string;
  sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams;
}): Promise<CommitGenerationResult> {
  if (args.connectionId) {
    return {
      success: false,
      error:
        "Remote commit message generation is not yet wired through the Tauri SSH relay.",
    };
  }
  const params = args.sourceControlAiResolvedParams;
  if (!params) {
    return {
      success: false,
      error: "Source Control AI settings are not resolved yet.",
    };
  }

  const context = await invoke<CommitContextResult>(
    "source_control_text_generation_commit_context",
    { input: { cwd: args.worktreePath } },
  );
  if (!context.stagedSummary.trim() && !context.stagedPatch.trim()) {
    return { success: false, error: "No staged changes to summarize." };
  }

  const basePrompt = buildCommitMessagePrompt(context, "");
  const prompt =
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
          basePrompt,
          branch: context.branch ?? "(detached)",
          stagedFiles: context.stagedSummary,
          stagedPatch: context.stagedPatch,
        })
      : buildCommitMessagePrompt(context, params.customPrompt ?? "");
  const planned = planCommitMessageGeneration(params, prompt);
  if (!planned.ok) {
    return { success: false, error: planned.error };
  }
  const result = await runTauriPlan(
    planned.plan,
    args.worktreePath,
    "commit-message",
    "message",
  );
  if (!result.success) {
    return result;
  }
  try {
    const message = splitGeneratedCommitMessage(
      result.rawOutput,
    ).message.replace(/\s+$/, "");
    return { success: true, message, agentLabel: result.agentLabel };
  } catch {
    return {
      success: false,
      error: "Generated commit message could not be parsed.",
    };
  }
}

async function generateTauriPullRequestFields(args: {
  worktreePath: string;
  connectionId?: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams;
}): Promise<PullRequestGenerationResult> {
  if (args.connectionId) {
    return {
      success: false,
      error:
        "Remote pull request detail generation is not yet wired through the Tauri SSH relay.",
    };
  }
  const params = args.sourceControlAiResolvedParams;
  if (!params) {
    return {
      success: false,
      error: "Source Control AI settings are not resolved yet.",
    };
  }

  const context = await invoke<PullRequestContextResult>(
    "source_control_text_generation_pull_request_context",
    {
      input: {
        cwd: args.worktreePath,
        base: args.base,
        currentTitle: args.title,
        currentBody: args.body,
        currentDraft: args.draft,
      },
    },
  );
  if (!context) {
    return { success: false, error: "No branch changes to summarize." };
  }

  const basePrompt = buildPullRequestFieldsPrompt(context, "");
  const prompt =
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
          basePrompt,
          branch: context.branch ?? "(detached)",
          baseBranch: context.base,
          currentTitle: context.currentTitle,
          currentBody: context.currentBody,
          commitSummary: context.commitSummary,
          changedFiles: context.changeSummary,
          patch: context.patch,
        })
      : buildPullRequestFieldsPrompt(context, params.customPrompt ?? "");
  const planned = planCommitMessageGeneration(params, prompt);
  if (!planned.ok) {
    return {
      success: false,
      error: planned.error,
      branchChangedByPreparation: context.branchChangedByPreparation,
    };
  }

  const result = await runTauriPlan(
    planned.plan,
    args.worktreePath,
    "pull-request-fields",
    "details",
  );
  if (!result.success) {
    return {
      ...result,
      branchChangedByPreparation: context.branchChangedByPreparation,
    };
  }
  try {
    return {
      success: true,
      fields: parseGeneratedPullRequestFields(result.rawOutput, context),
      agentLabel: result.agentLabel,
      branchChangedByPreparation: context.branchChangedByPreparation,
    };
  } catch {
    return {
      success: false,
      error: "Generated pull request details could not be parsed.",
      branchChangedByPreparation: context.branchChangedByPreparation,
    };
  }
}

async function discoverTauriCommitMessageModels(args: {
  agentId: string;
  worktreePath?: string;
}): Promise<ModelDiscoveryResult> {
  const spec = getCommitMessageAgentSpec(args.agentId as TuiAgent);
  if (!spec) {
    return {
      success: false,
      error: `Agent "${args.agentId}" does not support AI commit messages.`,
    };
  }
  if (spec.modelSource === "static" || !spec.modelDiscovery) {
    return toModelDiscoveryCapability(spec);
  }
  const command = planAgentBinary(spec.modelDiscovery.binary, undefined);
  if (!command.ok) {
    return { success: false, error: command.error };
  }
  const cwd = args.worktreePath?.trim() || (await homeDir());
  const result = await executeTauriPlan(
    {
      binary: command.binary,
      args: [...command.prefixArgs, ...spec.modelDiscovery.args],
      stdinPayload: null,
      label: spec.label,
    },
    cwd,
    "model-discovery",
  );
  if (result.spawnError) {
    return {
      success: false,
      error: `${spec.modelDiscovery.binary} not found on PATH. Install ${spec.label} to discover models.`,
    };
  }
  if (result.timedOut) {
    return {
      success: false,
      error: `${spec.label} model discovery timed out after ${GENERATION_TIMEOUT_MS / 1000}s.`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      success: false,
      error: formatAgentCliFailureMessage(
        spec.label,
        result.stdout,
        result.stderr,
        result.exitCode,
      ),
    };
  }
  let models = spec.modelDiscovery.parse(result.stdout);
  if (models.length === 0 && result.stderr.trim()) {
    models = spec.modelDiscovery.parse(result.stderr);
  }
  if (models.length === 0) {
    return spec.models.length > 0
      ? toModelDiscoveryCapability(spec, spec.models, spec.defaultModelId)
      : {
          success: false,
          error: `${spec.label} returned no available models.`,
        };
  }
  const defaultModelId = models.some(
    (model) => model.id === spec.defaultModelId,
  )
    ? spec.defaultModelId
    : models[0].id;
  return toModelDiscoveryCapability(spec, models, defaultModelId);
}

async function runTauriPlan(
  plan: CommitMessagePlan,
  cwd: string,
  operation: "commit-message" | "pull-request-fields",
  emptyResultName: string,
): Promise<InternalTextGenerationResult> {
  const result = await executeTauriPlan(plan, cwd, operation);
  if (result.spawnError) {
    return {
      success: false,
      error: `${plan.binary} not found on PATH. Install ${plan.label} to use AI commit messages.`,
    };
  }
  if (result.canceled) {
    return { success: false, error: "Generation canceled.", canceled: true };
  }
  if (result.timedOut) {
    return {
      success: false,
      error: `Generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s.`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      success: false,
      error: formatAgentCliFailureMessage(
        plan.label,
        result.stdout,
        result.stderr,
        result.exitCode,
      ),
    };
  }
  const cleaned = cleanGeneratedCommitMessage(result.stdout);
  if (!cleaned) {
    const detail = extractAgentErrorMessage(result.stdout, result.stderr);
    return {
      success: false,
      error: detail
        ? formatAgentCliFailureMessage(
            plan.label,
            result.stdout,
            result.stderr,
            result.exitCode,
          )
        : `${plan.label} returned an empty ${emptyResultName}.`,
    };
  }
  return { success: true, rawOutput: cleaned, agentLabel: plan.label };
}

function executeTauriPlan(
  plan: CommitMessagePlan,
  cwd: string,
  operation: "commit-message" | "pull-request-fields" | "model-discovery",
): Promise<ExecutePlanResult> {
  return invoke<ExecutePlanResult>(
    "source_control_text_generation_execute_plan",
    {
      input: {
        laneKey: generationLaneKey(operation, cwd),
        cwd,
        binary: plan.binary,
        args: plan.args,
        stdinPayload: plan.stdinPayload,
        timeoutMs: GENERATION_TIMEOUT_MS,
        maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
      },
    },
  );
}

function cancelTauriGeneration(
  operation: "commit-message" | "pull-request-fields",
  cwd: string,
): Promise<void> {
  return invoke("source_control_text_generation_cancel", {
    laneKey: generationLaneKey(operation, cwd),
  });
}

function generationLaneKey(operation: string, cwd: string): string {
  return `${operation}:local:${cwd}`;
}

function formatAgentCliFailureMessage(
  label: string,
  stdout: string,
  stderr: string,
  exitCode: number | null,
): string {
  const detail = sanitizeAgentFailureDetail(
    extractAgentErrorMessage(stdout, stderr),
  );
  return detail
    ? `${label} CLI command failed: ${detail}`
    : `${label} CLI command failed with code ${exitCode}.`;
}

function sanitizeAgentFailureDetail(detail: string | null): string | null {
  const trimmed = detail
    ?.replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 240
    ? `${trimmed.slice(0, 240).trimEnd()}...`
    : trimmed;
}

function toModelDiscoveryCapability(
  spec: NonNullable<ReturnType<typeof getCommitMessageAgentSpec>>,
  models: CommitMessageModelCapability[] = spec.models,
  defaultModelId = spec.defaultModelId,
): Extract<ModelDiscoveryResult, { success: true }> {
  return {
    success: true,
    capability: {
      id: spec.id,
      label: spec.label,
      modelSource: spec.modelSource,
      defaultModelId,
      models,
    } satisfies CommitMessageAgentCapability,
    models,
    defaultModelId,
  };
}
