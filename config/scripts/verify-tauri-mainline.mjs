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
      text.includes("import { installTauriShellApi } from './tauri-shell-api'") &&
      text.includes('installTauriShellApi()') &&
      text.includes("import { installTauriDeepLinkApi } from './tauri-deep-link-api'") &&
      text.includes('installTauriDeepLinkApi()')
  },
  {
    name: 'Tauri preload installs the web-compatible API bridge',
    file: 'pebble/desktop-tauri/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes("import { installWebPreloadApi } from '@/web/web-preload-api'") &&
      text.includes("from './pebble-tauri-runtime-control-api'") &&
      text.includes("from './tauri-crash-reports-api'") &&
      text.includes("from './tauri-diagnostics-api'") &&
      text.includes("from './tauri-preflight-agent-api'") &&
      text.includes('createPebbleRuntimeEnvironmentsApi(api.runtimeEnvironments)') &&
      text.includes('createPebbleCrashReportsApi(api.crashReports)') &&
      text.includes('createPebbleDiagnosticsApi(api.diagnostics)') &&
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
      text.includes("code: 'remote_subscription_unavailable'") &&
      !text.includes('getTerminalDrivers: () => Promise.resolve([])') &&
      !text.includes('getBrowserDrivers: () => Promise.resolve([])')
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
      text.includes('createRuntimeWorktree(args)') &&
      text.includes('removeRuntimeWorktreeById(worktreeId, { force })') &&
      text.includes('deleteRuntimeWorktree(worktreeId, options)') &&
      text.includes('executeGit: true') &&
      text.includes('resolveDefaultCreateProjectParent') &&
      text.includes("joinNativePath(await homeDir(), 'pebble', 'workspaces')") &&
      text.includes('subscribeWorktreeCreateProgress(callback)') &&
      text.includes("emitWorktreeCreateProgress(args.creationId, 'fetching')") &&
      text.includes("emitWorktreeCreateProgress(args.creationId, 'creating')") &&
      text.includes(
        "requestRuntimeJson<RuntimeWorktreeLineageListResponse>('/v1/worktrees/lineage'"
      ) &&
      text.includes("'/v1/worktrees/sort-order'") &&
      text.includes("method: 'PATCH'") &&
      text.includes('parentWorkspace') &&
      text.includes("readRuntimeEvents('project.changed')") &&
      text.includes("readRuntimeEvents('worktree.changed')") &&
      text.includes('subscribeWorktreeChanged(callback)')
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
      text.includes('export function installTauriMenuApi') &&
      text.includes('Menu.new({ items: await buildTauriMenuTemplate() })') &&
      text.includes('setAsAppMenu()') &&
      text.includes('popup(undefined, getCurrentWindow())') &&
      text.includes('onTerminalZoom: subscribeTerminalZoom') &&
      text.includes("emitEmptyUiEvent('appMenuPaste')") &&
      text.includes('Check for Updates...') &&
      text.includes('setZoom(Math.pow(1.2, level))') &&
      text.includes('await buildTauriAppearanceMenuItems(rebuildTauriApplicationMenu)')
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
      text.includes('connect_async(&pairing.endpoint)') &&
      text.includes('"type": "e2ee_hello"') &&
      text.includes('"type": "e2ee_auth"') &&
      text.includes('SalsaBox') &&
      text.includes('validate_runtime_rpc_response')
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
      text.includes('commands::runtime_environments::runtime_environments_disconnect')
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
      text.includes('TAURI_BROWSER_GUEST_UNAVAILABLE') &&
      text.includes('ensureTauriBrowserRuntimeEventPump()') &&
      text.includes('ensureTauriBrowserProviderRefresh()')
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
      text.includes("'/v1/browser/profiles'") &&
      text.includes("'/v1/browser/tabs'") &&
      text.includes('Browser cookie import requires the Tauri WebView adapter.')
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
      text.includes("repo.kind === 'folder'")
  },
  {
    name: 'Tauri Rust git base-ref commands query local refs without Electron IPC',
    file: 'pebble/desktop-tauri/src-tauri/src/commands/git_refs.rs',
    expect: (text) =>
      text.includes('pub fn git_search_base_ref_details') &&
      text.includes('pub fn git_get_base_ref_default') &&
      text.includes('for-each-ref') &&
      text.includes('refs/remotes') &&
      text.includes('resolve_local_branch_name')
  },
  {
    name: 'Tauri registers native git base-ref commands with the Rust invoke handler',
    file: 'pebble/desktop-tauri/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::git_refs::git_get_base_ref_default') &&
      text.includes('commands::git_refs::git_search_base_ref_details')
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
