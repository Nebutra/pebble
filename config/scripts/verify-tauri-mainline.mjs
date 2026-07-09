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
      text.includes("import { installTauriRuntimePtyApi } from './tauri-runtime-pty-api'") &&
      text.includes('installTauriRuntimePtyApi()') &&
      text.includes("import { installTauriUpdaterApi } from './tauri-updater-api'") &&
      text.includes('installTauriUpdaterApi()') &&
      text.includes("import { installTauriBrowserRuntimeApi } from './tauri-browser-runtime-api'") &&
      text.includes('installTauriBrowserRuntimeApi()') &&
      text.includes("import { installTauriShellApi } from './tauri-shell-api'") &&
      text.includes('installTauriShellApi()')
  },
  {
    name: 'Tauri preload installs the web-compatible API bridge',
    file: 'pebble/desktop-tauri/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes("import { installWebPreloadApi } from '@/web/web-preload-api'") &&
      text.includes("from './pebble-tauri-runtime-control-api'") &&
      text.includes('createPebbleRuntimeEnvironmentsApi(api.runtimeEnvironments)') &&
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
      text.includes('callPebbleRuntimeMethod(method, params)') &&
      text.includes('readOrCreateRuntimeStatus(graph)')
  },
  {
    name: 'Tauri workspace API maps canonical renderer repos and worktrees to runtime resources',
    file: 'pebble/desktop-tauri/src/pebble-tauri-workspace-runtime-api.ts',
    expect: (text) =>
      text.includes('export function createPebbleReposApi') &&
      text.includes("'/v1/projects'") &&
      text.includes('export function createPebbleWorktreesApi') &&
      text.includes("'/v1/worktrees'") &&
      text.includes('MANAGED_WORKTREE_OWNERSHIP') &&
      text.includes('createRuntimeWorktree(args)')
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
      text.includes("onTerminalZoom: subscribeTerminalZoom") &&
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
      text.includes('getMainBufferSnapshot: getRuntimePtyBufferSnapshot') &&
      text.includes('window.api.worktrees.listAll()')
  },
  {
    name: 'Tauri updater API surfaces status instead of silently no-oping',
    file: 'pebble/desktop-tauri/src/tauri-updater-api.ts',
    expect: (text) =>
      text.includes('export function installTauriUpdaterApi') &&
      text.includes('getVersion: () => Promise.resolve(rootPackage.version)') &&
      text.includes("state: 'checking'") &&
      text.includes('Tauri updater is not configured yet') &&
      text.includes('updaterStatusListeners')
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
    name: 'Tauri registers native runtime environment commands with the Rust invoke handler',
    file: 'pebble/desktop-tauri/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::runtime_environments::runtime_environments_list') &&
      text.includes('commands::runtime_environments::runtime_environments_add_from_pairing_code') &&
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
      text.includes("`/v1/browser/profiles/${encodeURIComponent(args.profileId)}`") &&
      text.includes("`/v1/browser/downloads/${encodeURIComponent(args.downloadId)}`") &&
      text.includes("status: 'degraded'") &&
      text.includes("'runtime-browser-profiles'") &&
      text.includes("'runtime-browser-events'")
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
    name: 'Tauri Vite aliases @ to the canonical renderer source',
    file: 'pebble/desktop-tauri/vite.config.ts',
    expect: (text) =>
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

const tauriRendererTsxFiles = await listFiles(resolve(repoRoot, 'pebble/desktop-tauri/src'))
  .then((files) =>
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
const tauriConfigFailures = [
  ['productName', tauriConfig.productName, 'Pebble'],
  ['identifier', tauriConfig.identifier, 'nebutra.pebble'],
  ['devUrl', tauriConfig.build?.devUrl, 'http://127.0.0.1:5174'],
  ['bundle.active', tauriConfig.bundle?.active, true],
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
