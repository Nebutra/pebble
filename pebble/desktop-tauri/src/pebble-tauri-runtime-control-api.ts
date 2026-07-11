import { invoke } from "@tauri-apps/api/core";
import type { PreloadApi } from "../../../src/preload/api-types";
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
} from "../../../src/shared/protocol-version";
import type { RuntimeRpcResponse } from "../../../src/shared/runtime-rpc-envelope";
import type {
  RuntimeBrowserDriverState,
  RuntimeSyncWindowGraph,
  RuntimeSyncWindowGraphResult,
  RuntimeTerminalDriverState,
} from "../../../src/shared/runtime-types";
import type { PublicKnownRuntimeEnvironment } from "../../../src/shared/runtime-environments";
import { projectHostSetupProjectionFromRepos } from "../../../src/shared/project-host-setup-projection";
import { parsePebbleYaml } from "../../../src/shared/pebble-yaml";
import type { SetupScriptImportCandidate } from "../../../src/shared/setup-script-imports";
import { inspectSetupScriptImportCandidates } from "../../../src/shared/setup-script-imports";
import type {
  CreateHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewInfo,
} from "../../../src/shared/hosted-review";
import type { PebbleHooks } from "../../../src/shared/types";
import { PRODUCT_NAME } from "./product-brand";
import { warnUnmappedRuntimeMethod } from "./runtime-unmapped-method-warning";
import { callTauriAutomationRuntimeRpc } from "./tauri-automations-api";
import {
  getErrorMessage,
  getHostPlatform,
  hasTauriInternals,
  ensurePebbleRuntimeProcess,
  readPebbleStatusOrNull,
  requestRuntimeJson,
} from "./pebble-tauri-runtime-transport";
import {
  createRuntimeWorktreeResult,
  getRuntimeRepoId,
  persistRuntimeProjectSortOrder,
  persistRuntimeWorktreeSortOrder,
  readRuntimeWorktreeLineage,
  readRepos,
  readWorktrees,
  removeRuntimeWorktree,
  setRuntimeWorktreeMeta,
  toCreateWorktreeArgs,
} from "./pebble-tauri-workspace-runtime-api";
import { callTauriBrowserRuntimeRpc } from "./tauri-browser-runtime-rpc";
import { callTauriFileRuntimeRpc } from "./tauri-file-runtime-rpc";
import {
  callTauriFolderWorkspaceRuntimeRpc,
  callTauriProjectGroupRuntimeRpc,
} from "./tauri-folder-workspace-api";
import { callTauriGitRuntimeRpc } from "./tauri-git-runtime-rpc";
import {
  openTauriComputerUsePermissionSetup,
  readTauriComputerUsePermissionStatus,
} from "./tauri-computer-use-permissions-api";
import { subscribeTauriRuntimeEnvironment } from "./tauri-runtime-environment-subscription-api";
import { registerRuntimeSessionDriverConsumer } from "./tauri-runtime-session-driver-relay";
import { callTauriSessionTabsRuntimeRpc } from "./tauri-session-tabs-runtime-rpc";
import { emitTauriActivateWorktree } from "./tauri-settings-event-api";
import { callTauriTerminalRuntimeRpc } from "./tauri-terminal-runtime-rpc";
import {
  createHostedReview,
  fetchGitHubPRChecks,
  fetchGitLabMRs,
  fetchHostedReviewCreationEligibility,
  fetchHostedReviewForBranch,
  fetchReviewWorkItems,
} from "./tauri-provider-review-bridge";
import { readHostTerminalCapabilities } from "./host-terminal-capabilities";

const PEBBLE_RUNTIME_ID = "pebble-local";

type RuntimeProviderSubsystem = "browser" | "computer" | "emulator";
type RuntimeSubsystemName = RuntimeProviderSubsystem | "mobile-relay";

type TerminalFitOverrideSnapshot = {
  ptyId: string;
  mode: "mobile-fit";
  cols: number;
  rows: number;
};

type TerminalFitOverrideEvent = {
  ptyId: string;
  mode: "mobile-fit" | "desktop-fit";
  cols: number;
  rows: number;
};

type TerminalDriverSnapshot = {
  ptyId: string;
  driver: RuntimeTerminalDriverState;
};

type BrowserDriverSnapshot = {
  browserPageId: string;
  driver: RuntimeBrowserDriverState;
};

type TerminalDriverEvent = TerminalDriverSnapshot;
type BrowserDriverEvent = BrowserDriverSnapshot;

type RuntimeNativeProvider = {
  id: string;
  subsystem: RuntimeProviderSubsystem;
  name: string;
  status: "ready" | "running" | "degraded" | "error";
  capabilities: string[];
  message?: string;
  lastSeenAt: string;
};

type RuntimeSubsystemStatus = {
  name: RuntimeSubsystemName | string;
  status: string;
  configured: boolean;
  capabilities: string[];
  message?: string;
};

const terminalFitOverrides = new Map<
  string,
  Omit<TerminalFitOverrideSnapshot, "ptyId">
>();
const terminalDrivers = new Map<string, RuntimeTerminalDriverState>();
const browserDrivers = new Map<string, RuntimeBrowserDriverState>();
const terminalFitOverrideListeners = new Set<
  (event: TerminalFitOverrideEvent) => void
>();
const terminalDriverListeners = new Set<(event: TerminalDriverEvent) => void>();
const browserDriverListeners = new Set<(event: BrowserDriverEvent) => void>();

// Runtime session.driver events (mobile relay input takes the floor, desktop
// reclaims) feed the same driver map the renderer lock banner listens on.
registerRuntimeSessionDriverConsumer((sessionId, driver) =>
  setTerminalDriver(sessionId, driver),
);

export function createPebbleRuntimeApi(
  base: PreloadApi["runtime"],
): PreloadApi["runtime"] {
  return {
    ...base,
    syncWindowGraph: (graph) => readOrCreateRuntimeStatus(graph),
    getStatus: () => readOrCreateRuntimeStatus(),
    call: ({ method, params }) => callPebbleRuntimeMethod(method, params),
    getTerminalFitOverrides: () => Promise.resolve(readTerminalFitOverrides()),
    getTerminalDrivers: () => Promise.resolve(readTerminalDrivers()),
    getBrowserDrivers: () => Promise.resolve(readBrowserDrivers()),
    restoreTerminalFit: async (ptyId) => restoreTauriTerminalFit(ptyId),
    reclaimBrowserForDesktop: async (browserPageId) =>
      reclaimTauriBrowserForDesktop(browserPageId),
    onTerminalFitOverrideChanged: (callback) =>
      subscribeToSet(terminalFitOverrideListeners, callback),
    onTerminalDriverChanged: (callback) =>
      subscribeToSet(terminalDriverListeners, callback),
    onBrowserDriverChanged: (callback) =>
      subscribeToSet(browserDriverListeners, callback),
  };
}

export function createPebbleRuntimeEnvironmentsApi(
  base: PreloadApi["runtimeEnvironments"],
): PreloadApi["runtimeEnvironments"] {
  return {
    ...base,
    list: () =>
      hasTauriInternals()
        ? invoke<PublicKnownRuntimeEnvironment[]>("runtime_environments_list")
        : Promise.resolve([]),
    resolve: ({ selector }) =>
      invoke<PublicKnownRuntimeEnvironment>("runtime_environments_resolve", {
        input: { selector },
      }),
    getStatus: async () => okRuntimeRpc(await readOrCreateRuntimeStatus()),
    call: async ({ selector, method, params, timeoutMs }) => {
      try {
        return await invoke<RuntimeRpcResponse<unknown>>(
          "runtime_environments_call",
          {
            input: { selector, method, params, timeoutMs },
          },
        );
      } catch (error) {
        return failRuntimeRpc(
          "remote_runtime_unavailable",
          getErrorMessage(error),
        );
      }
    },
    addFromPairingCode: ({ name, pairingCode }) =>
      invoke<{ environment: PublicKnownRuntimeEnvironment }>(
        "runtime_environments_add_from_pairing_code",
        { input: { name, pairingCode } },
      ),
    remove: ({ selector }) =>
      invoke<{ removed: PublicKnownRuntimeEnvironment }>(
        "runtime_environments_remove",
        {
          input: { selector },
        },
      ),
    disconnect: ({ selector }) =>
      invoke<{ disconnected: PublicKnownRuntimeEnvironment }>(
        "runtime_environments_disconnect",
        {
          input: { selector },
        },
      ),
    subscribe: (args, callbacks) =>
      hasTauriInternals()
        ? subscribeTauriRuntimeEnvironment(args, callbacks)
        : base.subscribe(args, callbacks),
  };
}

// GET adapter for the provider-review bridge; ensures the runtime is up first,
// then a non-2xx (501 CLI-missing, 401 unauthenticated) throws so the dispatcher
// surfaces a failed RPC like Electron's provider load failures.
async function getProviderJson<T>(path: string): Promise<T> {
  await ensurePebbleRuntimeProcess();
  return requestRuntimeJson<T>(path, { method: "GET" });
}

async function callPebbleRuntimeMethod(
  method: string,
  params?: unknown,
): Promise<RuntimeRpcResponse<unknown>> {
  try {
    const browserResult = await callTauriBrowserRuntimeRpc(method, params);
    if (browserResult.handled) {
      return okRuntimeRpc(browserResult.result);
    }
    const terminalResult = await callTauriTerminalRuntimeRpc(method, params);
    if (terminalResult.handled) {
      return okRuntimeRpc(terminalResult.result);
    }
    const fileResult = await callTauriFileRuntimeRpc(method, params);
    if (fileResult.handled) {
      return okRuntimeRpc(fileResult.result);
    }
    const gitResult = await callTauriGitRuntimeRpc(method, params);
    if (gitResult.handled) {
      return okRuntimeRpc(gitResult.result);
    }
    const automationResult = await callTauriAutomationRuntimeRpc(
      method,
      params,
    );
    if (automationResult.handled) {
      return okRuntimeRpc(automationResult.result);
    }
    const sessionTabsResult = await callTauriSessionTabsRuntimeRpc(
      method,
      params,
    );
    if (sessionTabsResult.handled) {
      return okRuntimeRpc(sessionTabsResult.result);
    }
    switch (method) {
      case "status.get":
        return okRuntimeRpc(await readOrCreateRuntimeStatus());
      case "repo.list":
        return okRuntimeRpc({ repos: await readRepos() });
      case "repo.add":
        return okRuntimeRpc(await window.api.repos.add(toRepoAddArgs(params)));
      case "repo.create":
        return okRuntimeRpc(
          await window.api.repos.create(toRepoCreateArgs(params)),
        );
      case "repo.clone":
        return okRuntimeRpc({
          repo: await window.api.repos.clone(toRepoCloneArgs(params)),
        });
      case "repo.gitAvailable":
        return okRuntimeRpc({
          available: await window.api.repos.isGitAvailable(),
        });
      case "repo.update":
        return okRuntimeRpc({
          repo: await window.api.repos.update(toRepoUpdateArgs(params)),
        });
      case "repo.rm":
        await window.api.repos.remove({ repoId: requireRepoId(params) });
        return okRuntimeRpc({ removed: true });
      case "repo.reorder":
        return okRuntimeRpc(
          await persistRuntimeProjectSortOrder(toOrderedIds(params)),
        );
      case "repo.baseRefDefault":
        return okRuntimeRpc(
          await window.api.repos.getBaseRefDefault({
            repoId: requireRepoId(params),
          }),
        );
      case "repo.searchRefs":
        return okRuntimeRpc(await searchRuntimeRepoRefs(params));
      case "repo.hooksCheck":
        return okRuntimeRpc(await readRuntimeRepoHooksCheck(params));
      case "repo.setupScriptImports":
        return okRuntimeRpc(await inspectRuntimeRepoSetupScriptImports(params));
      case "repo.issueCommandRead":
        return okRuntimeRpc(await readRuntimeRepoIssueCommand(params));
      case "repo.issueCommandWrite":
        return okRuntimeRpc(await writeRuntimeRepoIssueCommand(params));
      case "project.list":
        return okRuntimeRpc({
          projects: projectHostSetupProjectionFromRepos(await readRepos())
            .projects,
        });
      case "projectHostSetup.list":
        return okRuntimeRpc({
          setups: projectHostSetupProjectionFromRepos(await readRepos()).setups,
        });
      case "projectGroup.list":
      case "projectGroup.create":
      case "projectGroup.update":
      case "projectGroup.delete":
      case "projectGroup.moveProject": {
        const projectGroupResult = await callTauriProjectGroupRuntimeRpc(
          method,
          params,
        );
        if (projectGroupResult.handled) {
          return okRuntimeRpc(projectGroupResult.result);
        }
        return failRuntimeRpc(
          "method_not_available",
          `${PRODUCT_NAME} runtime method is not mapped: ${method}`,
        );
      }
      case "projectGroup.scanNested":
      case "projectGroup.importNested": {
        const projectGroupResult = await callTauriProjectGroupRuntimeRpc(
          method,
          params,
        );
        if (projectGroupResult.handled) {
          return okRuntimeRpc(projectGroupResult.result);
        }
        return failRuntimeRpc(
          "method_not_available",
          `${PRODUCT_NAME} runtime method is not mapped: ${method}`,
        );
      }
      case "folderWorkspace.list":
      case "folderWorkspace.create":
      case "folderWorkspace.update":
      case "folderWorkspace.delete":
      case "folderWorkspace.getPathStatus": {
        const folderWorkspaceResult = await callTauriFolderWorkspaceRuntimeRpc(
          method,
          params,
        );
        if (folderWorkspaceResult.handled) {
          return okRuntimeRpc(folderWorkspaceResult.result);
        }
        return failRuntimeRpc(
          "method_not_available",
          `${PRODUCT_NAME} runtime method is not mapped: ${method}`,
        );
      }
      case "hostedReview.forBranch":
        return okRuntimeRpc(await readTauriHostedReviewForBranch(params));
      case "hostedReview.getCreationEligibility":
        return okRuntimeRpc(
          await readTauriHostedReviewCreationEligibility(params),
        );
      case "hostedReview.create":
        return okRuntimeRpc(await createTauriHostedReview(params));
      case "provider.list":
      case "providers.list":
      case "nativeProvider.list":
        return okRuntimeRpc({
          providers: await readRuntimeNativeProviders(params),
        });
      case "provider.status":
      case "subsystem.status":
        return okRuntimeRpc({
          status: await readRuntimeSubsystemStatus(params),
        });
      case "provider.register":
      case "nativeProvider.register":
        return okRuntimeRpc({
          provider: await registerRuntimeNativeProvider(params),
        });
      case "host.platform": {
        const capabilities =
          await readHostTerminalCapabilities(requestRuntimeJson);
        return okRuntimeRpc({ platform: capabilities.hostPlatform });
      }
      case "host.wsl.isAvailable": {
        const capabilities =
          await readHostTerminalCapabilities(requestRuntimeJson);
        return okRuntimeRpc(capabilities.wslAvailable);
      }
      case "host.wsl.listDistros": {
        const capabilities =
          await readHostTerminalCapabilities(requestRuntimeJson);
        return okRuntimeRpc(capabilities.wslDistros);
      }
      case "host.pwsh.isAvailable": {
        const capabilities =
          await readHostTerminalCapabilities(requestRuntimeJson);
        return okRuntimeRpc(capabilities.pwshAvailable);
      }
      case "host.gitBash.isAvailable": {
        const capabilities =
          await readHostTerminalCapabilities(requestRuntimeJson);
        return okRuntimeRpc(capabilities.gitBashAvailable);
      }
      case "computer.permissionsStatus":
        return okRuntimeRpc(await readTauriComputerUsePermissionStatus());
      case "computer.permissions":
        return okRuntimeRpc(
          await openTauriComputerUsePermissionSetup(
            readComputerPermissionsArgs(params),
          ),
        );
      case "worktree.list":
        return okRuntimeRpc({
          worktrees: await readWorktrees(getRuntimeRepoId(params)),
        });
      case "worktree.activate":
        return okRuntimeRpc(await activateTauriWorktree(params));
      case "worktree.detectedList":
        return okRuntimeRpc(
          await window.api.worktrees.listDetected({
            repoId: requireRepoId(params),
          }),
        );
      case "worktree.lineageList":
        return okRuntimeRpc(await readRuntimeWorktreeLineage());
      case "worktree.create":
        return okRuntimeRpc(
          await createRuntimeWorktreeResult(toCreateWorktreeArgs(params)),
        );
      case "worktree.prefetchCreateBase":
        await window.api.worktrees.prefetchCreateBase(
          toWorktreePrefetchArgs(params),
        );
        return okRuntimeRpc(null);
      case "worktree.resolvePrBase":
        return okRuntimeRpc(
          await window.api.worktrees.resolvePrBase(
            toWorktreeResolvePrArgs(params),
          ),
        );
      case "worktree.resolveMrBase":
        return okRuntimeRpc(
          await window.api.worktrees.resolveMrBase(
            toWorktreeResolveMrArgs(params),
          ),
        );
      case "worktree.set":
        return okRuntimeRpc({ worktree: await setRuntimeWorktreeMeta(params) });
      case "worktree.persistSortOrder":
        await persistRuntimeWorktreeSortOrder(toOrderedIds(params));
        return okRuntimeRpc({ status: "applied" });
      case "worktree.rm":
      case "worktree.remove":
        return okRuntimeRpc({
          preservedBranch: await removeRuntimeWorktree(params),
        });
      case "worktree.forceDeleteBranch":
        return okRuntimeRpc(
          await window.api.worktrees.forceDeletePreservedBranch(
            toForceDeleteBranchArgs(params),
          ),
        );
      case "preflight.check":
        return okRuntimeRpc(await window.api.preflight.check());
      case "preflight.detectAgents":
        return okRuntimeRpc(await window.api.preflight.detectAgents());
      case "preflight.refreshAgents":
        return okRuntimeRpc(await window.api.preflight.refreshAgents());
      case "preflight.detectRemoteAgents":
        return okRuntimeRpc(
          await window.api.preflight.detectRemoteAgents(
            toConnectionParams(params),
          ),
        );
      case "preflight.detectRemoteWindowsTerminalCapabilities":
        return okRuntimeRpc(
          await window.api.preflight.detectRemoteWindowsTerminalCapabilities(
            toConnectionParams(params),
          ),
        );
      case "github.prChecks":
        return okRuntimeRpc(await fetchGitHubPRChecks(getProviderJson, params));
      case "gitlab.listMRs":
        return okRuntimeRpc(await fetchGitLabMRs(getProviderJson, params));
      // Provider-neutral list for the REST-backed providers (bitbucket,
      // azure-devops, gitea); params carry the provider discriminator.
      case "providerReview.listWorkItems":
        return okRuntimeRpc(
          await fetchReviewWorkItems(getProviderJson, params),
        );
      default:
        warnUnmappedRuntimeMethod(method);
        return failRuntimeRpc(
          "method_not_available",
          `${PRODUCT_NAME} runtime method is not mapped: ${method}`,
        );
    }
  } catch (error) {
    return failRuntimeRpc("runtime_error", getErrorMessage(error));
  }
}

async function readRuntimeNativeProviders(
  params: unknown,
): Promise<RuntimeNativeProvider[]> {
  await ensurePebbleRuntimeProcess();
  const subsystem = readProviderSubsystem(params);
  const query = subsystem ? `?subsystem=${encodeURIComponent(subsystem)}` : "";
  return requestRuntimeJson<RuntimeNativeProvider[]>(`/v1/providers${query}`, {
    method: "GET",
  });
}

async function readRuntimeSubsystemStatus(
  params: unknown,
): Promise<RuntimeSubsystemStatus> {
  await ensurePebbleRuntimeProcess();
  const subsystem = readSubsystemName(params);
  return requestRuntimeJson<RuntimeSubsystemStatus>(`/v1/${subsystem}/status`, {
    method: "GET",
  });
}

async function registerRuntimeNativeProvider(
  params: unknown,
): Promise<RuntimeNativeProvider> {
  await ensurePebbleRuntimeProcess();
  const input = readProviderObject(params);
  return requestRuntimeJson<RuntimeNativeProvider>("/v1/providers", {
    method: "POST",
    body: {
      id: readProviderOptionalString(input.id),
      subsystem: readProviderSubsystem(input) ?? "browser",
      name: readProviderRequiredString(input.name, "native provider name"),
      status: readProviderOptionalString(input.status),
      capabilities: readProviderStringList(input.capabilities),
      message: readProviderOptionalString(input.message),
    },
  });
}

async function readTauriHostedReviewForBranch(
  params: unknown,
): Promise<HostedReviewInfo | null> {
  await ensurePebbleRuntimeProcess();
  return fetchHostedReviewForBranch(getProviderJson, params);
}

async function readTauriHostedReviewCreationEligibility(
  params: unknown,
): Promise<HostedReviewCreationEligibility> {
  await ensurePebbleRuntimeProcess();
  return fetchHostedReviewCreationEligibility(getProviderJson, params);
}

async function createTauriHostedReview(
  params: unknown,
): Promise<CreateHostedReviewResult> {
  await ensurePebbleRuntimeProcess();
  return createHostedReview(requestRuntimeJson, params);
}

async function readOrCreateRuntimeStatus(
  graph?: RuntimeSyncWindowGraph,
): Promise<RuntimeSyncWindowGraphResult> {
  const status = await readPebbleStatusOrNull();
  return {
    runtimeId: PEBBLE_RUNTIME_ID,
    rendererGraphEpoch: Date.now(),
    graphStatus: status ? "ready" : "unavailable",
    authoritativeWindowId: null,
    liveTabCount: graph?.tabs.length ?? 0,
    liveLeafCount: graph?.leaves.length ?? 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
    capabilities: [...RUNTIME_CAPABILITIES],
    hostPlatform: getHostPlatform(),
    remoteControl: null,
    agentOrchestrationByPaneKey: {},
  };
}

function okRuntimeRpc<TResult>(result: TResult): RuntimeRpcResponse<TResult> {
  return {
    id: crypto.randomUUID(),
    ok: true,
    result,
    _meta: { runtimeId: PEBBLE_RUNTIME_ID },
  };
}

function failRuntimeRpc(
  code: string,
  message: string,
): RuntimeRpcResponse<unknown> {
  return {
    id: crypto.randomUUID(),
    ok: false,
    error: { code, message },
    _meta: { runtimeId: PEBBLE_RUNTIME_ID },
  };
}

function readSubsystemName(params: unknown): RuntimeSubsystemName {
  const input = readProviderObject(params);
  const value =
    readProviderOptionalString(input.name) ??
    readProviderOptionalString(input.subsystem) ??
    readProviderOptionalString(input.kind) ??
    "browser";
  if (
    value === "browser" ||
    value === "computer" ||
    value === "emulator" ||
    value === "mobile-relay"
  ) {
    return value;
  }
  throw new Error(`Unsupported runtime subsystem: ${value}`);
}

function readProviderSubsystem(
  params: unknown,
): RuntimeProviderSubsystem | null {
  const input = readProviderObject(params);
  const value =
    readProviderOptionalString(input.subsystem) ??
    readProviderOptionalString(input.name) ??
    readProviderOptionalString(input.kind);
  if (!value) {
    return null;
  }
  if (value === "browser" || value === "computer" || value === "emulator") {
    return value;
  }
  throw new Error(`Unsupported native provider subsystem: ${value}`);
}

function readProviderObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function readProviderOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readProviderRequiredString(value: unknown, label: string): string {
  const result = readProviderOptionalString(value);
  if (!result) {
    throw new Error(`${label} is required`);
  }
  return result;
}

function readProviderStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
}

function readTerminalFitOverrides(): TerminalFitOverrideSnapshot[] {
  return Array.from(terminalFitOverrides.entries()).map(
    ([ptyId, override]) => ({
      ptyId,
      ...override,
    }),
  );
}

function readTerminalDrivers(): TerminalDriverSnapshot[] {
  return Array.from(terminalDrivers.entries()).map(([ptyId, driver]) => ({
    ptyId,
    driver,
  }));
}

function readBrowserDrivers(): BrowserDriverSnapshot[] {
  return Array.from(browserDrivers.entries()).map(
    ([browserPageId, driver]) => ({
      browserPageId,
      driver,
    }),
  );
}

function getTerminalDriver(ptyId: string): RuntimeTerminalDriverState {
  return terminalDrivers.get(ptyId) ?? { kind: "idle" };
}

function setTerminalDriver(
  ptyId: string,
  driver: RuntimeTerminalDriverState,
): void {
  const previous = getTerminalDriver(ptyId);
  if (sameRuntimeDriver(previous, driver)) {
    return;
  }
  if (driver.kind === "idle") {
    terminalDrivers.delete(ptyId);
  } else {
    terminalDrivers.set(ptyId, driver);
  }
  emitToSet(terminalDriverListeners, { ptyId, driver });
}

function getBrowserDriver(browserPageId: string): RuntimeBrowserDriverState {
  return browserDrivers.get(browserPageId) ?? { kind: "idle" };
}

function setBrowserDriver(
  browserPageId: string,
  driver: RuntimeBrowserDriverState,
): void {
  const previous = getBrowserDriver(browserPageId);
  if (sameRuntimeDriver(previous, driver)) {
    return;
  }
  if (driver.kind === "idle") {
    browserDrivers.delete(browserPageId);
  } else {
    browserDrivers.set(browserPageId, driver);
  }
  emitToSet(browserDriverListeners, { browserPageId, driver });
}

function sameRuntimeDriver(
  left: RuntimeTerminalDriverState | RuntimeBrowserDriverState,
  right: RuntimeTerminalDriverState | RuntimeBrowserDriverState,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "mobile" && right.kind === "mobile") {
    return left.clientId === right.clientId;
  }
  return true;
}

function emitTerminalFitOverride(event: TerminalFitOverrideEvent): void {
  if (event.mode === "mobile-fit") {
    terminalFitOverrides.set(event.ptyId, {
      mode: "mobile-fit",
      cols: event.cols,
      rows: event.rows,
    });
  } else {
    terminalFitOverrides.delete(event.ptyId);
  }
  emitToSet(terminalFitOverrideListeners, event);
}

async function restoreTauriTerminalFit(
  ptyId: string,
): Promise<{ restored: boolean }> {
  const hadFitOverride = terminalFitOverrides.has(ptyId);
  const previousDriver = getTerminalDriver(ptyId);
  if (hadFitOverride) {
    emitTerminalFitOverride({ ptyId, mode: "desktop-fit", cols: 0, rows: 0 });
  }
  // Why: the runtime enforces the presence lock on writes, so a desktop
  // take-back must flip the runtime-side driver too, not only the mirror.
  await requestRuntimeJson(`/v1/sessions/${encodeURIComponent(ptyId)}/reclaim-desktop`, {
    method: "POST",
    timeoutMs: 5000,
  }).catch(() => undefined);
  setTerminalDriver(ptyId, { kind: "desktop" });
  return { restored: hadFitOverride || previousDriver.kind === "mobile" };
}

async function reclaimTauriBrowserForDesktop(
  browserPageId: string,
): Promise<{ reclaimed: boolean }> {
  const previousDriver = getBrowserDriver(browserPageId);
  // Why: mirrors Electron reclaimBrowserForDesktop so the lock overlay can
  // unmount immediately when desktop takes the browser back.
  setBrowserDriver(browserPageId, { kind: "desktop" });
  return { reclaimed: previousDriver.kind === "mobile" };
}

function subscribeToSet<TEvent>(
  listeners: Set<(event: TEvent) => void>,
  callback: (event: TEvent) => void,
): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function emitToSet<TEvent>(
  listeners: Set<(event: TEvent) => void>,
  event: TEvent,
): void {
  for (const listener of listeners) {
    listener(event);
  }
}

function readComputerPermissionsArgs(
  params: unknown,
): Parameters<typeof openTauriComputerUsePermissionSetup>[0] {
  const id = readRuntimeObject(params).id;
  if (id === "accessibility" || id === "screenshots") {
    return { id };
  }
  return {};
}

function toRepoAddArgs(
  params: unknown,
): Parameters<PreloadApi["repos"]["add"]>[0] {
  const input = readRuntimeObject(params);
  return {
    path: readRuntimeRequiredString(input.path, "repo path"),
    kind: readRuntimeString(input.kind) === "folder" ? "folder" : "git",
  };
}

function toRepoCreateArgs(
  params: unknown,
): Parameters<PreloadApi["repos"]["create"]>[0] {
  const input = readRuntimeObject(params);
  return {
    parentPath: readRuntimeRequiredString(input.parentPath, "parent path"),
    name: readRuntimeRequiredString(input.name, "repo name"),
    kind: readRuntimeString(input.kind) === "folder" ? "folder" : "git",
  };
}

function toRepoCloneArgs(
  params: unknown,
): Parameters<PreloadApi["repos"]["clone"]>[0] {
  const input = readRuntimeObject(params);
  return {
    url: readRuntimeRequiredString(input.url, "clone url"),
    destination: readRuntimeRequiredString(
      input.destination,
      "clone destination",
    ),
  };
}

function toRepoUpdateArgs(
  params: unknown,
): Parameters<PreloadApi["repos"]["update"]>[0] {
  const input = readRuntimeObject(params);
  return {
    repoId: requireRepoId(params),
    updates: readRuntimeObject(input.updates),
  };
}

async function searchRuntimeRepoRefs(params: unknown): Promise<{
  refs: string[];
  refDetails: { refName: string; localBranchName: string }[];
  truncated: boolean;
}> {
  const input = readRuntimeObject(params);
  const repoId = requireRepoId(params);
  const query = readRuntimeString(input.query) ?? "";
  const limit = readRuntimeNumber(input.limit);
  const [refs, refDetails] = await Promise.all([
    window.api.repos.searchBaseRefs({ repoId, query, limit }),
    window.api.repos.searchBaseRefDetails({ repoId, query, limit }),
  ]);
  return { refs, refDetails, truncated: false };
}

async function readRuntimeRepoHooksCheck(params: unknown): Promise<{
  status: "ok" | "error";
  hasHooks: boolean;
  hooks: PebbleHooks | null;
  mayNeedUpdate: boolean;
}> {
  const repoId = requireRepoId(params);
  const repo = (await readRepos()).find((entry) => entry.id === repoId);
  if (!repo || repo.kind === "folder") {
    return { status: "ok", hasHooks: false, hooks: null, mayNeedUpdate: false };
  }
  if (repo.connectionId) {
    return {
      status: "error",
      hasHooks: false,
      hooks: null,
      mayNeedUpdate: false,
    };
  }
  const content = await readRuntimeRepoTextFile(repoId, "pebble.yaml");
  if (content === null) {
    return { status: "ok", hasHooks: false, hooks: null, mayNeedUpdate: false };
  }
  const hooks = parsePebbleYaml(content);
  return {
    status: "ok",
    hasHooks: true,
    hooks,
    mayNeedUpdate: hooks === null && hasUnrecognizedPebbleYamlKeys(content),
  };
}

async function inspectRuntimeRepoSetupScriptImports(
  params: unknown,
): Promise<SetupScriptImportCandidate[]> {
  const repoId = requireRepoId(params);
  const repo = (await readRepos()).find((entry) => entry.id === repoId);
  if (!repo || repo.kind === "folder" || repo.connectionId) {
    return [];
  }
  return inspectSetupScriptImportCandidates((relativePath) =>
    readRuntimeRepoTextFile(repoId, relativePath),
  );
}

function hasUnrecognizedPebbleYamlKeys(content: string): boolean {
  const recognized = new Set([
    "scripts",
    "issueCommand",
    "defaultTabs",
    "environmentRecipes",
  ]);
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(\s|$)/);
    if (match && !recognized.has(match[1])) {
      return true;
    }
  }
  return false;
}

async function readRuntimeRepoIssueCommand(params: unknown): Promise<{
  status: "ok" | "error";
  localContent: string | null;
  sharedContent: string | null;
  effectiveContent: string | null;
  localFilePath: string;
  source: "local" | "shared" | "none";
}> {
  const repoId = requireRepoId(params);
  const repo = (await readRepos()).find((entry) => entry.id === repoId);
  if (!repo || repo.kind === "folder") {
    return {
      status: "ok",
      localContent: null,
      sharedContent: null,
      effectiveContent: null,
      localFilePath: "",
      source: "none",
    };
  }
  if (repo.connectionId) {
    return {
      status: "error",
      localContent: null,
      sharedContent: null,
      effectiveContent: null,
      localFilePath: "",
      source: "none",
    };
  }
  const localFilePath = joinRuntimeControlPath(
    repo.path,
    ".pebble/issue-command",
  );
  const localContent =
    (await readRuntimeRepoTextFile(repoId, ".pebble/issue-command"))?.trim() ||
    null;
  const sharedContent =
    parsePebbleYaml(
      (await readRuntimeRepoTextFile(repoId, "pebble.yaml")) ?? "",
    )?.issueCommand?.trim() || null;
  const effectiveContent = localContent ?? sharedContent;
  return {
    status: "ok",
    localContent,
    sharedContent,
    effectiveContent,
    localFilePath,
    source: localContent ? "local" : sharedContent ? "shared" : "none",
  };
}

async function readRuntimeRepoTextFile(
  repoId: string,
  filePath: string,
): Promise<string | null> {
  return requestRuntimeJson<{ content: string }>(
    "/v1/files/read?" +
      new URLSearchParams({ projectId: repoId, path: filePath }).toString(),
    { method: "GET", timeoutMs: 3000 },
  )
    .then((result) => result.content)
    .catch(() => null);
}

async function writeRuntimeRepoIssueCommand(
  params: unknown,
): Promise<{ ok: true }> {
  const input = readRuntimeObject(params);
  await requestRuntimeJson("/v1/files/write", {
    method: "POST",
    timeoutMs: 5000,
    body: {
      projectId: requireRepoId(params),
      path: ".pebble/issue-command",
      content: readRuntimeRawString(input.content) ?? "",
      createDirs: true,
    },
  });
  return { ok: true };
}

function toWorktreePrefetchArgs(
  params: unknown,
): Parameters<PreloadApi["worktrees"]["prefetchCreateBase"]>[0] {
  const input = readRuntimeObject(params);
  return {
    repoId: requireRepoId(params),
    baseBranch: readRuntimeString(input.baseBranch) ?? undefined,
  };
}

function toWorktreeResolvePrArgs(
  params: unknown,
): Parameters<PreloadApi["worktrees"]["resolvePrBase"]>[0] {
  const input = readRuntimeObject(params);
  return {
    repoId: requireRepoId(params),
    prNumber: readRuntimeNumber(input.prNumber) ?? 0,
    headRefName: readRuntimeString(input.headRefName) ?? "",
    baseRefName: readRuntimeString(input.baseRefName) ?? "",
    isCrossRepository: input.isCrossRepository === true,
  };
}

function toWorktreeResolveMrArgs(
  params: unknown,
): Parameters<PreloadApi["worktrees"]["resolveMrBase"]>[0] {
  const input = readRuntimeObject(params);
  return {
    repoId: requireRepoId(params),
    mrIid: readRuntimeNumber(input.mrIid) ?? 0,
    sourceBranch: readRuntimeString(input.sourceBranch) ?? "",
    targetBranch: readRuntimeString(input.targetBranch) ?? "",
    isCrossRepository: input.isCrossRepository === true,
  };
}

function toForceDeleteBranchArgs(
  params: unknown,
): Parameters<PreloadApi["worktrees"]["forceDeletePreservedBranch"]>[0] {
  const input = readRuntimeObject(params);
  return {
    worktreeId: requireWorktreeId(params),
    branchName: readRuntimeRequiredString(input.branchName, "branch name"),
    expectedHead: readRuntimeRequiredString(
      input.expectedHead,
      "expected branch head",
    ),
  };
}

async function activateTauriWorktree(params: unknown): Promise<{
  repoId: string;
  worktreeId: string;
  activated: true;
}> {
  const worktreeId = requireWorktreeId(params);
  const worktree = (await readWorktrees()).find(
    (entry) => entry.id === worktreeId,
  );
  if (!worktree) {
    throw new Error(`Worktree not found: ${worktreeId}`);
  }
  emitTauriActivateWorktree({
    repoId: worktree.repoId,
    worktreeId,
  });
  return {
    repoId: worktree.repoId,
    worktreeId,
    activated: true,
  };
}

function requireRepoId(params: unknown): string {
  const repoId = getRuntimeRepoId(params);
  if (!repoId) {
    throw new Error("Missing repo id");
  }
  return repoId;
}

function requireWorktreeId(params: unknown): string {
  const input = readRuntimeObject(params);
  const nested = readRuntimeObject(input.worktree);
  const value =
    readRuntimeString(input.worktreeId) ??
    readRuntimeString(input.worktree) ??
    readRuntimeString(nested.id) ??
    readRuntimeString(nested.worktreeId);
  if (!value) {
    throw new Error("Missing worktree id");
  }
  if (value.startsWith("id:worktree:")) {
    return value.slice("id:worktree:".length);
  }
  if (value.startsWith("worktree:")) {
    return value.slice("worktree:".length);
  }
  return value.startsWith("id:") ? value.slice("id:".length) : value;
}

function joinRuntimeControlPath(base: string, child: string): string {
  if (!base) {
    return child;
  }
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return base.endsWith("/") || base.endsWith("\\")
    ? `${base}${child}`
    : `${base}${separator}${child}`;
}

function readRuntimeObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function readRuntimeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readRuntimeRawString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readRuntimeRequiredString(value: unknown, label: string): string {
  const result = readRuntimeString(value);
  if (!result) {
    throw new Error(`${label} is required`);
  }
  return result;
}

function readRuntimeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function toConnectionParams(params: unknown): { connectionId: string } {
  const connectionId =
    typeof params === "object" && params !== null && "connectionId" in params
      ? String(params.connectionId)
      : "";
  return { connectionId };
}

function toOrderedIds(params: unknown): string[] {
  if (typeof params !== "object" || params === null) {
    return [];
  }
  const orderedIds = (params as Record<string, unknown>).orderedIds;
  return Array.isArray(orderedIds)
    ? orderedIds.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      )
    : [];
}

function noopUnsubscribe(): void {}
