import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')

const checks = [
  {
    name: 'Tauri renderer imports the root React app',
    file: 'pebble/desktop-tauri/src/main.tsx',
    expect: (text) =>
      /import\s+App\s+from\s+['"]@\/App['"]/.test(text) &&
      text.includes("import { installTauriWindowApi } from './tauri-window-api'") &&
      text.includes('installTauriWindowApi()') &&
      text.includes("import { installTauriSettingsEventApi } from './tauri-settings-event-api'") &&
      text.includes('installTauriSettingsEventApi()') &&
      text.includes("import { installTauriMenuApi } from './tauri-menu-api'") &&
      text.includes('installTauriMenuApi()') &&
      text.includes("import { installTauriAgentStatusApi } from './tauri-agent-status-api'") &&
      text.includes('installTauriAgentStatusApi()') &&
      text.includes("import { installTauriRuntimePtyApi } from './tauri-runtime-pty-api'") &&
      text.includes('installTauriRuntimePtyApi()') &&
      text.includes("import { installTauriUpdaterApi } from './tauri-updater-api'") &&
      text.includes('installTauriUpdaterApi()') &&
      text.includes(
        "import { installTauriBrowserRuntimeApi } from './tauri-browser-runtime-api'"
      ) &&
      text.includes('installTauriBrowserRuntimeApi()') &&
      text.includes(
        "import { installTauriDevEducationSuppression } from './tauri-dev-education-suppression'"
      ) &&
      text.includes('installTauriDevEducationSuppression()') &&
      text.includes("import { installTauriShellApi } from './tauri-shell-api'") &&
      text.includes('installTauriShellApi()') &&
      text.includes("import { installTauriDeepLinkApi } from './tauri-deep-link-api'") &&
      text.includes('installTauriDeepLinkApi()')
  },
  {
    name: 'Tauri dev bootstrap suppresses first-run education surfaces like Electron dev',
    file: 'pebble/desktop-tauri/src/tauri-dev-education-suppression.ts',
    expect: (text) =>
      text.includes('installTauriDevEducationSuppression') &&
      text.includes('FEATURE_TIP_IDS') &&
      text.includes('CONTEXTUAL_TOUR_IDS') &&
      text.includes('FEATURE_INTERACTION_IDS') &&
      text.includes('ONBOARDING_FINAL_STEP') &&
      text.includes('ONBOARDING_FLOW_VERSION') &&
      text.includes('featureTipsSeenIds') &&
      text.includes('contextualToursAutoEligible: false')
  },
  {
    name: 'Tauri preload installs the web-compatible API bridge',
    file: 'pebble/desktop-tauri/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes("import { installWebPreloadApi } from '@/web/web-preload-api'") &&
      text.includes("from './pebble-tauri-runtime-control-api'") &&
      text.includes("from './tauri-crash-reports-api'") &&
      text.includes("from './tauri-computer-use-permissions-api'") &&
      text.includes("from './tauri-diagnostics-api'") &&
      text.includes("from './tauri-file-watch-api'") &&
      text.includes("from './tauri-folder-workspace-api'") &&
      text.includes("from './tauri-mobile-runtime-api'") &&
      text.includes("from './tauri-automations-api'") &&
      text.includes("from './tauri-preflight-agent-api'") &&
      text.includes('createPebbleRuntimeEnvironmentsApi(api.runtimeEnvironments)') &&
      text.includes('createPebbleAutomationsApi(api.automations)') &&
      text.includes('createPebbleCrashReportsApi(api.crashReports)') &&
      text.includes('createPebbleComputerUsePermissionsApi(api.computerUsePermissions)') &&
      text.includes('createPebbleDiagnosticsApi(api.diagnostics)') &&
      text.includes('createPebbleFileWatchApi(api.fs)') &&
      text.includes('createPebbleProjectGroupsApi(api.projectGroups)') &&
      text.includes('createPebbleFolderWorkspacesApi(api.folderWorkspaces)') &&
      text.includes('createPebbleHooksApi(api.hooks)') &&
      text.includes('createPebbleMobileApi(api.mobile)') &&
      text.includes('detectTauriAgents()') &&
      text.includes('refreshTauriAgents()') &&
      text.includes('waitForTauriStartupServices') &&
      text.includes('recordTauriStartupDiagnostic') &&
      text.includes('detectRemoteAgents: async ({ connectionId })') &&
      text.includes("callRuntimeEnvironmentResult(connectionId, 'preflight.detectAgents')") &&
      text.includes("'preflight.detectRemoteWindowsTerminalCapabilities'") &&
      text.includes('installWebPreloadApi()') &&
      text.includes('void ensurePebbleRuntimeProcess()')
  },
  {
    name: 'Tauri computer-use permissions API calls native helper commands',
    file: 'pebble/desktop-tauri/src/tauri-computer-use-permissions-api.ts',
    expect: (text) =>
      text.includes('export function createPebbleComputerUsePermissionsApi') &&
      text.includes("'computer_permissions_status'") &&
      text.includes("'computer_permissions_open'") &&
      text.includes("'computer_permissions_reset'") &&
      text.includes('ComputerUsePermissionStatusResult') &&
      text.includes('ComputerUsePermissionSetupResult') &&
      text.includes('ComputerUsePermissionResetResult')
  },
  {
    name: 'Tauri mobile API maps runtime access grants to Go mobile relay pairings',
    file: 'pebble/desktop-tauri/src/tauri-mobile-runtime-api.ts',
    expect: (text) =>
      text.includes('export function createPebbleMobileApi') &&
      text.includes("'/v1/mobile-relay/pairings'") &&
      text.includes('listRuntimeAccessGrants') &&
      text.includes('revokeRuntimeAccess') &&
      text.includes('listDevices') &&
      text.includes('revokeDevice') &&
      text.includes('mapRuntimePairingToGrant') &&
      text.includes('mapRuntimePairingToDevice') &&
      !text.includes('Promise.resolve({ grants: [] })') &&
      !text.includes('Promise.resolve({ revoked: false })')
  },
  {
    name: 'Tauri speech API exposes catalog and explicit unavailable states',
    file: 'pebble/desktop-tauri/src/tauri-speech-api.ts',
    expect: (text) =>
      text.includes("import { SPEECH_MODEL_CATALOG } from '../../../src/main/speech/model-catalog'") &&
      text.includes('getUnavailableModelStates') &&
      text.includes('status: \'error\'') &&
      text.includes('subscribeSpeechEvent') &&
      text.includes('emitSpeechEvent') &&
      text.includes("emitSpeechEvent('stopped', { sessionId })") &&
      !text.includes('getCatalog: () => Promise.resolve([])') &&
      !text.includes('getModelStates: () => Promise.resolve([])') &&
      !text.includes('onPartialTranscript: () => noopUnsubscribe')
  },
  {
    name: 'Tauri automations API bridges the renderer surface to Go runtime storage',
    file: 'pebble/desktop-tauri/src/tauri-automations-api.ts',
    expect: (text) =>
      text.includes('export function createPebbleAutomationsApi') &&
      text.includes('export async function callTauriAutomationRuntimeRpc') &&
      text.includes("case 'automation.list'") &&
      text.includes("case 'automation.create'") &&
      text.includes("case 'automation.runNow'") &&
      text.includes("'/v1/automations'") &&
      text.includes("`/v1/automations/${encodeURIComponent(id)}/runs`") &&
      text.includes('mapRuntimeAutomation(response)') &&
      text.includes('mapRuntimeAutomationRun(run, automation)') &&
      text.includes('readTauriAutomationRunResult') &&
      text.includes('External automation managers are not wired in Tauri yet.') &&
      !text.includes('list: () => Promise.resolve([])') &&
      !text.includes('runNow: () => Promise.resolve')
  },
  {
    name: 'Tauri automation runtime mapping preserves Electron automation metadata',
    file: 'pebble/desktop-tauri/src/tauri-automation-runtime-mapping.ts',
    expect: (text) =>
      text.includes('const AUTOMATION_PAYLOAD_KEY = \'pebbleAutomation\'') &&
      text.includes('toRuntimeCreateAutomationRequest') &&
      text.includes('toRuntimeUpdateAutomationRequest') &&
      text.includes('mapRuntimeAutomation') &&
      text.includes('mapRuntimeAutomationRun') &&
      text.includes('nextAutomationOccurrenceAfter') &&
      text.includes("kind: 'manual'") &&
      text.includes("kind: 'createTask'") &&
      text.includes('readSchedulerOwner') &&
      text.includes('Runtime automation completed:')
  },
  {
    name: 'Tauri automations API tests cover runtime-backed list, create, run, and RPC',
    file: 'pebble/desktop-tauri/src/tauri-automations-api.test.ts',
    expect: (text) =>
      text.includes('lists Go runtime automations as renderer automation records') &&
      text.includes('creates runtime automations without dropping Pebble schedule metadata') &&
      text.includes('runs automations through the runtime run endpoint and maps run history') &&
      text.includes('handles automation runtime RPC methods for paired-runtime parity') &&
      text.includes("'/v1/automations/auto-1/runs'")
  },
  {
    name: 'Go runtime can list and revoke mobile relay runtime access grants',
    file: 'pebble/go-runtime/internal/runtimehttp/mobile_relay_http.go',
    expect: (text) =>
      text.includes('handleMobileRelayPairings') &&
      text.includes('handleMobileRelayPairingByDeviceID') &&
      text.includes('DeleteMobileRelayPairing(deviceID)') &&
      text.includes('map[string]bool{"revoked": revoked}')
  },
  {
    name: 'Tauri runtime control API bridges local runtime and remote environment commands',
    file: 'pebble/desktop-tauri/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes("invoke<PublicKnownRuntimeEnvironment[]>('runtime_environments_list'") &&
      text.includes("'runtime_environments_add_from_pairing_code'") &&
      text.includes("'runtime_environments_remove'") &&
      text.includes("'runtime_environments_call'") &&
      text.includes('callPebbleRuntimeMethod(method, params)') &&
      text.includes("case 'preflight.detectAgents':") &&
      text.includes("case 'preflight.refreshAgents':") &&
      text.includes("case 'worktree.lineageList':") &&
      text.includes("case 'projectGroup.list':") &&
      text.includes("case 'folderWorkspace.list':") &&
      text.includes('callTauriProjectGroupRuntimeRpc(method, params)') &&
      text.includes('callTauriFolderWorkspaceRuntimeRpc(method, params)') &&
      text.includes('callTauriAutomationRuntimeRpc(method, params)') &&
      text.includes('readRuntimeWorktreeLineage()') &&
      text.includes("case 'worktree.persistSortOrder':") &&
      text.includes("case 'repo.reorder':") &&
      text.includes('persistRuntimeProjectSortOrder(toOrderedIds(params))') &&
      text.includes('persistRuntimeWorktreeSortOrder(toOrderedIds(params))') &&
      text.includes("case 'preflight.detectRemoteWindowsTerminalCapabilities':") &&
      text.includes("failRuntimeRpc('remote_runtime_unavailable'") &&
      text.includes('readOrCreateRuntimeStatus(graph)') &&
      text.includes('readTerminalFitOverrides()') &&
      text.includes('restoreTauriTerminalFit(ptyId)') &&
      text.includes('reclaimTauriBrowserForDesktop(browserPageId)') &&
      text.includes('terminalDriverListeners') &&
      text.includes('subscribeTauriRuntimeEnvironment(args, callbacks)') &&
      text.includes('parsePebbleYaml') &&
      text.includes('inspectSetupScriptImportCandidates') &&
      text.includes('readRuntimeRepoHooksCheck(params)') &&
      text.includes('inspectRuntimeRepoSetupScriptImports(params)') &&
      text.includes('readRuntimeRepoTextFile(repoId,') &&
      text.includes("case 'computer.permissionsStatus':") &&
      text.includes('readTauriComputerUsePermissionStatus()') &&
      text.includes("case 'computer.permissions':") &&
      text.includes('openTauriComputerUsePermissionSetup(readComputerPermissionsArgs(params))') &&
      text.includes("case 'hostedReview.forBranch':") &&
      text.includes("case 'hostedReview.getCreationEligibility':") &&
      text.includes("case 'hostedReview.create':") &&
      text.includes('readTauriHostedReviewCreationEligibility()') &&
      text.includes('createTauriHostedReviewUnavailableResult()') &&
      !text.includes("code: 'remote_subscription_unavailable'") &&
      !text.includes('readUnsupportedComputerPermissions') &&
      !text.includes('openUnsupportedComputerPermissions') &&
      !text.includes('getTerminalDrivers: () => Promise.resolve([])') &&
      !text.includes('getBrowserDrivers: () => Promise.resolve([])')
  },
  {
    name: 'Tauri maps project groups and folder workspaces to Go runtime storage',
    file: 'pebble/desktop-tauri/src/tauri-folder-workspace-api.ts',
    expect: (text) =>
      text.includes('createPebbleProjectGroupsApi') &&
      text.includes('createPebbleFolderWorkspacesApi') &&
      text.includes("'/v1/project-groups'") &&
      text.includes("'/v1/project-groups/move-project'") &&
      text.includes("'/v1/project-groups/scan-nested'") &&
      text.includes("'/v1/project-groups/import-nested'") &&
      text.includes("'/v1/folder-workspaces'") &&
      text.includes("'/v1/folder-workspaces/path-status'") &&
      text.includes("case 'projectGroup.create'") &&
      text.includes("case 'projectGroup.scanNested'") &&
      text.includes("case 'projectGroup.importNested'") &&
      text.includes("case 'folderWorkspace.create'") &&
      text.includes("case 'folderWorkspace.getPathStatus'") &&
      text.includes('readRuntimeNestedRepos') &&
      text.includes('scanRuntimeNestedRepos') &&
      text.includes('importRuntimeNestedRepos') &&
      text.includes('subscribeNestedScanProgress') &&
      text.includes('cancelRuntimeNestedScan') &&
      text.includes('emitNestedScanProgress') &&
      text.includes('toStoppedNestedScan') &&
      text.includes('timeoutMs: 20_000') &&
      text.includes('timeoutMs: 30_000') &&
      text.includes('callRemoteRuntimeResult<NestedRepoScanResult>') &&
      text.includes('callRemoteRuntimeResult<ProjectGroupImportResult>') &&
      text.includes('window.api.runtimeEnvironments.call') &&
      text.includes("'projectGroup.scanNested'") &&
      text.includes("'projectGroup.importNested'") &&
      text.includes('toProjectGroupCreateArgs(params)') &&
      text.includes('toFolderWorkspaceCreateArgs(params)') &&
      text.includes('toFolderWorkspacePathStatusArgs(params)') &&
      !text.includes('emptyNestedRepoScan') &&
      !text.includes('emptyProjectGroupImport') &&
      !text.includes('remote_nested_repo_scan_unavailable') &&
      !text.includes('cancelNestedScan: () => Promise.resolve(false)') &&
      !text.includes('onNestedScanProgress: () => () => {}')
  },
  {
    name: 'Go runtime persists project groups and folder workspace objects',
    file: 'pebble/go-runtime/internal/runtimecore/project_group_folder_workspace.go',
    expect: (text) =>
      text.includes('func (m *Manager) ListProjectGroups() []ProjectGroup') &&
      text.includes('func (m *Manager) CreateProjectGroup') &&
      text.includes('func (m *Manager) MoveProjectToGroup') &&
      text.includes('func (m *Manager) ScanNestedRepos') &&
      text.includes('func (m *Manager) ImportNestedRepos') &&
      text.includes('func readNestedGitignoreRules') &&
      text.includes('func resolveLocalNestedRepoImportTargetPath') &&
      text.includes('func newNestedProjectGroupResolver') &&
      text.includes('func (m *Manager) ListFolderWorkspaces() []FolderWorkspace') &&
      text.includes('func (m *Manager) CreateFolderWorkspace') &&
      text.includes('func (m *Manager) UpdateFolderWorkspace') &&
      text.includes('func (m *Manager) GetFolderWorkspacePathStatus') &&
      text.includes('return FolderWorkspacePathStatus{Path: path, Exists: false, Reason: "unavailable"}')
  },
  {
    name: 'Go runtime exposes project group and folder workspace HTTP endpoints',
    file: 'pebble/go-runtime/internal/runtimehttp/project_group_folder_workspace_routes.go',
    expect: (text) =>
      text.includes('handleProjectGroups') &&
      text.includes('handleProjectGroupMoveProject') &&
      text.includes('handleProjectGroupScanNested') &&
      text.includes('handleProjectGroupImportNested') &&
      text.includes('handleFolderWorkspaces') &&
      text.includes('handleFolderWorkspacePathStatus') &&
      text.includes('handleFolderWorkspaceByID') &&
      text.includes('ScanNestedRepos') &&
      text.includes('ImportNestedRepos') &&
      text.includes('CreateFolderWorkspace') &&
      text.includes('UpdateFolderWorkspace') &&
      text.includes('DeleteFolderWorkspace')
  },
  {
    name: 'Tauri file watch API overrides web no-ops with native fs changed events',
    file: 'pebble/desktop-tauri/src/tauri-file-watch-api.ts',
    expect: (text) =>
      text.includes('export function createPebbleFileWatchApi') &&
      text.includes("'fs_watch_worktree'") &&
      text.includes("'fs_unwatch_worktree'") &&
      text.includes("FS_CHANGED_EVENT = 'pebble:fs-changed'") &&
      text.includes('listen<FsChangedPayload>') &&
      text.includes("method: 'files.watch'") &&
      text.includes("method: 'files.unwatch'") &&
      text.includes('resolveRemoteWatchWorktree') &&
      text.includes('remoteWatchStates') &&
      text.includes('localWatchCounts') &&
      text.includes('fsChangedCallbacks') &&
      text.includes('dispatchFsChangedPayload(event.payload)') &&
      text.includes('callback(payload)') &&
      !text.includes('watchWorktree: () => Promise.resolve()') &&
      !text.includes('onFsChanged: () => noopUnsubscribe') &&
      !text.includes('await base.watchWorktree(args)')
  },
  {
    name: 'Tauri file watch tests cover remote runtime subscription bridging',
    file: 'pebble/desktop-tauri/src/tauri-file-watch-api.test.ts',
    expect: (text) =>
      text.includes('bridges connectionId worktree watches through runtime files.watch') &&
      text.includes("method: 'files.watch'") &&
      text.includes("method: 'files.unwatch'") &&
      text.includes('shares one runtime watch across repeated connectionId subscriptions')
  },
  {
    name: 'Tauri Rust filesystem watcher emits Electron-compatible fs changed payloads',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/filesystem_watch.rs',
    expect: (text) =>
      text.includes('RecommendedWatcher') &&
      text.includes('RecursiveMode::Recursive') &&
      text.includes('FS_CHANGED_EVENT: &str = "pebble:fs-changed"') &&
      text.includes('MAX_BATCHED_WATCHER_EVENTS') &&
      text.includes('WATCHER_IGNORE_DIRS') &&
      text.includes('pub fn fs_watch_worktree') &&
      text.includes('pub fn fs_unwatch_worktree') &&
      text.includes('worktree_path: String') &&
      text.includes('connection_id: Option<String>') &&
      text.includes('kind: "overflow"') &&
      text.includes('coalesce_events') &&
      text.includes('is_directory') &&
      text.includes('value.trim().is_empty()') &&
      text.includes('normalize_absolute_path') &&
      text.includes('rejects_blank_watch_roots') &&
      text.includes('coalesces_delete_then_create_as_delete_and_create')
  },
  {
    name: 'Tauri native shell registers filesystem watcher state and commands',
    file: 'pebble/desktop-tauri/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::filesystem_watch::FsWatcherState::default()') &&
      text.includes('commands::filesystem_watch::fs_watch_worktree') &&
      text.includes('commands::filesystem_watch::fs_unwatch_worktree')
  },
  {
    name: 'Tauri native shell registers terminal artifact grant state and commands',
    file: 'pebble/desktop-tauri/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::terminal_artifacts::TerminalArtifactsState::default()') &&
      text.includes('commands::terminal_artifacts::terminal_artifact_grant') &&
      text.includes('commands::terminal_artifacts::terminal_artifact_read') &&
      text.includes('commands::terminal_artifacts::terminal_artifact_preview') &&
      text.includes('commands::terminal_artifacts::terminal_artifact_write')
  },
  {
    name: 'Tauri Rust dependencies include native filesystem notification and no-follow support',
    file: 'pebble/desktop-tauri/src-tauri/Cargo.toml',
    expect: (text) => text.includes('notify = "6"') && text.includes('libc = "0.2"')
  },
  {
    name: 'Tauri hooks API creates real issue-command runner scripts through Rust',
    file: 'pebble/desktop-tauri/src/tauri-hooks-api.ts',
    expect: (text) =>
      text.includes('export function createPebbleHooksApi') &&
      text.includes('createIssueCommandRunner: async') &&
      text.includes("'hooks_create_issue_command_runner'") &&
      text.includes('repoPath: repo.path') &&
      text.includes('worktreePath') &&
      text.includes('base.createIssueCommandRunner(args)')
  },
  {
    name: 'Tauri Rust hooks command writes linked-worktree-safe issue-command runners',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/hooks.rs',
    expect: (text) =>
      text.includes('pub fn hooks_create_issue_command_runner') &&
      text.includes('rev-parse') &&
      text.includes('--git-path') &&
      text.includes('pebble/issue-command-runner.sh') &&
      text.includes('pebble/issue-command-runner.cmd') &&
      text.includes('PEBBLE_ROOT_PATH') &&
      text.includes('PEBBLE_WORKTREE_PATH') &&
      text.includes('PEBBLE_WORKSPACE_NAME') &&
      text.includes('CONDUCTOR_ROOT_PATH') &&
      text.includes('GHOSTX_ROOT_PATH') &&
      text.includes('build_issue_command_env_vars') &&
      text.includes('build_posix_runner_script') &&
      text.includes('build_windows_runner_script') &&
      text.includes('rejects_blank_runner_inputs') &&
      text.includes('writes_runner_under_linked_worktree_git_dir')
  },
  {
    name: 'Tauri runtime environment subscription bridge streams remote RPC events and binary frames',
    file: 'pebble/desktop-tauri/src/tauri-runtime-environment-subscription-api.ts',
    expect: (text) =>
      text.includes('listen<TauriRuntimeEnvironmentSubscriptionEvent>') &&
      text.includes(
        "RUNTIME_ENVIRONMENT_SUBSCRIPTION_EVENT = 'pebble:runtime-environment-subscription'"
      ) &&
      text.includes("'runtime_environments_subscribe'") &&
      text.includes("'runtime_environments_unsubscribe'") &&
      text.includes("'runtime_environments_send_subscription_binary'") &&
      text.includes('callbacks.onResponse(event.response)') &&
      text.includes('callbacks.onBinary?.(base64ToBytes(event.bytesBase64))') &&
      text.includes('bytesToBase64(bytes)')
  },
  {
    name: 'Tauri workspace API maps canonical renderer repos and worktrees to runtime resources',
    file: 'pebble/desktop-tauri/src/pebble-tauri-workspace-runtime-api.ts',
    expect: (text) =>
      text.includes('export function createPebbleReposApi') &&
      text.includes("'/v1/projects'") &&
      text.includes("'/v1/projects/reorder'") &&
      text.includes('export function createPebbleWorktreesApi') &&
      text.includes("'/v1/worktrees'") &&
      text.includes('MANAGED_WORKTREE_OWNERSHIP') &&
      text.includes('getTauriBaseRefDefault(readRepos(), repoId)') &&
      text.includes('searchTauriBaseRefs(readRepos(), args)') &&
      text.includes('resolveTauriPrBase(readRepos(), args)') &&
      text.includes('resolveTauriMrBase(readRepos(), args)') &&
      text.includes('prefetchRuntimeWorktreeCreateBase(args)') &&
      text.includes("operation: 'fetch'") &&
      text.includes('createRuntimeWorktreeWithStatus(args)') &&
      text.includes('removeRuntimeWorktreeById(worktreeId, { force })') &&
      text.includes('deleteRuntimeWorktree(worktreeId, options)') &&
      text.includes('executeGit: true') &&
      text.includes('resolveDefaultCreateProjectParent') &&
      text.includes("joinNativePath(await homeDir(), 'pebble', 'workspaces')") &&
      text.includes('subscribeWorktreeCreateProgress(callback)') &&
      text.includes("emitWorktreeCreateProgress(args.creationId, 'fetching')") &&
      text.includes("emitWorktreeCreateProgress(args.creationId, 'creating')") &&
      text.includes('createInitialRuntimeBaseStatus(args.repoId, runtimeWorktree)') &&
      text.includes("'/v1/source-control/base-status'") &&
      text.includes('emitRuntimeWorktreeBaseStatus') &&
      text.includes('emitRuntimeWorktreeRemoteBranchConflict') &&
      text.includes('subscribeWorktreeBaseStatus(callback)') &&
      text.includes('subscribeWorktreeRemoteBranchConflict(callback)') &&
      text.includes(
        "requestRuntimeJson<RuntimeWorktreeLineageListResponse>('/v1/worktrees/lineage'"
      ) &&
      text.includes("'/v1/worktrees/sort-order'") &&
      text.includes("method: 'PATCH'") &&
      text.includes('parentWorkspace') &&
      text.includes("readRuntimeEvents('project.changed')") &&
      text.includes("readRuntimeEvents('worktree.changed')") &&
      text.includes('subscribeWorktreeChanged(callback)') &&
      !text.includes('prefetchCreateBase: () => Promise.resolve()')
  },
  {
    name: 'Go runtime worktree deletion can execute bounded local git removal',
    file: 'pebble/go-runtime/internal/runtimecore/manager.go',
    expect: (text) =>
      text.includes(
        'func (m *Manager) DeleteWorktree(ctx context.Context, id string, req DeleteWorktreeRequest)'
      ) &&
      text.includes('if req.ExecuteGit') &&
      text.includes('func removeLocalGitWorktree') &&
      text.includes('"worktree", "remove"') &&
      text.includes('context.WithTimeout(ctx, gitWorktreeCommandLimit)')
  },
  {
    name: 'Tauri window API bridges native window controls',
    file: 'pebble/desktop-tauri/src/tauri-window-api.ts',
    expect: (text) =>
      text.includes("import { getCurrentWindow } from '@tauri-apps/api/window'") &&
      text.includes('export function installTauriWindowApi') &&
      text.includes('toggleMaximize()') &&
      text.includes('installTauriWindowCloseInterceptor') &&
      text.includes('event.preventDefault()')
  },
  {
    name: 'Tauri settings API emits renderer-visible settings and UI state changes',
    file: 'pebble/desktop-tauri/src/tauri-settings-event-api.ts',
    expect: (text) =>
      text.includes('export function installTauriSettingsEventApi') &&
      text.includes('settingsChangedListeners') &&
      text.includes('uiStateChangedListeners') &&
      text.includes('emitSettingsChanged(updates)') &&
      text.includes('emitUiStateChanged(await uiBase.get())')
  },
  {
    name: 'Tauri menu API bridges native menu actions into renderer callbacks',
    file: 'pebble/desktop-tauri/src/tauri-menu-api.ts',
    expect: (text) =>
      text.includes('Menu,') &&
      text.includes("from '@tauri-apps/api/menu'") &&
      text.includes("import { getCurrentWebview } from '@tauri-apps/api/webview'") &&
      text.includes('getEffectiveKeybindingsForAction') &&
      text.includes('export function installTauriMenuApi') &&
      text.includes('Menu.new({ items: await buildTauriMenuTemplate(await readTauriKeybindingOverrides()) })') &&
      text.includes('setAsAppMenu()') &&
      text.includes('popup(undefined, getCurrentWindow())') &&
      text.includes('onTerminalZoom: subscribeTerminalZoom') &&
      text.includes("onOpenQuickOpen: subscribeEmptyUiEvent('openQuickOpen')") &&
      text.includes("onJumpToWorktreeIndex: subscribeIndexedUiEvent('jumpToWorktreeIndex')") &&
      text.includes('onWorktreeHistoryNavigate: subscribeWorktreeHistoryNavigate') &&
      text.includes("onDictationKeyDown: subscribeEmptyUiEvent('dictationKeyDown')") &&
      text.includes("emitEmptyUiEvent('appMenuPaste')") &&
      text.includes('Check for Updates...') &&
      text.includes('setZoom(Math.pow(1.2, level))') &&
      text.includes('await buildTauriAppearanceMenuItems(rebuildTauriApplicationMenu)') &&
      text.includes('installTauriMenuKeybindingSubscription') &&
      text.includes('installTauriWindowShortcutBridge') &&
      text.includes('menuLabelWithShortcut') &&
      text.includes('native accelerators would steal terminal/editor/recorder key events') &&
      !text.includes("menuItem('Force Reload', () => reloadTauriRenderer(true), 'CmdOrCtrl+Shift+R')") &&
      !text.includes("menuItem('Toggle Left Sidebar', () => emitEmptyUiEvent('toggleLeftSidebar'), 'CmdOrCtrl+B')")
  },
  {
    name: 'Tauri UI event bus keeps menu and shortcut bridge callbacks unified',
    file: 'pebble/desktop-tauri/src/tauri-ui-events.ts',
    expect: (text) =>
      text.includes('export type TauriEmptyUiEvent') &&
      text.includes('subscribeTauriEmptyUiEvent') &&
      text.includes('emitTauriEmptyUiEvent') &&
      text.includes('subscribeTauriIndexedUiEvent') &&
      text.includes('emitTauriIndexedUiEvent') &&
      text.includes('subscribeTauriTerminalShortcutCaptured') &&
      text.includes('emitTauriTerminalShortcutCaptured') &&
      text.includes('subscribeTauriWorktreeHistoryNavigate') &&
      text.includes('emitTauriWorktreeHistoryNavigate')
  },
  {
    name: 'Tauri window shortcuts use Electron-compatible policy routing',
    file: 'pebble/desktop-tauri/src/tauri-window-shortcut-bridge.ts',
    expect: (text) =>
      text.includes('resolveWindowShortcutAction') &&
      text.includes('windowShortcutActionCapturesTerminal') &&
      text.includes('ModifierDoubleTapDetector') &&
      text.includes('export function installTauriWindowShortcutBridge') &&
      text.includes('dispatchTauriWindowShortcutInput') &&
      text.includes('sendTauriWindowShortcutAction') &&
      text.includes('window.api.keybindings.onChanged') &&
      text.includes('window.api.settings.onChanged') &&
      text.includes('emitTauriTerminalZoom(action.direction)') &&
      text.includes("emitTauriEmptyUiEvent('openSettings')") &&
      text.includes("emitTauriIndexedUiEvent('jumpToWorktreeIndex', action.index)") &&
      text.includes('emitTauriTerminalShortcutCaptured(actionId)') &&
      text.includes('Tauri has no Electron before-input-event')
  },
  {
    name: 'Tauri Appearance menu reads persisted settings and UI state',
    file: 'pebble/desktop-tauri/src/tauri-appearance-menu-state.ts',
    expect: (text) =>
      text.includes('buildTauriAppearanceMenuItems') &&
      text.includes('window.api.settings.get()') &&
      text.includes('window.api.ui.get()') &&
      text.includes('Show Status Bar') &&
      text.includes('Show Titlebar App Name') &&
      text.includes('toggleAppearanceSetting')
  },
  {
    name: 'Tauri runtime PTY API maps renderer terminals onto runtime sessions',
    file: 'pebble/desktop-tauri/src/tauri-runtime-pty-api.ts',
    expect: (text) =>
      text.includes('export function installTauriRuntimePtyApi') &&
      text.includes('spawn: spawnRuntimePty') &&
      text.includes("'/v1/sessions'") &&
      text.includes('/input') &&
      text.includes("readRuntimeEvents('session.output')") &&
      text.includes("readRuntimeEvents('session.status')") &&
      text.includes('clearBuffer: (id) =>') &&
      text.includes('/clear-buffer') &&
      text.includes('resize: resizeRuntimePty') &&
      text.includes('reportGeometry: resizeRuntimePty') &&
      text.includes('const size = rememberRuntimePtySize(id, cols, rows)') &&
      text.includes('runtimePtySizeById.get(id) ?? null') &&
      text.includes('getMainBufferSnapshot: getRuntimePtyBufferSnapshot') &&
      text.includes('recordRuntimeAgentSessionSpawn({ session, spawnOptions: opts })') &&
      text.includes('emitRuntimeAgentSessionStatus(session)') &&
      text.includes('markRuntimeAgentSessionStopped(id)') &&
      text.includes('launchToken: opts.launchToken') &&
      text.includes('tabId: opts.tabId') &&
      text.includes('leafId: opts.leafId') &&
      text.includes('window.api.worktrees.listAll()')
  },
  {
    name: 'Tauri agent-status API maps runtime sessions to renderer AgentStatus IPC',
    file: 'pebble/desktop-tauri/src/tauri-agent-status-api.ts',
    expect: (text) =>
      text.includes('export function installTauriAgentStatusApi') &&
      text.includes('window.api.agentStatus =') &&
      text.includes('getSnapshot: async () =>') &&
      text.includes('hydrateRuntimeAgentSessionSnapshot()') &&
      text.includes("createRuntimeResourceGetCommand({ path: '/v1/sessions'") &&
      text.includes('recordRuntimeAgentSessionSpawn') &&
      text.includes('makePaneKey(tabId, leafId)') &&
      text.includes("status === 'starting' || status === 'running' ? 'working' : 'done'") &&
      text.includes('inferRuntimeAgentInterrupt') &&
      text.includes('dropRuntimeAgentTab(tabId)') &&
      text.includes('connectionId: null')
  },
  {
    name: 'Tauri runtime RPC maps terminal list, send, wait, and agent status to Go sessions',
    file: 'pebble/desktop-tauri/src/tauri-terminal-runtime-rpc.ts',
    expect: (text) =>
      text.includes('export async function callTauriTerminalRuntimeRpc') &&
      text.includes("case 'terminal.list'") &&
      text.includes("case 'terminal.show'") &&
      text.includes("case 'terminal.read'") &&
      text.includes("case 'terminal.inspectProcess'") &&
      text.includes("case 'terminal.clearBuffer'") &&
      text.includes("case 'terminal.send'") &&
      text.includes("case 'terminal.wait'") &&
      text.includes("case 'terminal.agentStatus'") &&
      text.includes("case 'terminal.isRunningAgent'") &&
      text.includes("case 'terminal.stop'") &&
      text.includes("case 'terminal.stopExact'") &&
      text.includes("'/v1/sessions'") &&
      text.includes('/tail?limit=') &&
      text.includes('/clear-buffer') &&
      text.includes('/input') &&
      text.includes('appendNewline') &&
      text.includes('expectedPtyIds') &&
      text.includes('Go sessions know whether an agent owns the PTY') &&
      text.includes('Go sessions expose the launched command')
  },
  {
    name: 'Tauri runtime RPC maps file explorer operations to Go file endpoints',
    file: 'pebble/desktop-tauri/src/tauri-file-runtime-rpc.ts',
    expect: (text) =>
      text.includes('export async function callTauriFileRuntimeRpc') &&
      text.includes("case 'files.read'") &&
      text.includes("case 'files.readDir'") &&
      text.includes("case 'files.readPreview'") &&
      text.includes("case 'files.readChunk'") &&
      text.includes("case 'files.browseServerDir'") &&
      text.includes("case 'files.write'") &&
      text.includes("case 'files.writeBase64'") &&
      text.includes("case 'files.writeBase64Chunk'") &&
      text.includes("case 'files.createFile'") &&
      text.includes("case 'files.createDir'") &&
      text.includes("case 'files.createDirNoClobber'") &&
      text.includes("case 'files.commitUpload'") &&
      text.includes("case 'files.rename'") &&
      text.includes("case 'files.copy'") &&
      text.includes("case 'files.delete'") &&
      text.includes("case 'files.stat'") &&
      text.includes("case 'files.listAll'") &&
      text.includes("case 'files.search'") &&
      text.includes("case 'files.unwatch'") &&
      text.includes('remoteFileRuntimeMethods') &&
      text.includes('callRemoteFileRuntimeRpc') &&
      text.includes('remoteFileRuntimeTimeout') &&
      text.includes('Paired runtime') &&
      text.includes('/v1/files/tree') &&
      text.includes('/v1/files/read-chunk') &&
      text.includes('/v1/files/write') &&
      text.includes('/v1/files/write-base64') &&
      text.includes('/v1/files/browse-dir') &&
      text.includes('/v1/files/search')
  },
  {
    name: 'Tauri runtime RPC maps terminal artifact grants to native temp-file commands',
    file: 'pebble/desktop-tauri/src/tauri-file-runtime-rpc.ts',
    expect: (text) =>
      text.includes("case 'files.resolveTerminalPath'") &&
      text.includes("case 'files.readTerminalArtifact'") &&
      text.includes("case 'files.readTerminalArtifactPreview'") &&
      text.includes("case 'files.writeTerminalArtifact'") &&
      text.includes("'terminal_artifact_grant'") &&
      text.includes("'terminal_artifact_read'") &&
      text.includes("'terminal_artifact_preview'") &&
      text.includes("'terminal_artifact_write'") &&
      text.includes('hasRecentTerminalOutputPath') &&
      text.includes('terminalOutputContainsPath') &&
      text.includes('resolveRemoteTerminalPath') &&
      text.includes('remoteTerminalArtifactGrants') &&
      text.includes('callRemoteRuntimeResult') &&
      text.includes('runtimeEnvironments.call') &&
      text.includes('relativePathInsideRoot') &&
      text.includes("'/v1/sessions'") &&
      text.includes('/tail?limit=2000') &&
      !text.includes("Promise.resolve({ openTarget: { kind: 'absolute-file'")
  },
  {
    name: 'Tauri Rust terminal artifact commands enforce grant-scoped temp-file access',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/terminal_artifacts.rs',
    expect: (text) =>
      text.includes('pub fn terminal_artifact_grant') &&
      text.includes('pub fn terminal_artifact_read') &&
      text.includes('pub fn terminal_artifact_preview') &&
      text.includes('pub fn terminal_artifact_write') &&
      text.includes('TERMINAL_FILE_GRANT_TTL') &&
      text.includes('terminal_file_grant_expired') &&
      text.includes('terminal_file_grant_mismatch') &&
      text.includes('terminal_file_grant_stale') &&
      text.includes('assert_terminal_artifact_not_hard_linked') &&
      text.includes('open_read_no_follow') &&
      text.includes('O_NOFOLLOW') &&
      text.includes('is_allowed_terminal_artifact_path') &&
      text.includes('TERMINAL_PREVIEW_MAX_BYTES') &&
      text.includes('replace_file')
  },
  {
    name: 'Go runtime exposes file mutation, listing, and search endpoints for Tauri',
    file: 'pebble/go-runtime/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/files/create-file"') &&
      text.includes('"/v1/files/read-chunk"') &&
      text.includes('"/v1/files/write-base64"') &&
      text.includes('"/v1/files/create-dir"') &&
      text.includes('"/v1/files/rename"') &&
      text.includes('"/v1/files/copy"') &&
      text.includes('"/v1/files/delete"') &&
      text.includes('"/v1/files/stat"') &&
      text.includes('"/v1/files/list"') &&
      text.includes('"/v1/files/search"') &&
      text.includes('"/v1/files/markdown"') &&
      text.includes('"/v1/files/browse-dir"')
  },
  {
    name: 'Tauri runtime RPC maps git status and upstream state to source-control projections',
    file: 'pebble/desktop-tauri/src/tauri-git-runtime-rpc.ts',
    expect: (text) =>
      text.includes('export async function callTauriGitRuntimeRpc') &&
      text.includes("case 'git.status'") &&
      text.includes("case 'git.checkIgnored'") &&
      text.includes("case 'git.submoduleStatus'") &&
      text.includes("case 'git.diff'") &&
      text.includes("case 'git.branchCompare'") &&
      text.includes("case 'git.commitCompare'") &&
      text.includes("case 'git.history'") &&
      text.includes("case 'git.branchDiff'") &&
      text.includes("case 'git.commitDiff'") &&
      text.includes("case 'git.upstreamStatus'") &&
      text.includes("case 'git.conflictOperation'") &&
      text.includes("case 'git.stage'") &&
      text.includes("case 'git.bulkStage'") &&
      text.includes("case 'git.unstage'") &&
      text.includes("case 'git.bulkUnstage'") &&
      text.includes("case 'git.discard'") &&
      text.includes("case 'git.bulkDiscard'") &&
      text.includes("case 'git.commit'") &&
      text.includes("case 'git.generateCommitMessage'") &&
      text.includes("case 'git.discoverCommitMessageModels'") &&
      text.includes("case 'git.cancelGenerateCommitMessage'") &&
      text.includes("case 'git.generatePullRequestFields'") &&
      text.includes("case 'git.cancelGeneratePullRequestFields'") &&
      text.includes("case 'git.fetch'") &&
      text.includes("case 'git.forkSync'") &&
      text.includes("case 'git.pull'") &&
      text.includes("case 'git.push'") &&
      text.includes("case 'git.fastForward'") &&
      text.includes("case 'git.rebaseFromBase'") &&
      text.includes("case 'git.abortMerge'") &&
      text.includes("case 'git.abortRebase'") &&
      text.includes("case 'git.remoteFileUrl'") &&
      text.includes("case 'git.remoteCommitUrl'") &&
      text.includes('/v1/source-control/file-diff') &&
      text.includes('/v1/source-control/ref-file-diff') &&
      text.includes('/v1/source-control/mutate') &&
      text.includes('/v1/source-control/check-ignored') &&
      text.includes('/v1/source-control/submodule-status') &&
      text.includes('/v1/source-control/remote-file-url') &&
      text.includes('/v1/source-control/remote-commit-url') &&
      text.includes('/v1/source-control/fork-sync') &&
      text.includes('/v1/source-control/branch-compare') &&
      text.includes('/v1/source-control/commit-compare') &&
      text.includes('/v1/source-control/history') &&
      text.includes('/v1/source-control?workspaceId=') &&
      text.includes('mapSourceControlProjectionToUpstreamStatus') &&
      text.includes('area?: string') &&
      text.includes('oldPath?: string') &&
      text.includes('mapGitStatusArea(change.area, status)') &&
      text.includes('entry.oldPath = change.oldPath')
  },
  {
    name: 'Go runtime preserves staged and unstaged git status areas for Tauri',
    file: 'pebble/go-runtime/internal/runtimecore/source_control_projection.go',
    expect: (text) =>
      text.includes('Area      string `json:"area,omitempty"`') &&
      text.includes('OldPath   string `json:"oldPath,omitempty"`') &&
      text.includes('func parseGitChangeLine(line string) []SourceControlChange') &&
      text.includes('sourceControlChangeForGitStatus(path, oldPath, status, "staged")') &&
      text.includes('sourceControlChangeForGitStatus(path, oldPath, status, "unstaged")') &&
      text.includes('Area: "untracked"') &&
      text.includes('func normalizeSourceControlChangeArea(area string, status string) string') &&
      text.includes('case "staged", "index"') &&
      text.includes('case "unstaged", "working", "worktree"')
  },
  {
    name: 'Go runtime exposes content-level git file diff for Tauri Source Control',
    file: 'pebble/go-runtime/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/source-control/file-diff"') &&
      text.includes('"/v1/source-control/ref-file-diff"') &&
      text.includes('"/v1/source-control/mutate"') &&
      text.includes('"/v1/source-control/check-ignored"') &&
      text.includes('"/v1/source-control/submodule-status"') &&
      text.includes('"/v1/source-control/remote-file-url"') &&
      text.includes('"/v1/source-control/remote-commit-url"') &&
      text.includes('"/v1/source-control/fork-sync"') &&
      text.includes('"/v1/source-control/base-status"') &&
      text.includes('"/v1/source-control/branch-compare"') &&
      text.includes('"/v1/source-control/commit-compare"') &&
      text.includes('"/v1/source-control/history"') &&
      text.includes('handleGitFileDiff') &&
      text.includes('handleGitRefFileDiff') &&
      text.includes('handleGitMutation') &&
      text.includes('handleGitCheckIgnored') &&
      text.includes('handleGitSubmoduleStatus') &&
      text.includes('handleGitRemoteFileURL') &&
      text.includes('handleGitRemoteCommitURL') &&
      text.includes('handleGitForkSync') &&
      text.includes('handleGitBaseStatus') &&
      text.includes('handleGitBranchCompare') &&
      text.includes('handleGitCommitCompare') &&
      text.includes('handleGitHistory')
  },
  {
    name: 'Go runtime persists created base SHA and computes worktree base status',
    file: 'pebble/go-runtime/internal/runtimecore/manager.go',
    expect: (text) =>
      text.includes('CreatedBaseSHA') &&
      text.includes('resolveGitCommitQuiet(ctx, project.Path, req.Base)') &&
      text.includes('func (m *Manager) GitBaseStatus') &&
      text.includes('parseRemoteTrackingBaseRef') &&
      text.includes('fetchGit(ctx, base, GitMutationRequest{RemoteName: remote, BranchName: branch})') &&
      text.includes('merge-base') &&
      text.includes('rev-list') &&
      text.includes('checkGitRemoteBranchConflict') &&
      text.includes('resolveGitPublishRemote')
  },
  {
    name: 'Go runtime sessions persist pane identity for Tauri agent-status snapshots',
    file: 'pebble/go-runtime/internal/runtimecore/domain.go',
    expect: (text) =>
      /TabID\s+string\s+`json:"tabId,omitempty"`/.test(text) &&
      /LeafID\s+string\s+`json:"leafId,omitempty"`/.test(text) &&
      /LaunchToken\s+string\s+`json:"launchToken,omitempty"`/.test(text) &&
      /Prompt\s+string\s+`json:"prompt,omitempty"`/.test(text)
  },
  {
    name: 'Tauri updater API uses the native updater plugin instead of a download no-op',
    file: 'pebble/desktop-tauri/src/tauri-updater-api.ts',
    expect: (text) =>
      text.includes('export function installTauriUpdaterApi') &&
      text.includes("from '@tauri-apps/plugin-updater'") &&
      text.includes("from '@tauri-apps/plugin-process'") &&
      text.includes('getVersion: () => Promise.resolve(rootPackage.version)') &&
      text.includes("state: 'checking'") &&
      text.includes("invoke<TauriReleaseCheckResult>('updater_check_latest_release'") &&
      text.includes("state: 'available'") &&
      text.includes('https://github.com/nebutra/pebble/releases/tag/v') &&
      text.includes('checkTauriUpdate({') &&
      text.includes('await update.download(createDownloadProgressHandler(version)') &&
      text.includes('await update.install()') &&
      text.includes('await relaunch()') &&
      text.includes('PEBBLE_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT') &&
      text.includes('updaterStatusListeners') &&
      !text.includes('Automatic Tauri update download is not wired yet') &&
      !text.includes('Automatic Tauri update install is not wired yet')
  },
  {
    name: 'Tauri updater and process plugins are registered in the native shell',
    file: 'pebble/desktop-tauri/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('.plugin(tauri_plugin_process::init())') &&
      text.includes('.plugin(tauri_plugin_updater::Builder::new().build())')
  },
  {
    name: 'Tauri updater plugin has a non-null Pebble release configuration',
    file: 'pebble/desktop-tauri/src-tauri/tauri.conf.json',
    expect: (text) =>
      text.includes('"updater"') &&
      text.includes('https://github.com/nebutra/pebble/releases/latest/download/latest.json') &&
      text.includes('"pubkey"') &&
      !text.includes('"updater": null')
  },
  {
    name: 'Tauri updater dependencies are declared on both Rust and renderer sides',
    file: 'pebble/desktop-tauri/package.json',
    expect: (text) =>
      text.includes('"@tauri-apps/plugin-updater"') && text.includes('"@tauri-apps/plugin-process"')
  },
  {
    name: 'Tauri updater Rust crates are declared for native install/relaunch support',
    file: 'pebble/desktop-tauri/src-tauri/Cargo.toml',
    expect: (text) =>
      text.includes('tauri-plugin-updater = "2"') && text.includes('tauri-plugin-process = "2"')
  },
  {
    name: 'Tauri shell API bridges native path/url/file-picker calls',
    file: 'pebble/desktop-tauri/src/tauri-shell-api.ts',
    expect: (text) =>
      text.includes('export function installTauriShellApi') &&
      text.includes("invoke<ShellOpenLocalPathResult>('shell_open_in_file_manager'") &&
      text.includes("invoke<ShellOpenLocalPathResult>('shell_open_in_external_editor'") &&
      text.includes("invoke<boolean>('shell_path_exists'") &&
      text.includes("invoke<string | null>('shell_pick_file'") &&
      text.includes("invoke<void>('shell_copy_file'")
  },
  {
    name: 'Tauri Rust shell commands implement validated native shell operations',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/shell.rs',
    expect: (text) =>
      text.includes('pub fn shell_open_in_file_manager') &&
      text.includes('pub fn shell_open_in_external_editor') &&
      text.includes('pub fn shell_pick_repo_icon_image') &&
      text.includes('create_new(true)') &&
      text.includes('fn reveal_in_file_manager') &&
      text.includes('fn encode_base64')
  },
  {
    name: 'Tauri registers native shell commands with the Rust invoke handler',
    file: 'pebble/desktop-tauri/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::shell::shell_open_in_file_manager') &&
      text.includes('commands::shell::shell_open_in_external_editor') &&
      text.includes('commands::shell::shell_pick_file') &&
      text.includes('commands::shell::shell_pick_repo_icon_image') &&
      text.includes('commands::shell::shell_copy_file')
  },
  {
    name: 'Tauri runtime environment commands persist pairing-backed servers',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/runtime_environments.rs',
    expect: (text) =>
      text.includes('const ENVIRONMENTS_FILE: &str = "pebble-environments.json"') &&
      text.includes('pub fn runtime_environments_add_from_pairing_code') &&
      text.includes('pub async fn runtime_environments_subscribe') &&
      text.includes('pub fn runtime_environments_unsubscribe') &&
      text.includes('pub fn runtime_environments_send_subscription_binary') &&
      text.includes('RuntimeEnvironmentSubscriptionsState') &&
      text.includes('RUNTIME_ENVIRONMENT_SUBSCRIPTION_EVENT') &&
      text.includes('extract_pairing_code_from_url') &&
      text.includes('decode_pairing_payload') &&
      text.includes('redact_environment') &&
      text.includes('harden_secure_path') &&
      text.includes('WINDOWS_RESTRICT_ACL_SCRIPT')
  },
  {
    name: 'Tauri remote runtime environment calls use WebSocket E2EE instead of local fallback',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/remote_runtime_rpc.rs',
    expect: (text) =>
      text.includes('pub async fn call_remote_runtime') &&
      text.includes('pub async fn subscribe_remote_runtime_request') &&
      text.includes('connect_async(&pairing.endpoint)') &&
      text.includes('"type": "e2ee_hello"') &&
      text.includes('"type": "e2ee_auth"') &&
      text.includes('SalsaBox') &&
      text.includes('validate_runtime_rpc_response') &&
      text.includes('Message::Binary(encrypted.into())') &&
      text.includes('RemoteRuntimeSubscriptionCallbacks')
  },
  {
    name: 'Tauri registers native runtime environment commands with the Rust invoke handler',
    file: 'pebble/desktop-tauri/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::runtime_environments::runtime_environments_list') &&
      text.includes('commands::runtime_environments::runtime_environments_add_from_pairing_code') &&
      text.includes('commands::runtime_environments::runtime_environments_call') &&
      text.includes('commands::runtime_environments::runtime_environments_resolve') &&
      text.includes('commands::runtime_environments::runtime_environments_remove') &&
      text.includes('commands::runtime_environments::runtime_environments_disconnect') &&
      text.includes('commands::runtime_environments::runtime_environments_subscribe') &&
      text.includes('commands::runtime_environments::runtime_environments_unsubscribe') &&
      text.includes(
        'commands::runtime_environments::runtime_environments_send_subscription_binary'
      ) &&
      text.includes('RuntimeEnvironmentSubscriptionsState::default()')
  },
  {
    name: 'Tauri browser API bridges runtime profiles, downloads, and explicit unsupported guest ops',
    file: 'pebble/desktop-tauri/src/tauri-browser-runtime-api.ts',
    expect: (text) =>
      text.includes('export function installTauriBrowserRuntimeApi') &&
      text.includes('registerTauriBrowserGuest(args)') &&
      text.includes('sessionListProfiles: listTauriBrowserSessionProfiles') &&
      text.includes('sessionCreateProfile: createTauriBrowserSessionProfile') &&
      text.includes('sessionDeleteProfile: deleteTauriBrowserSessionProfile') &&
      text.includes('sessionDetectBrowsers: detectTauriBrowserSessionBrowsers') &&
      text.includes('cancelDownload: cancelTauriBrowserDownload') &&
      text.includes('setViewportOverride: async ({ browserPageId, override })') &&
      text.includes('setTauriBrowserViewportOverride({ browserPageId, override })') &&
      text.includes('TAURI_BROWSER_GUEST_UNAVAILABLE') &&
      text.includes('ensureTauriBrowserRuntimeEventPump()') &&
      text.includes('ensureTauriBrowserProviderRefresh()')
  },
  {
    name: 'Renderer browser mounting uses Tauri child Webviews under the Tauri shell',
    file: 'src/renderer/src/components/browser-pane/browser-page-webview.ts',
    expect: (text) =>
      text.includes('ensureTauriBrowserPageWebview') &&
      text.includes('isTauriBrowserHost()') &&
      text.includes('__pebbleSetNativeBrowserInputLocked') &&
      text.includes('document.createElement(\'webview\')')
  },
  {
    name: 'Tauri browser pane adapter creates native child Webviews instead of Electron webview tags',
    file: 'src/renderer/src/components/browser-pane/tauri-browser-page-webview.ts',
    expect: (text) =>
      text.includes("import type { Webview as NativeTauriBrowserWebview } from '@tauri-apps/api/webview'") &&
      text.includes('export function ensureTauriBrowserPageWebview') &&
      text.includes("import('@tauri-apps/api/webview')") &&
      text.includes("import('@tauri-apps/api/window')") &&
      text.includes('new Webview(getCurrentWindow()') &&
      text.includes('dispatchTauriBrowserWebviewEvent(element, \'dom-ready\')') &&
      text.includes('dispatchTauriBrowserWebviewEvent(element, \'did-navigate\'') &&
      text.includes('__pebbleDestroyNativeWebview') &&
      text.includes('__pebbleSetNativeBrowserInputLocked') &&
      text.includes('setTauriNativeWebviewBounds') &&
      text.includes('stableNegativeId')
  },
  {
    name: 'Tauri browser viewport state records toolbar overrides for runtime RPC fallback',
    file: 'pebble/desktop-tauri/src/tauri-browser-viewport-state.ts',
    expect: (text) =>
      text.includes('setTauriBrowserViewportOverride') &&
      text.includes('readTauriBrowserViewport') &&
      text.includes('viewportOverridesByPageId') &&
      text.includes('DEFAULT_TAURI_BROWSER_VIEWPORT') &&
      text.includes('clearTauriBrowserViewportOverrides')
  },
  {
    name: 'Tauri browser events consume runtime browser.changed instead of web no-ops',
    file: 'pebble/desktop-tauri/src/tauri-browser-runtime-events.ts',
    expect: (text) =>
      text.includes("topic: 'browser.changed'") &&
      text.includes('emitBrowserTab(value)') &&
      text.includes('emitBrowserDownload(value)') &&
      text.includes('notifyTauriBrowserActiveTab') &&
      text.includes('downloadFinishedListeners')
  },
  {
    name: 'Tauri browser profiles use runtime browser resources and degraded provider status',
    file: 'pebble/desktop-tauri/src/tauri-browser-runtime-profiles.ts',
    expect: (text) =>
      text.includes("'/v1/browser/profiles'") &&
      text.includes('`/v1/browser/profiles/${encodeURIComponent(args.profileId)}`') &&
      text.includes('`/v1/browser/downloads/${encodeURIComponent(args.downloadId)}`') &&
      text.includes("'browser_detect_installed_browsers'") &&
      text.includes("status: 'degraded'") &&
      text.includes("'runtime-browser-profiles'") &&
      text.includes("'runtime-browser-events'")
  },
  {
    name: 'Tauri runtime RPC maps browser profile and tab lifecycle onto Go runtime routes',
    file: 'pebble/desktop-tauri/src/tauri-browser-runtime-rpc.ts',
    expect: (text) =>
      text.includes('export async function callTauriBrowserRuntimeRpc') &&
      text.includes("case 'browser.profileList'") &&
      text.includes("case 'browser.profileCreate'") &&
      text.includes("case 'browser.profileDelete'") &&
      text.includes("case 'browser.tabCreate'") &&
      text.includes("case 'browser.tabClose'") &&
      text.includes("case 'browser.tabShow'") &&
      text.includes("case 'browser.goto'") &&
      text.includes("case 'browser.back'") &&
      text.includes("case 'browser.forward'") &&
      text.includes("case 'browser.reload'") &&
      text.includes("case 'browser.viewport'") &&
      text.includes('queueBrowserNavigation') &&
      text.includes("queueBrowserNavigation('goto'") &&
      text.includes("queueBrowserNavigation('goBack'") &&
      text.includes("queueBrowserNavigation('goForward'") &&
      text.includes('readTauriBrowserViewport(params)') &&
      text.includes("`/v1/browser/tabs/${encodeURIComponent(pageId)}/commands`") &&
      text.includes("'/v1/browser/profiles'") &&
      text.includes("'/v1/browser/tabs'") &&
      text.includes('Browser cookie import requires the Tauri WebView adapter.')
  },
  {
    name: 'Tauri browser runtime RPC tests cover provider action navigation queueing',
    file: 'pebble/desktop-tauri/src/tauri-browser-runtime-rpc.test.ts',
    expect: (text) =>
      text.includes('queues browser.goto through the runtime browser provider action path') &&
      text.includes('echoes browser viewport requests as a deterministic fallback') &&
      text.includes('reads stored Tauri browser viewport overrides when no explicit size is passed') &&
      text.includes("method: 'PATCH'") &&
      text.includes("command: 'goto'") &&
      text.includes("command: 'reload'")
  },
  {
    name: 'Tauri runtime status commands keep blocking runtime I/O off the WebKit main thread',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/runtime_status.rs',
    expect: (text) =>
      text.includes('pub async fn read_runtime_event_stream') &&
      text.includes('pub async fn get_runtime_resource_json') &&
      text.includes('pub async fn request_runtime_resource_json') &&
      text.includes('tauri::async_runtime::spawn_blocking(operation)') &&
      text.includes('blocking runtime HTTP/SSE reads here freezes pointer and keyboard input')
  },
  {
    name: 'Tauri runtime RPC exposes real native provider status through Go runtime',
    file: 'pebble/desktop-tauri/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes("case 'provider.list':") &&
      text.includes("case 'provider.status':") &&
      text.includes("case 'provider.register':") &&
      text.includes('readRuntimeNativeProviders(params)') &&
      text.includes('readRuntimeSubsystemStatus(params)') &&
      text.includes('registerRuntimeNativeProvider(params)')
  },
  {
    name: 'Tauri native provider requests use Go runtime provider routes',
    file: 'pebble/desktop-tauri/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('async function readRuntimeNativeProviders') &&
      text.includes('async function readRuntimeSubsystemStatus') &&
      text.includes('async function registerRuntimeNativeProvider') &&
      text.includes('function readSubsystemName') &&
      text.includes('function readProviderSubsystem') &&
      text.includes('requestRuntimeJson<RuntimeNativeProvider[]>(`/v1/providers${query}`') &&
      text.includes('requestRuntimeJson<RuntimeSubsystemStatus>(`/v1/${subsystem}/status`') &&
      text.includes("requestRuntimeJson<RuntimeNativeProvider>('/v1/providers'")
  },
  {
    name: 'Go runtime can delete browser profiles for Tauri settings parity',
    file: 'pebble/go-runtime/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('s.mux.HandleFunc("/v1/browser/profiles/", s.handleBrowserProfileByID)') &&
      text.includes('func (s *Server) handleBrowserProfileByID') &&
      text.includes('s.manager.DeleteBrowserProfile(id)')
  },
  {
    name: 'Tauri deep link API handles pebble pairing links through runtime environments',
    file: 'pebble/desktop-tauri/src/tauri-deep-link-api.ts',
    expect: (text) =>
      text.includes('export function installTauriDeepLinkApi') &&
      text.includes("invoke<string[]>('deep_link_initial_urls')") &&
      text.includes('listen<string>(DEEP_LINK_EVENT') &&
      text.includes('function isPairingDeepLink') &&
      text.includes("parsed.protocol === 'pebble:' && parsed.hostname === 'pair'") &&
      text.includes('handledDeepLinks.delete(normalized)') &&
      text.includes('runtimeEnvironments.addFromPairingCode') &&
      text.includes('setRuntimeEnvironments(environments)') &&
      text.includes('refreshRuntimeEnvironmentStatus(result.environment.id)')
  },
  {
    name: 'Tauri Rust deep link bridge filters Pebble protocol events',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/deep_link.rs',
    expect: (text) =>
      text.includes('pub fn deep_link_initial_urls') &&
      text.includes('pub fn emit_deep_links') &&
      text.includes('collect_pebble_deep_links') &&
      text.includes('PEBBLE_URL_PREFIX') &&
      text.includes('pebble://pair?code=abc')
  },
  {
    name: 'Tauri registers deep link commands and opened URL events',
    file: 'pebble/desktop-tauri/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('tauri_plugin_deep_link::init()') &&
      text.includes('commands::deep_link::deep_link_initial_urls') &&
      text.includes('tauri::RunEvent::Opened') &&
      text.includes('commands::deep_link::emit_deep_links')
  },
  {
    name: 'Tauri crash report API persists renderer errors through native commands',
    file: 'pebble/desktop-tauri/src/tauri-crash-reports-api.ts',
    expect: (text) =>
      text.includes('export function createPebbleCrashReportsApi') &&
      text.includes("invoke<CrashReportRecord | null>('crash_reports_get_latest_pending'") &&
      text.includes(
        "invoke<ReactErrorBoundaryReportResult>('crash_reports_record_renderer_error'"
      ) &&
      text.includes("invoke<void>('crash_reports_record_breadcrumb'") &&
      text.includes("invoke<CrashReportSubmitResult>('crash_reports_submit'") &&
      text.includes("invoke<string>('crash_reports_format'") &&
      text.includes('rootPackage.version')
  },
  {
    name: 'Tauri diagnostics API uses native bundle commands instead of web fallback',
    file: 'pebble/desktop-tauri/src/tauri-diagnostics-api.ts',
    expect: (text) =>
      text.includes('export function createPebbleDiagnosticsApi') &&
      text.includes("invoke<DiagnosticsStatusPayload>('diagnostics_get_status'") &&
      text.includes("invoke<DiagnosticsBundlePayload>('diagnostics_collect_bundle'") &&
      text.includes("invoke<void>('diagnostics_open_bundle_preview'") &&
      text.includes("invoke<DiagnosticsUploadPayload>('diagnostics_upload_bundle'") &&
      text.includes("invoke<void>('diagnostics_delete_bundle'") &&
      text.includes('rootPackage.version')
  },
  {
    name: 'Tauri Rust crash report store mirrors Electron crash-report lifecycle',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/crash_reports.rs',
    expect: (text) =>
      text.includes('const CRASH_REPORTS_FILE: &str = "crash-reports.json"') &&
      text.includes('pub fn crash_reports_get_latest_pending') &&
      text.includes('pub fn crash_reports_record_renderer_error') &&
      text.includes('pub fn crash_reports_record_breadcrumb') &&
      text.includes('pub async fn crash_reports_submit') &&
      text.includes('is_related_crash_event') &&
      text.includes('sanitize_crash_report_string') &&
      text.includes('FEEDBACK_API_URL') &&
      text.includes('collect_crash_diagnostic_bundle_attachment') &&
      text.includes('create_feedback_multipart_form')
  },
  {
    name: 'Tauri Rust diagnostics command collects previews and uploadable bundles',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/diagnostics.rs',
    expect: (text) =>
      text.includes('pub fn diagnostics_get_status') &&
      text.includes('pub fn diagnostics_collect_bundle') &&
      text.includes('pub fn diagnostics_open_bundle_preview') &&
      text.includes('pub async fn diagnostics_upload_bundle') &&
      text.includes('pub async fn diagnostics_delete_bundle') &&
      text.includes('collect_crash_diagnostic_bundle_attachment') &&
      text.includes('validate_upload_url') &&
      text.includes('open the review file before sending') &&
      text.includes('tauri-crash-reports') &&
      !text.includes('diagnostic bundle collection is not wired in Tauri yet')
  },
  {
    name: 'Tauri registers native crash report commands with the Rust invoke handler',
    file: 'pebble/desktop-tauri/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::crash_reports::CrashReportsState::default()') &&
      text.includes('commands::crash_reports::crash_reports_get_latest_pending') &&
      text.includes('commands::crash_reports::crash_reports_record_renderer_error') &&
      text.includes('commands::crash_reports::crash_reports_record_breadcrumb') &&
      text.includes('commands::crash_reports::crash_reports_submit')
  },
  {
    name: 'Tauri registers native diagnostics commands with the Rust invoke handler',
    file: 'pebble/desktop-tauri/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::diagnostics::DiagnosticsState::default()') &&
      text.includes('commands::diagnostics::diagnostics_get_status') &&
      text.includes('commands::diagnostics::diagnostics_collect_bundle') &&
      text.includes('commands::diagnostics::diagnostics_open_bundle_preview') &&
      text.includes('commands::diagnostics::diagnostics_upload_bundle') &&
      text.includes('commands::diagnostics::diagnostics_delete_bundle')
  },
  {
    name: 'Tauri Rust computer-use permission commands reuse the native helper app',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/computer_permissions.rs',
    expect: (text) =>
      text.includes('pub fn computer_permissions_status') &&
      text.includes('pub fn computer_permissions_open') &&
      text.includes('pub fn computer_permissions_reset') &&
      text.includes('Pebble Computer Use.app') &&
      text.includes('pebble-computer-use-macos') &&
      text.includes('--permission-status-file') &&
      text.includes('PEBBLE_COMPUTER_MACOS_HELPER_APP_PATH') &&
      text.includes('tccutil') &&
      text.includes('ComputerUsePermissionStatus::NotGranted') &&
      text.includes('unsupported_permissions()')
  },
  {
    name: 'Tauri registers native computer-use permission commands with the Rust invoke handler',
    file: 'pebble/desktop-tauri/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::computer_permissions::computer_permissions_status') &&
      text.includes('commands::computer_permissions::computer_permissions_open') &&
      text.includes('commands::computer_permissions::computer_permissions_reset')
  },
  {
    name: 'Tauri Rust updater command checks Nebutra Pebble GitHub release readiness',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/updater.rs',
    expect: (text) =>
      text.includes(
        'const ATOM_FEED_URL: &str = "https://github.com/nebutra/pebble/releases.atom"'
      ) &&
      text.includes('pub async fn updater_check_latest_release') &&
      text.includes('has_ready_platform_manifest') &&
      text.includes('latest-mac.yml') &&
      text.includes('is_perf_prerelease_tag') &&
      text.includes('compare_versions')
  },
  {
    name: 'Tauri registers native updater check command with the Rust invoke handler',
    file: 'pebble/desktop-tauri/src-tauri/src/main.rs',
    expect: (text) => text.includes('commands::updater::updater_check_latest_release')
  },
  {
    name: 'Tauri preflight API detects installed agents instead of returning mock empties',
    file: 'pebble/desktop-tauri/src/tauri-preflight-agent-api.ts',
    expect: (text) =>
      text.includes('TUI_AGENT_CONFIG') &&
      text.includes('getTuiAgentDetectCommands') &&
      text.includes('export async function detectTauriAgents') &&
      text.includes("invoke<string[]>('preflight_detect_commands'") &&
      text.includes('export async function refreshTauriAgents') &&
      text.includes('hydrateShellPath()') &&
      text.includes("invoke<PreflightShellPath>('preflight_hydrate_shell_path')")
  },
  {
    name: 'Tauri Rust preflight command performs native PATH command detection',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/preflight.rs',
    expect: (text) =>
      text.includes('pub fn preflight_detect_commands') &&
      text.includes('fn is_command_on_path') &&
      text.includes('fn common_agent_install_dirs') &&
      text.includes('PATHEXT') &&
      text.includes('/opt/homebrew/bin')
  },
  {
    name: 'Tauri registers native preflight command detection with the Rust invoke handler',
    file: 'pebble/desktop-tauri/src-tauri/src/main.rs',
    expect: (text) => text.includes('commands::preflight::preflight_detect_commands')
  },
  {
    name: 'Tauri git base-ref API backs the canonical branch picker with native git refs',
    file: 'pebble/desktop-tauri/src/tauri-git-base-ref-api.ts',
    expect: (text) =>
      text.includes('export async function getTauriBaseRefDefault') &&
      text.includes("invoke<BaseRefDefaultResult>('git_get_base_ref_default'") &&
      text.includes('export async function searchTauriBaseRefDetails') &&
      text.includes("invoke<BaseRefSearchResult[]>('git_search_base_ref_details'") &&
      text.includes('export async function resolveTauriPrBase') &&
      text.includes("invokeReviewStartPoint('git_resolve_pr_start_point'") &&
      text.includes('export async function resolveTauriMrBase') &&
      text.includes("invokeReviewStartPoint('git_resolve_mr_start_point'") &&
      text.includes("repo.kind === 'folder'")
  },
  {
    name: 'Tauri Rust git base-ref commands query local refs without Electron IPC',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/git_refs.rs',
    expect: (text) =>
      text.includes('pub fn git_search_base_ref_details') &&
      text.includes('pub fn git_get_base_ref_default') &&
      text.includes('pub fn git_resolve_pr_start_point') &&
      text.includes('pub fn git_resolve_mr_start_point') &&
      text.includes('for-each-ref') &&
      text.includes('refs/remotes') &&
      text.includes('resolve_local_branch_name') &&
      text.includes('fetch_github_pr_head_sha') &&
      text.includes('refs/merge-requests/{}/head')
  },
  {
    name: 'Tauri registers native git base-ref commands with the Rust invoke handler',
    file: 'pebble/desktop-tauri/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::git_refs::git_get_base_ref_default') &&
      text.includes('commands::git_refs::git_search_base_ref_details') &&
      text.includes('commands::git_refs::git_resolve_pr_start_point') &&
      text.includes('commands::git_refs::git_resolve_mr_start_point') &&
      text.includes('commands::hooks::hooks_create_issue_command_runner')
  },
  {
    name: 'Tauri Vite aliases @ to the canonical renderer source and emits packaged relative assets',
    file: 'pebble/desktop-tauri/vite.config.ts',
    expect: (text) =>
      text.includes("base: './'") &&
      text.includes("const rendererSource = resolve(repoRoot, 'src/renderer/src')") &&
      text.includes("'@': rendererSource") &&
      text.includes("dedupe: ['react', 'react-dom']")
  },
  {
    name: 'Tauri CSS imports the canonical renderer stylesheet',
    file: 'pebble/desktop-tauri/src/pebble-renderer.css',
    expect: (text) =>
      text.includes("@import '../../../src/renderer/src/assets/main.css';") &&
      text.includes("@source '../../../src/renderer/src';")
  },
  {
    name: 'Roadmap declares Tauri as the desktop mainline and Electron as parity-only',
    file: 'ROADMAP.md',
    expect: (text) =>
      text.includes('Tauri desktop mainline migration') &&
      text.includes('Electron is a parity reference only')
  },
  {
    name: 'Root package exposes the Tauri mainline verifier',
    file: 'package.json',
    expect: (text) =>
      text.includes('"verify:tauri-mainline": "node config/scripts/verify-tauri-mainline.mjs"') &&
      text.includes('"build:tauri:no-bundle":') &&
      text.includes('"build:tauri:bundle":')
  },
  {
    name: 'Tauri desktop package exposes bundled and no-bundle build scripts',
    file: 'pebble/desktop-tauri/package.json',
    expect: (text) =>
      text.includes('"tauri:build": "tauri build --ci --bundles app"') &&
      text.includes('"tauri:build:all": "tauri build --ci"') &&
      text.includes('"tauri:build:no-bundle": "tauri build --ci --no-bundle"')
  },
  {
    name: 'PR workflow runs the Tauri mainline verifier',
    file: '.github/workflows/pr.yml',
    expect: (text) =>
      text.includes('Verify Tauri desktop mainline contract') &&
      text.includes('pnpm verify:tauri-mainline') &&
      text.includes('Build Tauri desktop shell') &&
      text.includes('pnpm build:tauri:no-bundle')
  },
  {
    name: 'Tauri desktop release workflow builds the Tauri app across desktop platforms',
    file: '.github/workflows/tauri-desktop-release.yml',
    expect: (text) =>
      text.includes('tauri-apps/tauri-action@v1') &&
      text.includes('projectPath: pebble/desktop-tauri') &&
      text.includes('macos-universal') &&
      text.includes('--target universal-apple-darwin --bundles app') &&
      text.includes('linux-x64') &&
      text.includes('linux-arm64') &&
      text.includes('windows-x64')
  }
]

const failures = []

for (const check of checks) {
  const text = await readFile(resolve(repoRoot, check.file), 'utf8')
  if (!check.expect(text)) {
    failures.push(`${check.name}: ${check.file}`)
  }
}

const tauriRendererTsxFiles = await listFiles(resolve(repoRoot, 'pebble/desktop-tauri/src')).then(
  (files) =>
    files
      .filter((file) => file.endsWith('.tsx'))
      .map((file) => file.replace(`${resolve(repoRoot)}/`, ''))
      .sort()
)
const allowedTauriRendererTsxFiles = ['pebble/desktop-tauri/src/main.tsx']
const localTauriUiFiles = tauriRendererTsxFiles.filter(
  (file) => !allowedTauriRendererTsxFiles.includes(file)
)
if (localTauriUiFiles.length > 0) {
  failures.push(
    `Tauri must mount the canonical renderer, not local mock UI. Unexpected TSX files: ${localTauriUiFiles.join(', ')}`
  )
}

const tauriConfig = JSON.parse(
  await readFile(resolve(repoRoot, 'pebble/desktop-tauri/src-tauri/tauri.conf.json'), 'utf8')
)
const mainWindow = tauriConfig.app?.windows?.[0]
const expectedBundleIcons = [
  '../../../resources/build/icon.png',
  '../../../resources/build/icon.icns',
  '../../../resources/build/icon.ico'
]
const tauriConfigFailures = [
  ['productName', tauriConfig.productName, 'Pebble'],
  ['identifier', tauriConfig.identifier, 'nebutra.pebble'],
  ['devUrl', tauriConfig.build?.devUrl, 'http://127.0.0.1:5174'],
  ['bundle.active', tauriConfig.bundle?.active, true],
  ['deepLinkScheme', tauriConfig.plugins?.['deep-link']?.desktop?.schemes?.[0], 'pebble'],
  ['width', mainWindow?.width, 1200],
  ['height', mainWindow?.height, 800],
  ['minWidth', mainWindow?.minWidth, 600],
  ['minHeight', mainWindow?.minHeight, 400]
].filter(([, actual, expected]) => actual !== expected)

for (const [field, actual, expected] of tauriConfigFailures) {
  failures.push(
    `Tauri config ${field} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}

if (JSON.stringify(tauriConfig.bundle?.icon) !== JSON.stringify(expectedBundleIcons)) {
  failures.push(
    `Tauri config bundle.icon must use production freeform icons: ${expectedBundleIcons.join(', ')}`
  )
}

if (failures.length > 0) {
  console.error('Tauri mainline verification failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log('Tauri mainline verification passed.')

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const fullPath = resolve(dir, entry.name)
      return entry.isDirectory() ? listFiles(fullPath) : [fullPath]
    })
  )
  return files.flat()
}
