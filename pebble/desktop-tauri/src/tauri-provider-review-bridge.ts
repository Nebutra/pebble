// Bridges the renderer's provider RPC methods (github.prChecks, gitlab.listMRs)
// to the local Go runtime's /v1/providers routes, so PR/MR + review flows work
// without pairing a remote environment. Only methods whose full response shape
// the local gh/glab CLI paths can produce faithfully are routed here; anything
// else stays remote-gated in the dispatcher.
import type { PRCheckDetail } from "../../../src/shared/types";
import type {
  GitLabPagedResult,
  GitLabWorkItem,
} from "../../../src/shared/gitlab-types";
import type {
  CreateHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewInfo,
  HostedReviewProvider,
} from "../../../src/shared/hosted-review";
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef,
} from "../../../src/shared/hosted-review-refs";
import { readWorktrees } from "./pebble-tauri-workspace-runtime-api";

type RuntimeGetJson = <T>(path: string) => Promise<T>;
type RuntimePostJson = <T>(
  path: string,
  options: { method: "POST"; body?: unknown; timeoutMs?: number },
) => Promise<T>;

// The renderer sends `repo` as the Pebble Repo.id, which is the runtime's
// projectId. Worktree-scoped callers may also pass worktreeId.
type ProviderSelectorParams = {
  repo?: unknown;
  repoId?: unknown;
  projectId?: unknown;
  worktree?: unknown;
  worktreeId?: unknown;
  worktreePath?: unknown;
};

type GitHubWorkItem = {
  number: number;
  title: string;
  state: string;
  url: string;
  updatedAt: string;
  branchName?: string;
  baseRefName?: string;
  headSha?: string;
};

type HostedReviewForBranchParams = ProviderSelectorParams & {
  branch?: unknown;
  linkedGitHubPR?: unknown;
  fallbackGitHubPR?: unknown;
  linkedGitLabMR?: unknown;
};

type CreateHostedReviewParams = ProviderSelectorParams & {
  provider?: unknown;
  base?: unknown;
  head?: unknown;
  title?: unknown;
  body?: unknown;
  draft?: unknown;
  useTemplate?: unknown;
};

type HostedReviewCapabilities = {
  provider?: unknown;
  authenticated?: unknown;
  currentBranch?: unknown;
  defaultBaseRef?: unknown;
};

// ── GitHub PR checks ────────────────────────────────────────────────
// github.prChecks resolves to PRCheckDetail[] (src/main/runtime/rpc/methods/github.ts
// → getRepoPRChecks). The Go route returns the same rows the `gh pr checks`
// fallback path produces in Electron.

type GitHubPRChecksParams = ProviderSelectorParams & {
  prNumber?: unknown;
};

export async function fetchGitHubPRChecks(
  requestJson: RuntimeGetJson,
  params: unknown,
): Promise<PRCheckDetail[]> {
  const input = params as GitHubPRChecksParams;
  const { worktreeId, prNumber } = input;
  const number = coercePositiveInt(prNumber);
  if (number === null) {
    throw new Error("Missing pull request number");
  }
  const query = await providerQuery(input, input.worktree ?? worktreeId, {
    number: String(number),
  });
  const result = await requestJson<{ checks: PRCheckDetail[] }>(
    `/v1/providers/github/pulls/checks?${query}`,
  );
  return result.checks ?? [];
}

// ── GitLab MR list ──────────────────────────────────────────────────
// gitlab.listMRs resolves to GitLabPagedResult<GitLabWorkItem> (listGitLabRepoMRs
// → listMergeRequests). The Go route returns the mapped MR rows; totals mirror
// the CLI cwd-fallback in src/main/gitlab/client.ts, which the renderer already
// treats as approximate.

type GitLabListMRsParams = ProviderSelectorParams & {
  state?: unknown;
  page?: unknown;
  perPage?: unknown;
  query?: unknown;
};

export async function fetchGitLabMRs(
  requestJson: RuntimeGetJson,
  params: unknown,
): Promise<GitLabPagedResult<GitLabWorkItem>> {
  const input = params as GitLabListMRsParams;
  const { worktree, worktreeId, state, page, perPage, query } = input;
  const resolvedPage = coercePositiveInt(page) ?? 1;
  const resolvedPerPage = coercePositiveInt(perPage) ?? 20;
  const extra: Record<string, string> = {
    perPage: String(resolvedPerPage),
  };
  if (typeof state === "string" && state.trim()) {
    extra.state = state.trim();
  }
  if (typeof query === "string" && query.trim()) {
    extra.query = query.trim();
  }
  const queryString = await providerQuery(input, worktree ?? worktreeId, extra);
  const result = await requestJson<{ items: GitLabWorkItem[] }>(
    `/v1/providers/gitlab/merge-requests?${queryString}`,
  );
  const items = result.items ?? [];
  return {
    items,
    page: resolvedPage,
    perPage: resolvedPerPage,
    // The CLI path doesn't return X-Total headers; mirror the cwd-fallback's
    // approximate totals so pagination controls behave the same.
    totalCount: items.length,
    totalPages:
      items.length < resolvedPerPage ? resolvedPage : resolvedPage + 1,
  };
}

// ── REST-backed provider PR lists (Bitbucket / Azure DevOps / Gitea) ─
// These providers have no bundled CLI; the Go runtime calls their REST APIs
// with the same PEBBLE_* env-var credentials Electron's clients read, and maps
// rows to the provider-neutral shape below (mirrors GitHubWorkItem /
// GitLabWorkItem field-for-field).

export type ReviewWorkItem = {
  id: string;
  type: "pr";
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  updatedAt: string;
  author: string | null;
  branchName?: string;
  baseRefName?: string;
  headSha?: string;
  isCrossRepository?: boolean;
};

const REVIEW_WORK_ITEM_ROUTES: Record<string, string> = {
  bitbucket: "/v1/providers/bitbucket/pulls",
  "azure-devops": "/v1/providers/azure-devops/pulls",
  gitea: "/v1/providers/gitea/pulls",
};

type ReviewWorkItemsParams = ProviderSelectorParams & {
  provider?: unknown;
  state?: unknown;
  limit?: unknown;
};

export async function fetchReviewWorkItems(
  requestJson: RuntimeGetJson,
  params: unknown,
): Promise<ReviewWorkItem[]> {
  const input = params as ReviewWorkItemsParams;
  const { worktree, worktreeId, provider, state, limit } = input;
  const route =
    typeof provider === "string"
      ? REVIEW_WORK_ITEM_ROUTES[provider.trim()]
      : undefined;
  if (!route) {
    throw new Error(`Unsupported review provider: ${String(provider)}`);
  }
  const extra: Record<string, string> = {};
  const resolvedLimit = coercePositiveInt(limit);
  if (resolvedLimit !== null) {
    extra.limit = String(resolvedLimit);
  }
  if (typeof state === "string" && state.trim()) {
    extra.state = state.trim();
  }
  const query = await providerQuery(input, worktree ?? worktreeId, extra);
  const result = await requestJson<{ items: ReviewWorkItem[] }>(
    `${route}?${query}`,
  );
  return result.items ?? [];
}

// ── Hosted review lookup ─────────────────────────────────────────────
// Existing-review lookup and GitHub/GitLab creation use the Go provider routes,
// keeping Tauri on the same visible PR/MR flows without Electron IPC.

export async function fetchHostedReviewForBranch(
  requestJson: RuntimeGetJson,
  params: unknown,
): Promise<HostedReviewInfo | null> {
  const input = params as HostedReviewForBranchParams;
  const branch = readNonEmptyString(input.branch);
  if (!branch) {
    return null;
  }
  const gitHubReview = await findGitHubReviewForBranch(
    requestJson,
    input,
    branch,
  );
  if (gitHubReview) {
    return gitHubReview;
  }
  return findGitLabReviewForBranch(requestJson, input, branch);
}

export async function fetchHostedReviewCreationEligibility(
  requestJson: RuntimeGetJson,
  params: unknown,
): Promise<HostedReviewCreationEligibility> {
  const review = await fetchHostedReviewForBranch(requestJson, params);
  if (review) {
    return {
      provider: review.provider,
      review: { number: review.number, url: review.url },
      canCreate: false,
      blockedReason: "existing_review",
      nextAction: "open_existing_review",
    };
  }
  const input = params as HostedReviewForBranchParams;
  const capabilities = await fetchHostedReviewCapabilities(requestJson, input);
  return buildHostedReviewCreationEligibility(input, capabilities);
}

async function fetchHostedReviewCapabilities(
  requestJson: RuntimeGetJson,
  input: ProviderSelectorParams,
): Promise<HostedReviewCapabilities> {
  const query = await providerQuery(input, readWorktreeSelector(input), {});
  return requestJson<HostedReviewCapabilities>(
    `/v1/providers/review-capabilities?${query}`,
  );
}

function buildHostedReviewCreationEligibility(
  input: HostedReviewForBranchParams,
  capabilities: HostedReviewCapabilities,
): HostedReviewCreationEligibility {
  const provider = readSupportedCreationProvider(capabilities.provider);
  const branch =
    normalizeOptionalHeadRef(input.branch) ??
    normalizeOptionalHeadRef(capabilities.currentBranch);
  const defaultBaseRef =
    normalizeOptionalBaseRef((input as { base?: unknown }).base) ??
    normalizeOptionalBaseRef(capabilities.defaultBaseRef);
  const baseResult = {
    provider,
    review: null,
    defaultBaseRef,
    head: branch,
  };
  if (!branch || branch === "HEAD") {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: "detached_head",
      nextAction: null,
    };
  }
  if (provider === "unsupported") {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: "unsupported_provider",
      nextAction: null,
    };
  }
  if (defaultBaseRef && branch.toLowerCase() === defaultBaseRef.toLowerCase()) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: "default_branch",
      nextAction: null,
    };
  }
  if (
    (input as { hasUncommittedChanges?: unknown }).hasUncommittedChanges ===
    true
  ) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: "dirty",
      nextAction: "commit",
    };
  }
  if ((input as { hasUpstream?: unknown }).hasUpstream === false) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: "no_upstream",
      nextAction: "publish",
    };
  }
  if ((input as { hasUpstream?: unknown }).hasUpstream !== true) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: null,
      nextAction: null,
    };
  }
  if (readNumber((input as { behind?: unknown }).behind) > 0) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: "needs_sync",
      nextAction: "sync",
    };
  }
  if (capabilities.authenticated !== true) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: "auth_required",
      nextAction: "authenticate",
    };
  }
  if (readNumber((input as { ahead?: unknown }).ahead) > 0) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: "needs_push",
      nextAction: "push",
    };
  }
  return {
    ...baseResult,
    canCreate: Boolean(defaultBaseRef),
    blockedReason: null,
    nextAction: null,
  };
}

function readSupportedCreationProvider(value: unknown): HostedReviewProvider {
  return value === "github" || value === "gitlab" ? value : "unsupported";
}

function normalizeOptionalHeadRef(value: unknown): string | null {
  const ref = readNonEmptyString(value);
  return ref ? normalizeHostedReviewHeadRef(ref) : null;
}

function normalizeOptionalBaseRef(value: unknown): string | null {
  const ref = readNonEmptyString(value);
  return ref ? normalizeHostedReviewBaseRef(ref) : null;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function findGitHubReviewForBranch(
  requestJson: RuntimeGetJson,
  input: HostedReviewForBranchParams,
  branch: string,
): Promise<HostedReviewInfo | null> {
  const linkedNumber =
    coercePositiveInt(input.linkedGitHubPR) ??
    coercePositiveInt(input.fallbackGitHubPR);
  const query = await providerQuery(input, input.worktree ?? input.worktreeId, {
    limit: "24",
  });
  const list = await requestJson<{ items: GitHubWorkItem[] }>(
    `/v1/providers/github/pulls?${query}`,
  ).catch(() => null);
  const item = list?.items?.find((candidate) =>
    linkedNumber
      ? candidate.number === linkedNumber
      : normalizeBranchName(candidate.branchName) === branch,
  );
  return item ? mapGitHubWorkItemToHostedReview(item) : null;
}

export async function createHostedReview(
  requestJson: RuntimePostJson,
  params: unknown,
): Promise<CreateHostedReviewResult> {
  const input = params as CreateHostedReviewParams;
  const projectId = readProjectId(input);
  const provider = readNonEmptyString(input.provider) ?? "unsupported";
  const base = readNonEmptyString(input.base) ?? "";
  const title = readNonEmptyString(input.title) ?? "";
  if (!projectId || !base || !title) {
    return {
      ok: false,
      code: "validation",
      error:
        "Create review failed: repository, base branch, and title are required.",
    };
  }
  const worktreeId = await resolveWorktreeId(
    projectId,
    readWorktreeSelector(input),
  );
  return requestJson<CreateHostedReviewResult>("/v1/providers/reviews", {
    method: "POST",
    timeoutMs: 60_000,
    body: {
      projectId,
      ...(worktreeId ? { worktreeId } : {}),
      provider,
      base,
      head: readNonEmptyString(input.head) ?? "",
      title,
      body: readStringValue(input.body) ?? "",
      draft: input.draft === true,
      useTemplate: input.useTemplate === true,
    },
  });
}

async function findGitLabReviewForBranch(
  requestJson: RuntimeGetJson,
  input: HostedReviewForBranchParams,
  branch: string,
): Promise<HostedReviewInfo | null> {
  const linkedNumber = coercePositiveInt(input.linkedGitLabMR);
  const result = await fetchGitLabMRs(requestJson, {
    ...input,
    state: "opened",
    perPage: 24,
    query: linkedNumber ? String(linkedNumber) : branch,
  }).catch(() => null);
  const item = result?.items.find((candidate) =>
    linkedNumber
      ? candidate.number === linkedNumber
      : normalizeBranchName(candidate.branchName) === branch,
  );
  return item ? mapGitLabWorkItemToHostedReview(item) : null;
}

function mapGitHubWorkItemToHostedReview(
  item: GitHubWorkItem,
): HostedReviewInfo {
  return {
    provider: "github",
    number: item.number,
    title: item.title,
    state: readHostedReviewState(item.state),
    url: item.url,
    status: "neutral",
    updatedAt: item.updatedAt,
    mergeable: "UNKNOWN",
    ...(item.headSha ? { headSha: item.headSha } : {}),
    ...(item.baseRefName ? { baseRefName: item.baseRefName } : {}),
  };
}

function mapGitLabWorkItemToHostedReview(
  item: GitLabWorkItem,
): HostedReviewInfo {
  return {
    provider: "gitlab",
    number: item.number,
    title: item.title,
    state: readHostedReviewState(item.state),
    url: item.url,
    status: "neutral",
    updatedAt: item.updatedAt,
    mergeable: "UNKNOWN",
    ...(item.baseRefName ? { baseRefName: item.baseRefName } : {}),
  };
}

function readHostedReviewState(value: string): HostedReviewInfo["state"] {
  if (value === "closed" || value === "merged" || value === "draft") {
    return value;
  }
  return "open";
}

function normalizeBranchName(value: unknown): string | null {
  const branch = readNonEmptyString(value);
  return branch?.replace(/^refs\/heads\//, "") ?? null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function providerQuery(
  selector: ProviderSelectorParams,
  worktreeSelector: unknown,
  extra: Record<string, string>,
): Promise<string> {
  const search = new URLSearchParams();
  const projectId = readProjectId(selector);
  if (projectId) {
    search.set("projectId", projectId);
  }
  const worktreeId = await resolveWorktreeId(projectId, worktreeSelector);
  if (worktreeId) {
    search.set("worktreeId", worktreeId);
  }
  for (const [key, value] of Object.entries(extra)) {
    search.set(key, value);
  }
  return search.toString();
}

function readProjectId(
  input: Pick<ProviderSelectorParams, "repo" | "repoId" | "projectId">,
): string | null {
  const raw =
    readNonEmptyString(input.repo) ??
    readNonEmptyString(input.repoId) ??
    readNonEmptyString(input.projectId);
  if (!raw) {
    return null;
  }
  return raw.startsWith("id:") ? raw.slice("id:".length) : raw;
}

function readWorktreeSelector(input: ProviderSelectorParams): unknown {
  const worktreePath = readNonEmptyString(input.worktreePath);
  return (
    input.worktree ??
    input.worktreeId ??
    (worktreePath ? `path:${worktreePath}` : null)
  );
}

async function resolveWorktreeId(
  projectId: string | null,
  selector: unknown,
): Promise<string | null> {
  const raw = readNonEmptyString(selector);
  if (!raw) {
    return null;
  }
  const direct = readRuntimeWorktreeSelectorId(raw);
  if (direct) {
    return direct;
  }
  if (!projectId) {
    return null;
  }
  const worktrees = await readWorktrees(projectId);
  const match = findWorktreeBySelector(worktrees, raw);
  return match?.id ?? null;
}

function readRuntimeWorktreeSelectorId(raw: string): string | null {
  if (raw.startsWith("id:worktree:")) {
    return raw.slice("id:worktree:".length);
  }
  if (raw.startsWith("worktree:")) {
    return raw.slice("worktree:".length);
  }
  if (raw.startsWith("id:")) {
    return raw.slice("id:".length);
  }
  return raw.includes(":") ? null : raw;
}

function findWorktreeBySelector(
  worktrees: Array<{
    id: string;
    path?: string;
    branch?: string;
    displayName?: string;
  }>,
  selector: string,
): { id: string } | null {
  if (selector.startsWith("path:")) {
    const path = selector.slice("path:".length);
    return worktrees.find((entry) => entry.path === path) ?? null;
  }
  if (selector.startsWith("branch:")) {
    const branch = selector.slice("branch:".length);
    return worktrees.find((entry) => entry.branch === branch) ?? null;
  }
  if (selector.startsWith("name:")) {
    const name = selector.slice("name:".length);
    return (
      worktrees.find(
        (entry) => entry.displayName === name || basename(entry.path) === name,
      ) ?? null
    );
  }
  return null;
}

function basename(path: string | undefined): string | null {
  if (!path) {
    return null;
  }
  return path.split(/[\\/]/).filter(Boolean).pop() ?? null;
}

function readStringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function coercePositiveInt(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
