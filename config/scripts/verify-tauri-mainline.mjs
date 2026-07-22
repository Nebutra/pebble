import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { scanLegacyBrandIdentifiers } from './legacy-brand-identifier-scan.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')

function quoteStable(text) {
  return text.replaceAll('"', "'")
}

function matchesAcrossQuoteStyles(check, text) {
  // Formatting must not invalidate architecture gates that inspect equivalent JS literals.
  return (
    check.expect(text) || check.expect(quoteStable(text)) || check.expect(text.replaceAll("'", '"'))
  )
}

const checks = [
  {
    name: 'Real runtime gate proves GitHub and GitLab Checks through the canonical panel',
    file: 'config/scripts/run-tauri-real-runtime-gate.mjs',
    expect: (text) =>
      text.includes('seedGitHubFixture(providerBin)') &&
      text.includes('seedGitLabFixture(providerBin)') &&
      text.includes('gitLabChecksPanelMounted') &&
      text.includes('Pebble GitLab Linux')
  },
  {
    name: 'Tauri pixel parity has an edge-jitter-bounded screenshot heatmap gate',
    file: 'config/scripts/compare-desktop-parity-screenshots.mjs',
    expect: (text) =>
      text.includes(
        'Desktop parity screenshots must have equal widths and near-identical heights'
      ) &&
      text.includes('MAX_WINDOW_EDGE_DELTA_PX = 4') &&
      text.includes('DEFAULT_MAX_MISMATCH_RATIO = 0.015') &&
      text.includes('mismatchRatio <= maxMismatchRatio') &&
      text.includes('writeFileSync(options.diffPath, result.diffBytes)') &&
      text.includes('if (!result.matches) process.exitCode = 1')
  },
  {
    name: 'Tauri debug shell captures the primary renderer without window chrome',
    file: 'apps/desktop/src-tauri/src/commands/renderer_parity_capture.rs',
    expect: (text) =>
      text.includes('const CAPTURE_PATH_ENV: &str = "PEBBLE_PARITY_CAPTURE_PATH"') &&
      text.includes('primary.label() != webview.label()') &&
      text.includes('capture_platform_webview') &&
      text.includes('BrowserScreenshotFormat::Png') &&
      text.includes('CaptureSurface::Crash') &&
      text.includes('CaptureSurface::Settings') &&
      text.includes('pebble:open-crash-report-dialog') &&
      text.includes('store.getState().openSettingsPage()') &&
      text.includes('write_capture_atomically')
  },
  {
    name: 'Tauri release shell keeps DevTools commands compile-safe and disabled',
    file: 'apps/desktop/src-tauri/src/commands/webview_reload.rs',
    expect: (text) =>
      text.includes('#[cfg(debug_assertions)]') &&
      text.includes('#[cfg(not(debug_assertions))]') &&
      text.includes('pub fn webview_toggle_devtools(_window: WebviewWindow) -> bool')
  },
  {
    name: 'Tauri statically links the Zig system ABI for every desktop target',
    file: 'apps/desktop/src-tauri/build.rs',
    expect: (text) =>
      text.includes('build_zig_system();') &&
      text.includes('cargo:rustc-link-lib=static=pebble_system') &&
      text.includes('configure_local_speech_runtime_paths') &&
      text.includes('@loader_path/../Frameworks') &&
      text.includes('$ORIGIN/../lib') &&
      text.includes('target == "universal-apple-darwin"') &&
      text.includes('Command::new("lipo")')
  },
  {
    name: 'Tauri validates and consumes the linked Zig ABI',
    file: 'apps/desktop/src-tauri/src/zig_system.rs',
    expect: (text) =>
      text.includes('EXPECTED_ABI_VERSION') &&
      text.includes('pebble_system_abi_version') &&
      text.includes('pebble_system_signal_send_pid') &&
      text.includes('pub fn kill_process')
  },
  {
    name: 'Tauri-owned Go runtime shutdown uses the Zig system signal boundary',
    file: 'apps/desktop/src-tauri/src/commands/runtime_process.rs',
    expect: (text) =>
      text.includes('crate::zig_system::kill_process(child.id())') &&
      text.includes('kill_runtime_child(&mut self.child)') &&
      text.includes('kill_runtime_child(&mut handle.child)')
  },
  {
    name: 'Tauri release CI installs and tests the Zig system layer',
    file: '.github/workflows/tauri-desktop-release.yml',
    expect: (text) =>
      text.includes('uses: mlugg/setup-zig@v2') &&
      text.includes('working-directory: native/zig-system') &&
      text.includes('run: zig build test')
  },
  {
    name: 'Tauri release matrix executes native tests on every desktop platform',
    file: '.github/workflows/tauri-desktop-release.yml',
    expect: (text) =>
      text.includes('Test Go runtime') &&
      text.includes('Test native Tauri host') &&
      text.includes('Test Tauri renderer bridge') &&
      text.includes(
        'xvfb-run --auto-servernum dbus-run-session -- pnpm verify:tauri-real-runtime'
      ) &&
      text.includes("if: runner.os != 'Linux'") &&
      text.includes('run: pnpm verify:tauri-real-runtime') &&
      text.includes(
        'pnpm --filter @pebble/desktop typecheck && pnpm --filter @pebble/desktop exec vitest run'
      ) &&
      text.includes('working-directory: runtime/go') &&
      text.includes('run: go test ./...') &&
      text.includes(
        'cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features'
      ) &&
      !text.includes(
        'cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features --no-run'
      )
  },
  {
    name: 'Tauri browser automation executes selectors and canonical refs through live child WebViews',
    file: 'packages/product-core/renderer/src/components/browser-pane/tauri-browser-dom-automation.ts',
    expect: (text) =>
      text.includes('TAURI_BROWSER_SELECTOR_ROUTING_RUNTIME') &&
      text.includes('clearAutomationRefs()') &&
      text.includes('routedElements(root)') &&
      text.includes("command==='keypress'") &&
      text.includes("command==='scrollIntoView'") &&
      text.includes("command==='select'") &&
      text.includes("command==='check'") &&
      text.includes("command==='selectAll'") &&
      text.includes("command==='drag'") &&
      text.includes("command==='wait'") &&
      text.includes("command==='captureStart'") &&
      text.includes("command==='setMedia'") &&
      text.includes("command==='network'")
  },
  {
    name: 'Tauri browser dialogs retain native platform completion objects',
    file: 'apps/desktop/src-tauri/src/commands/browser_script_dialog.rs',
    expect: (text) =>
      text.includes('runJavaScriptAlertPanelWithMessage') &&
      text.includes('runJavaScriptConfirmPanelWithMessage') &&
      text.includes('runJavaScriptTextInputPanelWithPrompt') &&
      text.includes('PendingDialog::Confirm') &&
      text.includes('PendingDialog::Prompt') &&
      text.includes('MANAGED_WEBVIEWS') &&
      text.includes('connect_script_dialog') &&
      text.includes('add_ScriptDialogOpening') &&
      text.includes('GetDeferral') &&
      text.includes('pub fn resolve(')
  },
  {
    name: 'Tauri browser RPC routes dialog accept and dismiss to child WebViews',
    file: 'apps/desktop/src/tauri-browser-runtime-rpc.ts',
    expect: (text) =>
      text.includes("case 'browser.dialogAccept':") &&
      text.includes("case 'browser.dialogDismiss':") &&
      text.includes('resolveTauriBrowserPageDialog')
  },
  {
    name: 'Tauri browser RPC queues core DOM interactions through the Go provider path',
    file: 'apps/desktop/src/tauri-browser-runtime-rpc.ts',
    expect: (text) =>
      text.includes("case 'browser.snapshot':") &&
      text.includes("case 'browser.click':") &&
      text.includes("case 'browser.fill':") &&
      text.includes("case 'browser.keypress':") &&
      text.includes("case 'browser.select':") &&
      text.includes("case 'browser.check':") &&
      text.includes("case 'browser.drag':") &&
      text.includes("case 'browser.upload':") &&
      text.includes("case 'browser.get':") &&
      text.includes("case 'browser.is':") &&
      text.includes("case 'browser.find':") &&
      text.includes("case 'browser.keyboardInsertText':") &&
      text.includes("case 'browser.fullScreenshot':") &&
      text.includes("case 'browser.wait':") &&
      text.includes("case 'browser.capture.start':") &&
      text.includes("case 'browser.console':") &&
      text.includes("case 'browser.intercept.enable':") &&
      text.includes("case 'browser.intercept.list':") &&
      text.includes("case 'browser.geolocation':") &&
      text.includes("case 'browser.setMedia':") &&
      text.includes("case 'browser.setDevice':") &&
      text.includes("case 'browser.setHeaders':") &&
      text.includes("case 'browser.setOffline':") &&
      text.includes("case 'browser.setCredentials':") &&
      text.includes("case 'browser.exec':") &&
      text.includes('queueTauriBrowserInteraction')
  },
  {
    name: 'macOS browser direct mouse input uses deferred AppKit responder delivery',
    file: 'apps/desktop/src-tauri/src/commands/browser_native_input_macos.rs',
    expect: (text) =>
      text.includes('NSEvent::mouseEventWithType') &&
      text.includes('tokio::time::sleep(Duration::from_millis(16))') &&
      text.includes('responder.mouseMoved(&event)')
  },
  {
    name: 'Tauri browser direct mouse commands cross the native input trust boundary on macOS',
    file: 'packages/product-core/renderer/src/components/browser-pane/tauri-browser-page-webview.ts',
    expect: (text) =>
      text.includes("case 'mouseMove':") &&
      text.includes("case 'mouseClick':") &&
      text.includes("'browser_child_webview_input'") &&
      text.includes("navigator.userAgent.includes('Mac')")
  },
  {
    name: 'Tauri selector clicks resolve geometry before crossing the native input boundary',
    file: 'packages/product-core/renderer/src/components/browser-pane/tauri-browser-page-webview.ts',
    expect: (text) =>
      text.includes("executeTauriBrowserDomAction(state, 'resolvePoint'") &&
      text.includes("executeTauriBrowserNativeMouseAction(state, 'mouseMove'") &&
      text.includes("executeTauriBrowserNativeMouseAction(state, 'mouseClick'") &&
      text.includes('executeTauriBrowserNativeElementHover')
  },
  {
    name: 'Tauri selector text input uses the focused macOS AppKit responder',
    file: 'packages/product-core/renderer/src/components/browser-pane/tauri-browser-page-webview.ts',
    expect: (text) =>
      text.includes('executeTauriBrowserNativeTextAction') &&
      text.includes("action: { kind: 'textInput', text, replace: command === 'fill' }") &&
      text.includes("executeTauriBrowserDomAction(state, 'resolvePoint', { element, focus: true })")
  },
  {
    name: 'macOS browser native text input preserves WebKit editing semantics',
    file: 'apps/desktop/src-tauri/src/commands/browser_native_input_macos.rs',
    expect: (text) =>
      text.includes('BrowserNativeInputAction::TextInput') &&
      text.includes('responder.selectAll(None)') &&
      text.includes('responder.insertText(&text)')
  },
  {
    name: 'macOS browser key input uses bounded AppKit responder events',
    file: 'apps/desktop/src-tauri/src/commands/browser_native_key_macos.rs',
    expect: (text) =>
      text.includes('NSEvent::keyEventWithType') &&
      text.includes('BrowserKeyPhase::Press') &&
      text.includes('responder.keyDown(&event)') &&
      text.includes('responder.keyUp(&event)')
  },
  {
    name: 'macOS browser wheel and drag input remain native and ordered',
    file: 'apps/desktop/src-tauri/src/commands/browser_native_input_macos.rs',
    expect: (text) =>
      text.includes('CGEvent::new_scroll_wheel_event2') &&
      text.includes('window.sendEvent(relative_event)') &&
      text.includes('drag_input::dispatch_drag_input')
  },
  {
    name: 'macOS browser drag uses the signed permission-owning helper off the main thread',
    file: 'apps/desktop/src-tauri/src/commands/browser_native_drag_macos.rs',
    expect: (text) =>
      text.includes('computer_use_helper_executable') &&
      text.includes('resolve_window_points') &&
      text.includes('spawn_blocking') &&
      text.includes('.call("drag", &params)')
  },
  {
    name: 'macOS Tauri release stages the signed computer-use helper before sealing the app',
    file: 'apps/desktop/scripts/prepare-macos-bundle-resources.mjs',
    expect: (text) =>
      text.includes('build-computer-macos.mjs') &&
      text.includes('stage-macos-speech-libraries.mjs') &&
      text.includes("platform !== 'darwin'")
  },
  {
    name: 'macOS Tauri configuration owns helper resources and main entitlements',
    files: [
      'apps/desktop/src-tauri/tauri.conf.json',
      'apps/desktop/src-tauri/tauri.macos.conf.json'
    ],
    expect: (text) =>
      text.includes('../../../resources/build/entitlements.mac.plist') &&
      text.includes('prepare-macos-bundle-resources.mjs') &&
      text.includes('Pebble Computer Use.app')
  },
  {
    name: 'Tauri browser selector check and select cross the macOS native input boundary',
    file: 'packages/product-core/renderer/src/components/browser-pane/tauri-browser-page-webview.ts',
    expect: (text) =>
      text.includes('executeTauriBrowserNativeCheckAction') &&
      text.includes('executeTauriBrowserNativeSelectAction') &&
      text.includes("executeTauriBrowserDomAction(state, 'resolveSelectOption'") &&
      text.includes("executeTauriBrowserNativeKeyAction(state, 'keypress', { key: 'Home' })")
  },
  {
    name: 'macOS real-runtime gates separate permission-free WKWebView input from authorized drag',
    files: [
      'package.json',
      'config/scripts/run-tauri-real-runtime-gate.mjs',
      'config/scripts/tauri-native-input-fixture.mjs',
      'apps/desktop/src/tauri-real-runtime-gate.ts',
      'apps/desktop/src/tauri-real-runtime-native-input-evidence.ts'
    ],
    expect: (text) =>
      text.includes('verify:tauri-real-runtime:native-input') &&
      text.includes('verify:tauri-real-runtime:native-drag') &&
      text.includes('--native-input-only') &&
      text.includes('--native-drag-only') &&
      text.includes('ensureTauriBrowserPageWebview') &&
      text.includes('window.api.browser.registerGuest') &&
      text.includes("accessibilityStatus !== 'not-granted'") &&
      text.includes("['reset', 'Accessibility', 'nebutra.pebble.functional-gate']") &&
      text.includes('browserFunctionalGateAccessibilityReset') &&
      text.includes("backend !== 'appkit-async-responder'") &&
      text.includes('browserTrustedMouseInput: true') &&
      text.includes('browserTrustedKeyInput: true') &&
      text.includes('browserTrustedTextInput: true') &&
      text.includes('browserTrustedWheelInput: true') &&
      text.includes('browserTrustedDragInput: false') &&
      text.includes('verifyMacosTrustedBrowserDrag') &&
      text.includes("accessibilityStatus !== 'granted'") &&
      text.includes('browserTrustedDragInput: true') &&
      text.includes('browserTrustedCheckInput: true') &&
      text.includes('browserTrustedSelectInput: true') &&
      text.includes('browserTrustedFrameShadowInput: true') &&
      text.includes('event.isTrusted') &&
      !text.includes('dispatchEvent(')
  },
  {
    name: 'Windows browser input dispatches through WebView2 CDP instead of DOM events',
    file: 'apps/desktop/src-tauri/src/commands/browser_native_input_windows.rs',
    expect: (text) =>
      text.includes('Input.dispatchMouseEvent') &&
      text.includes('Input.dispatchKeyEvent') &&
      text.includes('Input.insertText') &&
      text.includes('CallDevToolsProtocolMethod') &&
      text.includes('webview2_com::wait_with_pump')
  },
  {
    name: 'Linux browser input dispatches trusted GDK events through WebKitGTK',
    file: 'apps/desktop/src-tauri/src/commands/browser_native_input_linux.rs',
    expect: (text) =>
      text.includes('gdk::Event::new') &&
      text.includes('webview.event(event)') &&
      text.includes('GdkEventMotion') &&
      text.includes('GdkEventButton') &&
      text.includes('GdkEventScroll') &&
      text.includes('GdkEventKey') &&
      !text.includes('eval(') &&
      !text.includes('dispatchEvent')
  },
  {
    name: 'Tauri promotes the configured primary window without assuming the main label',
    file: 'apps/desktop/src-tauri/src/primary_window.rs',
    expect: (text) =>
      text.includes('pub fn window<R: Runtime>') &&
      text.includes('pub fn webview_window<R: Runtime>') &&
      text.includes('app.windows().into_values().next()') &&
      text.includes('app.webview_windows().into_values().next()') &&
      text.includes('app.get_window("main")')
  },
  {
    name: 'Tauri browser child WebViews attach to the configured primary shell window',
    file: 'apps/desktop/src-tauri/src/commands/browser_child_webview.rs',
    expect: (text) =>
      text.includes('crate::primary_window::window(&app)') && !text.includes('.get_window("main")')
  },
  {
    name: 'Tauri restores and atomically persists visible main-window state',
    file: 'apps/desktop/src-tauri/src/window_state.rs',
    expect: (text) =>
      text.includes('bounds_are_restorable') &&
      text.includes('physical_to_logical_bounds') &&
      text.includes('LOGICAL_BOUNDS_VERSION') &&
      text.includes('MIN_WIDTH / 2') &&
      text.includes('MIN_HEIGHT / 2') &&
      text.includes('write_state_atomic') &&
      text.includes('old debounce cannot overwrite the synchronous exit snapshot') &&
      text.includes('serialize the terminal write with debounce writers') &&
      text.includes('state.document.maximized = maximized') &&
      text.includes('if !maximized')
  },
  {
    name: 'macOS release runtime measures first frame and native minimize resume without forged display evidence',
    files: [
      'config/scripts/run-tauri-real-runtime-gate.mjs',
      'config/scripts/window-lifecycle-evidence.mjs',
      'apps/desktop/src/tauri-window-lifecycle-measurement.ts'
    ],
    expect: (text) =>
      text.includes('PEBBLE_FUNCTIONAL_GATE_LAUNCH_EPOCH_MS') &&
      text.includes('measureTauriWindowLifecycle') &&
      text.includes("invoke<boolean>('functional_gate_minimize')") &&
      text.includes("invoke<boolean>('functional_gate_restore_and_focus')") &&
      text.includes('performance.timeOrigin') &&
      text.includes(
        "multiDisplayRestore: monitors.length < 2 ? 'unavailable' : 'requires-relaunch'"
      ) &&
      text.includes("platform !== 'darwin'") &&
      text.includes("multiDisplayRestore !== 'passed'")
  },
  {
    name: 'Tauri window config no longer forces maximized launch state',
    file: 'apps/desktop/src-tauri/tauri.conf.json',
    expect: (text) => text.includes('"maximized": false')
  },
  {
    name: 'Tauri native menus use renderer localization and rebuild on language changes',
    file: 'apps/desktop/src/tauri-menu-api.ts',
    expect: (text) =>
      text.includes('translate(`menu.${key}`, fallback)') &&
      text.includes("i18n.on('languageChanged', rebuildTauriApplicationMenu)") &&
      text.includes("menuText('toggleDevTools'") &&
      text.includes("menuText('toggleFullscreen'") &&
      text.includes("menuText('reportCrash'")
  },
  {
    name: 'Tauri owns the persisted star prompt state machine instead of web no-ops',
    file: 'apps/desktop/src/tauri-star-nag-api.ts',
    expect: (text) =>
      text.includes('window.api.agentStatus.onSet') &&
      text.includes("checkPebbleStarred: () => invoke<boolean | null>('star_nag_check')") &&
      text.includes("starPebble: () => invoke<boolean>('star_nag_star')") &&
      text.includes('window.api.stats.getSummary()') &&
      text.includes('starNagBaselineAgents') &&
      text.includes('starNagNextThreshold') &&
      text.includes('starNagAgentValueMomentAppVersion') &&
      text.includes("invoke<boolean>('star_nag_star')")
  },
  {
    name: 'Tauri AI Vault lists real Go-scanned sessions instead of web empty results',
    file: 'apps/desktop/src/tauri-ai-vault-api.ts',
    expect: (text) =>
      text.includes('/v1/ai-vault/sessions') &&
      text.includes('requestRuntimeJson<AiVaultListResult>') &&
      text.includes('executionHostScope') &&
      text.includes("query.append('scopePath'") &&
      text.includes("method: 'aiVault.listSessions'") &&
      text.includes('listAllRuntimeSessions') &&
      text.includes('rewritePairedRuntimeResult') &&
      text.includes('mergeAiVaultResults') &&
      text.includes('onWindowFocused')
  },
  {
    name: 'Go paired runtimes expose host-local AI Vault history over encrypted RPC',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control_ai_vault.go',
    expect: (text) =>
      text.includes('method != "aiVault.listSessions"') &&
      text.includes('request.ExecutionHostScope = "local"') &&
      text.includes('ListAiVaultSessionsByScope(ctx, request)') &&
      text.includes('ai_vault_scan_failed')
  },
  {
    name: 'Go AI Vault routes local, target SSH, and All hosts through one scoped service',
    file: 'runtime/go/internal/runtimecore/ai_vault.go',
    expect: (text) =>
      text.includes('ListAiVaultSessionsByScope') &&
      text.includes('scope == "all"') &&
      text.includes('strings.HasPrefix(scope, "ssh:")') &&
      text.includes('[]string{"ai-vault-scan-json"') &&
      text.includes('RewriteAiVaultExecutionHost') &&
      text.includes('mergeAiVaultResults') &&
      text.includes('scanScopedAiVaultCandidates') &&
      text.includes('mergeAiVaultSessionsWithoutLimit')
  },
  {
    name: 'Go AI Vault HTTP route preserves host scope and repeated scoped paths',
    file: 'runtime/go/internal/runtimehttp/ai_vault_routes.go',
    expect: (text) =>
      text.includes('query.Get("executionHostScope")') &&
      text.includes('query["scopePath"]') &&
      text.includes('ListAiVaultSessionsByScope(r.Context()')
  },
  {
    name: 'SSH relay worker exposes the bounded native AI Vault scanner',
    file: 'runtime/go/cmd/pebble-relay-worker/main.go',
    expect: (text) =>
      text.includes('case "ai-vault-scan-json":') &&
      text.includes('runAiVaultScanJSON') &&
      text.includes('fs.Var(&scopePaths, "scope-path"') &&
      text.includes('runtimecore.ScanLocalAiVaultSessions')
  },
  {
    name: 'Go AI Vault scans bounded local JSONL agent history with source filtering',
    file: 'runtime/go/internal/runtimecore/ai_vault.go',
    expect: (text) =>
      text.includes('filepath.Join(home, ".claude", "projects")') &&
      text.includes('filepath.Join(codexHome, "sessions")') &&
      text.includes('filepath.Join(copilotHome, "session-state")') &&
      text.includes('filepath.Join(home, ".cursor", "projects")') &&
      text.includes('filepath.Join(home, ".pi", "agent", "sessions")') &&
      text.includes('filepath.Join(home, ".gemini", "tmp")') &&
      text.includes('filepath.Join(home, ".hermes", "sessions")') &&
      text.includes('filepath.Join(home, ".rovodev", "sessions")') &&
      text.includes('filepath.Base(path) == "summary.json"') &&
      text.includes('filepath.Base(path) == "metadata.json"') &&
      text.includes('filepath.Join(home, ".clawdbot", "agents")') &&
      text.includes('filepath.Join(home, ".factory", "sessions")') &&
      text.includes('filepath.Join(home, ".factory", "projects")') &&
      text.includes('filepath.Base(path) == "state.json"') &&
      text.includes('"devin", "kimi"') &&
      text.includes('discoverOpenCodeSQLiteCandidates(opencodeDataDir, discoveryLimit)') &&
      text.includes('sql.Open("sqlite"') &&
      text.includes('dedupeOpenCodeCandidates(candidates)') &&
      text.includes('base = "opencode --session"') &&
      text.includes('pathContainsSegment(path, "agent-transcripts")') &&
      text.includes('selectAiVaultCandidates(candidates, limit)') &&
      text.includes('maxSourceReserve = 20') &&
      text.includes('isClaudeWorkerTranscript') &&
      text.includes('64*1024*1024') &&
      text.includes('ResumeCommand')
  },
  {
    name: 'Tauri Rust host performs bounded GitHub star checks and mutation',
    file: 'apps/desktop/src-tauri/src/commands/star_nag.rs',
    expect: (text) =>
      text.includes('const REPOSITORY: &str = "nebutra/pebble"') &&
      text.includes('COMMAND_TIMEOUT') &&
      text.includes('run_gh(&["auth", "status"])') &&
      text.includes('run_gh(&["api", &endpoint])') &&
      text.includes('run_gh(&["api", "-X", "PUT", &endpoint])') &&
      text.includes('child.kill()')
  },
  {
    name: 'Tauri project Windows runtime preferences persist through Go project records',
    file: 'apps/desktop/src/pebble-tauri-workspace-runtime-api.ts',
    expect: (text) =>
      text.includes('updates.localWindowsRuntimePreference') &&
      text.includes('project.sourceRepoIds.map') &&
      text.includes('localWindowsRuntimePreference: updates.localWindowsRuntimePreference') &&
      text.includes('projectHostSetupProjectionFromRepos(await readRepos())')
  },
  {
    name: 'Tauri runtime exposes complete native project host setup lifecycle',
    file: 'apps/desktop/src/tauri-project-host-setup-runtime-rpc.ts',
    expect: (text) =>
      text.includes("case 'projectHostSetup.list':") &&
      text.includes("case 'project.update':") &&
      text.includes("case 'projectHostSetup.create':") &&
      text.includes("case 'projectHostSetup.setupExistingFolder':") &&
      text.includes("case 'projectHostSetup.update':") &&
      text.includes("case 'projectHostSetup.delete':")
  },
  {
    name: 'Tauri runtime maps workspace port scan and validated termination',
    file: 'apps/desktop/src/tauri-workspace-ports-api.ts',
    expect: (text) =>
      text.includes("method === 'workspacePorts.scan'") &&
      text.includes("method === 'workspacePorts.kill'") &&
      text.includes('requirePort(input.port)')
  },
  {
    name: 'Go validates and stores project Windows runtime preferences',
    file: 'runtime/go/internal/runtimecore/manager.go',
    expect: (text) =>
      text.includes('normalizeLocalWindowsRuntimePreference') &&
      text.includes('case "inherit-global", "windows-host":') &&
      text.includes('case "wsl":') &&
      text.includes('project.LocalWindowsRuntimePreference = &preference')
  },
  {
    name: 'Tauri resolves project git usernames through Go instead of web fallback',
    file: 'apps/desktop/src/pebble-tauri-workspace-runtime-api.ts',
    expect: (text) =>
      text.includes('getGitUsername: async ({ repoId })') &&
      text.includes('/git-username`') &&
      text.includes('return result.username')
  },
  {
    name: 'Go resolves local and SSH project git usernames on the owning host',
    file: 'runtime/go/internal/runtimecore/git_username.go',
    expect: (text) =>
      text.includes('ProjectGitUsername') &&
      text.includes('git-username-json') &&
      text.includes('ResolveExplicitGitUsername') &&
      text.includes('projectEffectiveRemoteIsGitHub') &&
      text.includes('"gh", "api", "user", "-q", ".login"')
  },
  {
    name: 'Tauri joins repo-backed and independent project host setups',
    file: 'apps/desktop/src/pebble-tauri-workspace-runtime-api.ts',
    expect: (text) =>
      text.includes('listHostSetups: readProjectHostSetups') &&
      text.includes('createHostSetup: async') &&
      text.includes('setupExistingFolder: async') &&
      text.includes('setupsByProject') &&
      text.includes('sourceRepoIds: []') &&
      text.includes('logicalProjectId: args.projectId')
  },
  {
    name: 'Go exposes persistent project host setup CRUD routes',
    file: 'runtime/go/internal/runtimehttp/project_host_setup_routes.go',
    expect: (text) =>
      text.includes('ListProjectHostSetups') &&
      text.includes('CreateProjectHostSetup') &&
      text.includes('UpdateProjectHostSetup') &&
      text.includes('DeleteProjectHostSetup')
  },
  {
    name: 'Tauri browser tabs and profiles use real runtime records',
    file: 'apps/desktop/src/tauri-browser-profile-tab-rpc.ts',
    expect: (text) =>
      text.includes('export async function currentBrowserTab') &&
      text.includes('export async function switchBrowserTab') &&
      text.includes('export async function setBrowserTabProfile') &&
      text.includes('export async function showBrowserTabProfile') &&
      text.includes('export async function cloneBrowserTabProfile') &&
      text.includes('deleteTauriBrowserProfileStorage(profileId)') &&
      text.includes('activeBrowserTabByWorktree') &&
      text.includes('notifyTauriBrowserActiveTab')
  },
  {
    name: 'Tauri browser downloads wait for the native destination result',
    file: 'apps/desktop/src-tauri/src/commands/browser_child_webview.rs',
    expect: (text) =>
      text.includes('browser_child_webview_prepare_download') &&
      text.includes('browser_child_webview_wait_download') &&
      text.includes('desired_by_tab') &&
      text.includes('validate_requested_download_path') &&
      text.includes('browser download timed out')
  },
  {
    name: 'Tauri browser PDF uses native WebView bytes on every desktop platform',
    file: 'apps/desktop/src-tauri/src/commands/browser_webview_pdf.rs',
    expect: (text) =>
      text.includes('createPDFWithConfiguration_completionHandler') &&
      text.includes('WKWebView') &&
      text.includes('WKWebView returned no PDF data') &&
      text.includes('ICoreWebView2_7') &&
      text.includes('PrintToPdfCompletedHandler') &&
      text.includes('webview7.PrintToPdf') &&
      text.includes('PrintOperation::new') &&
      text.includes('PRINT_SETTINGS_OUTPUT_FILE_FORMAT') &&
      text.includes('connect_finished') &&
      text.includes('remove_file')
  },
  {
    name: 'Tauri PTY spawn waits for cold runtime startup and replays the initial prompt',
    files: [
      'apps/desktop/src/tauri-runtime-pty-api.ts',
      'apps/desktop/src/tauri-runtime-pty-spawn.ts'
    ],
    expect: (text) =>
      text.includes('spawnRuntimeSessionWhenReady') &&
      text.includes('RUNTIME_SPAWN_READY_TIMEOUT_MS') &&
      text.includes('readRuntimePtyReplay') &&
      text.includes('ensureRuntimePtyEventDelivery()')
  },
  {
    name: 'Fresh native PTY replay is painted through the renderer transport callback',
    file: 'packages/product-core/renderer/src/components/terminal-pane/pty-transport.ts',
    expect: (text) =>
      text.includes('!spawnResult.isReattach') &&
      text.includes('!spawnResult.coldRestore') &&
      text.includes('storedCallbacks.onReplayData?.(spawnResult.replay)')
  },
  {
    name: 'Expired Tauri PTYs preserve the renderer worktree cwd fallback',
    file: 'apps/desktop/src/tauri-runtime-pty-api.ts',
    expect: (text) =>
      text.includes('getCwd: getRuntimePtyCwd') &&
      text.includes("return (await findRuntimeSession(id))?.cwd ?? ''") &&
      !text.includes("getCwd: async (id) => (await findRuntimeSession(id))?.cwd ?? '~'")
  },
  {
    name: 'Setup terminals retry command prefill until a live pane transport accepts it',
    file: 'packages/product-core/renderer/src/components/onboarding/OnboardingInlineCommandTerminal.tsx',
    expect: (text) =>
      text.includes('INSERT_ACCEPT_RETRY_MS') &&
      text.includes('insertCommand((pasted) =>') &&
      text.includes('autoInsertedRef.current = command') &&
      text.includes('requireShellPasteReady: true') &&
      text.includes('onSettled')
  },
  {
    name: 'Programmatic terminal paste acknowledges only a connected PTY transport',
    file: 'packages/product-core/renderer/src/components/terminal-pane/terminal-programmatic-text-paste.ts',
    expect: (text) =>
      text.includes('!transport || !ptyId || !transport.isConnected()') &&
      text.includes('detail.requireShellPasteReady') &&
      text.includes('bracketedPasteMode') &&
      text.includes('detail.onSettled?.(true)') &&
      text.includes('detail.onSettled?.(false)')
  },
  {
    name: 'Go hosted-review create and update cover CLI and REST providers',
    file: 'runtime/go/internal/runtimecore/provider_routes.go',
    expect: (text) =>
      text.includes('case "github":') &&
      text.includes('case "gitlab":') &&
      text.includes('case "bitbucket", "azure-devops", "gitea":') &&
      text.includes('createRESTHostedReview') &&
      text.includes('updateRESTHostedReview') &&
      text.includes('providerrest.DetectReviewProviderCapabilities(remoteURL)')
  },
  {
    name: 'Tauri hosted-review mutations use provider-neutral Go routes',
    file: 'apps/desktop/src/tauri-provider-review-bridge.ts',
    expect: (text) =>
      text.includes('export async function updateHostedReview') &&
      text.includes('"/v1/providers/reviews/update"') &&
      text.includes('export async function mergeHostedReview') &&
      text.includes('"/v1/providers/reviews/merge"') &&
      text.includes('export async function setHostedReviewAutoMerge') &&
      text.includes('"/v1/providers/reviews/auto-merge"') &&
      text.includes('export async function addHostedReviewComment') &&
      text.includes('"/v1/providers/reviews/comments"') &&
      text.includes('export async function addHostedInlineReviewComment') &&
      text.includes('"/v1/providers/reviews/inline-comments"') &&
      text.includes('export async function replyHostedReviewComment') &&
      text.includes('"/v1/providers/reviews/comment-replies"') &&
      text.includes('export async function resolveHostedReviewThread') &&
      text.includes('"/v1/providers/reviews/threads/resolve"') &&
      text.includes('export async function setHostedReviewFileViewed') &&
      text.includes('"/v1/providers/reviews/files/viewed"') &&
      text.includes('addReviewers') &&
      text.includes('removeReviewers')
  },
  {
    name: 'Tauri account runtime RPC returns native account stores and usage',
    file: 'apps/desktop/src/tauri-accounts-runtime-rpc.ts',
    expect: (text) =>
      text.includes('case "accounts.list":') &&
      text.includes('window.api.rateLimits.refresh()') &&
      text.includes('window.api.claudeAccounts.list()') &&
      text.includes('window.api.codexAccounts.list()') &&
      text.includes('case "accounts.selectClaude":') &&
      text.includes('case "accounts.selectCodex":') &&
      text.includes('case "accounts.removeClaude":') &&
      text.includes('case "accounts.removeCodex":') &&
      text.includes('window.api.claudeAccounts.remove') &&
      text.includes('window.api.codexAccounts.remove') &&
      text.includes('readRequiredAccountId')
  },
  {
    name: 'Tauri Codex managed accounts use owned native homes and captive Go PTY login',
    file: 'apps/desktop/src/tauri-accounts-api.ts',
    expect: (text) =>
      text.includes('managed_codex_account_prepare') &&
      text.includes('managed_codex_account_identity') &&
      text.includes('managed_codex_account_remove') &&
      text.includes('["codex", "login"]') &&
      text.includes('CODEX_HOME=${managedHomePath}') &&
      text.includes('activeCodexManagedAccountIdsByRuntime') &&
      text.includes('readSelectedTauriCodexHome')
  },
  {
    name: 'Tauri WSL PTYs route Linux cwd and managed Codex homes inside the distro',
    files: [
      'apps/desktop/src/tauri-runtime-pty-api.ts',
      'apps/desktop/src/tauri-runtime-pty-spawn.ts',
      'runtime/go/internal/runtimecore/session_workspace_wsl.go'
    ],
    expect: (text) =>
      text.includes('projectRuntime.runtime.kind === "wsl"') &&
      text.includes('buildWslInnerCommand') &&
      text.includes('readSelectedTauriCodexWslHome') &&
      text.includes('"wsl.exe", "--distribution", preference.Distro') &&
      text.includes('"wslpath"') &&
      text.includes('"--cd", linuxCwd, "--exec"') &&
      text.includes('refreshWslSessionEnvironment') &&
      text.includes('environment.CODEX_HOME = managedHome')
  },
  {
    name: 'Tauri Claude accounts capture, materialize, select per WSL distro, and cancel natively',
    file: 'apps/desktop/src/tauri-accounts-api.ts',
    expect: (text) =>
      text.includes('managed_claude_account_prepare') &&
      text.includes('managed_claude_account_capture') &&
      text.includes('managed_claude_account_activate') &&
      text.includes('managed_claude_account_remove') &&
      text.includes('buildWslClaudeCommand') &&
      text.includes('activeClaudeManagedAccountIdsByRuntime') &&
      text.includes('cancelPendingClaudeLogin') &&
      text.includes('assertNoLiveClaudeSessions') &&
      !text.includes('if (outgoingAccountId !== accountId) await assertNoLiveClaudeSessions()')
  },
  {
    name: 'Tauri preserves outgoing Claude credentials before live-PTY account selection',
    file: 'apps/desktop/src-tauri/src/commands/managed_claude_accounts.rs',
    expect: (text) =>
      text.includes('if let Some(outgoing) = outgoing_account_id.as_deref()') &&
      text.includes('if let Some(current) = read_active_credentials()?') &&
      text.includes('Could not preserve refreshed Claude credentials') &&
      text.includes('write_active_credentials(&credentials)')
  },
  {
    name: 'Tauri WSL Claude terminals use the distro-selected isolated auth directory',
    files: [
      'apps/desktop/src/tauri-runtime-pty-api.ts',
      'apps/desktop/src/tauri-runtime-pty-spawn.ts'
    ],
    expect: (text) =>
      text.includes('readSelectedTauriClaudeWslAuth') &&
      text.includes('environment.CLAUDE_CONFIG_DIR = managedAuth') &&
      text.includes('delete environment.ANTHROPIC_API_KEY') &&
      text.includes('delete environment.CLAUDE_CODE_OAUTH_TOKEN')
  },
  {
    name: 'Tauri publishes real account and quota snapshots into the Go event owner',
    file: 'apps/desktop/src/tauri-accounts-snapshot-sync.ts',
    expect: (text) =>
      text.includes('/v1/accounts/snapshot') &&
      text.includes('window.api.claudeAccounts.list()') &&
      text.includes('window.api.codexAccounts.list()') &&
      text.includes('window.api.rateLimits.onUpdate')
  },
  {
    name: 'Tauri prefetches inactive managed account usage from isolated host and WSL credentials',
    file: 'apps/desktop/src/tauri-rate-limits-api.ts',
    expect: (text) =>
      text.includes('fetchInactiveClaudeAccounts') &&
      text.includes('fetchInactiveCodexAccounts') &&
      text.includes('rate_limits_fetch_claude_managed') &&
      text.includes('account.wslLinuxAuthPath') &&
      text.includes('account.wslLinuxHomePath') &&
      text.includes('readTauriActiveManagedAccountIds')
  },
  {
    name: 'Go persists and projects account snapshots to paired mobile clients',
    file: 'runtime/go/internal/runtimecore/mobile_relay.go',
    expect: (text) =>
      /ProjectionAccounts\s+ProjectionKind = "accounts"/.test(text) &&
      text.includes('case "accounts.changed":') &&
      text.includes('snapshot.Accounts = m.GetAccountsSnapshot()')
  },
  {
    name: 'Go shared control owns streaming account snapshots and explicit unsubscribe',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control.go',
    expect: (text) =>
      text.includes('case "accounts.subscribe":') &&
      text.includes('Kind: "accounts"') &&
      text.includes('case "accounts.unsubscribe":') &&
      text.includes('case "accounts":') &&
      text.includes('event.Topic == "accounts.changed"') &&
      text.includes('map[string]string{"type": "end"}')
  },
  {
    name: 'Tauri Rust host owns WSL Claude account creation, capture, validation, and removal',
    file: 'apps/desktop/src-tauri/src/commands/managed_claude_accounts.rs',
    expect: (text) =>
      text.includes('prepare_wsl_account') &&
      text.includes('capture_wsl_account') &&
      text.includes('validate_wsl_owned_path') &&
      text.includes('remove_wsl_account') &&
      text.includes('.local/share/pebble/claude-accounts')
  },
  {
    name: 'Tauri settings runtime RPC uses the canonical native-backed settings document',
    file: 'apps/desktop/src/tauri-settings-runtime-rpc.ts',
    expect: (text) =>
      text.includes('readPersistentSettingsRaw') &&
      text.includes('writePersistentSettingsRaw') &&
      text.includes('CLIENT_SETTING_KEYS') &&
      text.includes('validateKnownSettingTypes') &&
      text.includes('reconcileTauriManagedAgentHooks') &&
      text.includes('Unknown settings field')
  },
  {
    name: 'The canonical shared package owns the strict client UI mutation schema',
    file: 'packages/product-core/shared/client-ui-rpc-schema.ts',
    expect: (text) =>
      text.includes('export const ClientUiUpdateSchema') &&
      text.includes('export const FeatureInteractionIdSchema') &&
      text.includes('.strict().default({})')
  },
  {
    name: 'Tauri UI runtime RPC persists validated canonical UI state',
    file: 'apps/desktop/src/tauri-ui-runtime-rpc.ts',
    expect: (text) =>
      text.includes('ClientUiUpdateSchema.parse(params)') &&
      text.includes('FeatureInteractionIdSchema.parse(params)') &&
      text.includes('readPersistentSettingsRaw(UI_STORAGE_KEY)') &&
      text.includes('writePersistentSettingsRaw(UI_STORAGE_KEY') &&
      text.includes('interactionCount')
  },
  {
    name: 'Go shared-control routes browser lifecycle and commands through native provider actions',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control.go',
    expect: (text) =>
      text.includes('case "browser.tabList"') &&
      text.includes('case "browser.tabCreate"') &&
      text.includes('case "browser.profileCreate"') &&
      text.includes('case "browser.goto"') &&
      text.includes('"browser.intercept.enable"') &&
      text.includes('"browser.storage.local.get"') &&
      text.includes('"browser.clipboardPaste"') &&
      text.includes('"browser.eval"') &&
      text.includes('"browser.viewport"') &&
      text.includes('"browser.setCredentials"') &&
      text.includes('"browser.cookie.set"') &&
      text.includes('"browser.dialogAccept"') &&
      text.includes('return "storageSessionClear"') &&
      text.includes('return "cookieSet"') &&
      text.includes('"browser.screencast.v1"') &&
      text.includes('encodeLegacySharedControlBrowserFrame') &&
      text.includes('writeLegacySharedControlEncryptedBinary') &&
      text.includes('QueueBrowserCommand') &&
      text.includes('GetComputerAction') &&
      text.includes('ComputerActionCompleted')
  },
  {
    name: 'Go browser screencast lifecycle owns mobile driver state',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control.go',
    expect: (text) =>
      text.includes('s.manager.MobileTookBrowserFloor(tab.ID, device.DeviceID)') &&
      text.includes('s.manager.ReleaseMobileBrowserFloor(browserPageID, clientID)')
  },
  {
    name: 'Go shared-control emulator methods wait on cancellable native provider actions',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control_emulator.go',
    expect: (text) =>
      text.includes(
        'case "emulator.tap", "emulator.gesture", "emulator.type", "emulator.button"'
      ) &&
      text.includes('QueueEmulatorCommand') &&
      text.includes('waitLegacyEmulatorAction(ctx, action.ID)') &&
      text.includes('context.WithTimeout(parent, legacyEmulatorActionTimeout)') &&
      text.includes('ComputerActionCompleted') &&
      text.includes('ComputerActionFailed') &&
      text.includes('return nil, ctx.Err()') &&
      text.includes('emulator method is not supported by the native provider')
  },
  {
    name: 'Android emulator accessibility uses a fresh validated native UIAutomator tree',
    file: 'apps/desktop/src-tauri/src/commands/emulator_android_provider.rs',
    expect: (text) =>
      text.includes('"ax" => run_accessibility_tree(&serial)') &&
      text.includes('AdbCommand::AccessibilityDump') &&
      text.includes('AdbCommand::ReadRemoteFile') &&
      text.includes('parse_uiautomator_tree(&xml)') &&
      !text.includes('"ax" => ActionCompletion::Completed')
  },
  {
    name: 'Native browser children enforce platform permission policy',
    file: 'apps/desktop/src-tauri/src/commands/browser_permission_policy.rs',
    expect: (text) =>
      text.includes('connect_permission_request') &&
      text.includes('add_PermissionRequested') &&
      text.includes('requestMediaCapturePermissionForOrigin') &&
      text.includes('class_replaceMethod') &&
      text.includes('BrowserPermissionKind::DisplayMedia') &&
      text.includes('BrowserPermissionKind::Geolocation') &&
      text.includes('MediaPermissionResponse::Prompt') &&
      text.includes('WKPermissionDecision::Prompt') &&
      text.includes('BrowserPermissionDecision::Deny') &&
      text.includes('emit_browser_permission_denied')
  },
  {
    name: 'Provider review lookup discovers fork parents without local upstream remotes',
    file: 'runtime/go/internal/providercli/github_pr_for_branch.go',
    expect: (text) =>
      text.includes('ResolveGitHubForkParent') && text.includes('upstream == nil && origin != nil')
  },
  {
    name: 'Self-hosted GitLab fork lookup validates source project identity',
    file: 'runtime/go/internal/providercli/gitlab_local_metadata.go',
    expect: (text) =>
      text.includes('resolveGitLabForkParent') &&
      text.includes('SourceProjectID') &&
      text.includes('rows[index].SourceProjectID == candidate.SourceProjectID')
  },
  {
    name: 'Remote file search carries cancellation and bounds relay IO',
    file: 'runtime/go/internal/runtimecore/files.go',
    expect: (text) =>
      text.includes('SearchFilesContext(ctx context.Context') &&
      text.includes('SearchWorkspaceFilesContext(ctx context.Context') &&
      text.includes('maxFileSearchReadBytes') &&
      text.includes('maxFileSearchLineBytes') &&
      text.includes('context.WithTimeout(ctx, 60*time.Second)')
  },
  {
    name: 'Updater publication verifies exact uploaded release assets',
    file: 'config/scripts/verify-tauri-updater-manifest.mjs',
    expect: (text) =>
      text.includes('const tag = options.tag?.trim()') &&
      text.includes('assetsByName') &&
      text.includes("asset.state !== 'uploaded'") &&
      text.includes('asset.size <= 0')
  },
  {
    name: 'Native browser permission overrides synchronize authoritative profile decisions',
    file: 'apps/desktop/src-tauri/src/commands/browser_permission_overrides.rs',
    expect: (text) =>
      text.includes('pub fn browser_permission_overrides_sync') &&
      text.includes('BrowserPermissionOverrideState::Prompt') &&
      text.includes('updated_at') &&
      text.includes('ignored')
  },
  {
    name: 'Android emulator exec is argv-only bounded and cancellable',
    file: 'apps/desktop/src-tauri/src/commands/emulator_android_exec.rs',
    expect: (text) =>
      text.includes('MAX_EXEC_ARGV_BYTES') &&
      text.includes('MAX_EXEC_OUTPUT_BYTES') &&
      text.includes('process.args(command.to_argv())') &&
      text.includes('child.kill()') &&
      !text.includes('sh -c')
  },
  {
    name: 'Hosted review updates preserve provider retarget and draft-ready semantics',
    file: 'runtime/go/internal/providercli/review_update.go',
    expect: (text) =>
      text.includes('"pr", "edit"') &&
      text.includes('"pr", "ready"') &&
      text.includes('"mr", "update"') &&
      text.includes('"--target-branch"') &&
      text.includes('"--ready"')
  },
  {
    name: 'All remote file operations expose caller-context variants',
    file: 'runtime/go/internal/runtimecore/files.go',
    expect: (text) =>
      text.includes('ListFilesContext(ctx context.Context') &&
      text.includes('ReadFileContext(ctx context.Context') &&
      text.includes('WriteFileContext(ctx context.Context') &&
      text.includes('DeletePathContext(ctx context.Context') &&
      text.includes('FileWatchSnapshotContext(ctx context.Context')
  },
  {
    name: 'Release CI preflights signing and inspects native sidecar artifacts',
    file: '.github/workflows/tauri-desktop-release.yml',
    expect: (text) =>
      text.includes('verify-tauri-release-preflight.mjs') &&
      text.includes('verify-tauri-release-artifacts.mjs') &&
      text.includes('tauri-release-inspection-${{ matrix.label }}') &&
      text.includes('APPLE_TEAM_ID')
  },
  {
    name: 'macOS release evidence loads bundled native libraries through dyld',
    file: 'config/scripts/verify-tauri-release-artifacts.mjs',
    expect: (text) =>
      text.includes('libonnxruntime.1.17.1.dylib') &&
      text.includes('libsherpa-onnx-c-api.dylib') &&
      text.includes('Pebble exited during dyld probe') &&
      text.includes("'dyld-launch'")
  },
  {
    name: 'Tauri bundles native Linux and Windows computer-use providers',
    file: 'apps/desktop/src-tauri/tauri.conf.json',
    expect: (text) =>
      text.includes('native/computer-use-linux/runtime.py') &&
      text.includes('computer-use-linux/runtime.py') &&
      text.includes('native/computer-use-windows/runtime.ps1') &&
      text.includes('computer-use-windows/runtime.ps1')
  },
  {
    name: 'Tauri computer-use provider executes every desktop platform natively',
    file: 'apps/desktop/src-tauri/src/commands/computer_use_provider.rs',
    expect: (text) =>
      text.includes('desktop_worker::run') &&
      text.includes('DesktopScriptExecutor') &&
      text.includes('DESKTOP_PROVIDER_ID') &&
      !text.includes('requires the macOS Pebble Computer Use helper')
  },
  {
    name: 'Linux computer-use input does not depend on host desktop helper executables',
    file: 'native/computer-use-linux/runtime.py',
    expect: (text) =>
      text.includes('Atspi.KeySynthType.PRESS') &&
      text.includes('Atspi.KeySynthType.RELEASE') &&
      text.includes('Gtk.Clipboard.get_for_display') &&
      !['xdotool', 'wl-copy', 'wl-paste', 'xclip', 'xsel'].some((tool) => text.includes(tool))
  },
  {
    name: 'Tauri desktop computer-use bridge preserves bounded execution and canonical projection',
    file: 'apps/desktop/src-tauri/src/commands/computer_use_desktop_bridge.rs',
    expect: (text) =>
      text.includes('REQUEST_TIMEOUT') &&
      text.includes('MAX_BRIDGE_OUTPUT_BYTES') &&
      text.includes('powershell.exe') &&
      text.includes('python3')
  },
  {
    name: 'Settings lazy route stays inside the retained opaque overlay',
    file: 'packages/product-core/renderer/src/components/settings/SettingsOverlay.tsx',
    expect: (text) =>
      text.includes('<Suspense fallback={<SettingsLoadingFallback />}>') &&
      text.includes('<RetainedSettingsRoute onPrepared={markSettingsCommitted} />') &&
      text.includes('const RetainedSettingsRoute = memo(SettingsRoute)') &&
      text.includes('inert={!settingsVisible}') &&
      text.includes('scheduleAfterInputQuiet') &&
      !text.includes('<Activity')
  },
  {
    name: 'Tauri projects native browser driver events and authoritative snapshots',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('registerRuntimeBrowserDriverConsumer') &&
      text.includes('readBrowserDriversFromRuntime') &&
      text.includes('"/v1/browser/drivers"') &&
      text.includes('/v1/browser/tabs/${encodeURIComponent(browserPageId)}/reclaim-desktop')
  },
  {
    name: 'Tauri starts native runtime events before browser-only React workflows mount',
    file: 'apps/desktop/src/renderer-entry.ts',
    expect: (text) =>
      text.includes("import { ensureRuntimePtyEventDelivery } from './tauri-runtime-pty-events'") &&
      text.includes("runTauriRendererBootstrapStage('start-runtime-event-delivery'") &&
      text.includes('ensureRuntimePtyEventDelivery()')
  },
  {
    name: 'Tauri child WebView executes the complete remote browser action subset',
    file: 'packages/product-core/renderer/src/components/browser-pane/tauri-browser-page-webview.ts',
    expect: (text) =>
      text.includes("case 'keyDown':") &&
      text.includes("case 'keyUp':") &&
      text.includes("case 'harStart':") &&
      text.includes("case 'harStop':") &&
      text.includes("case 'eval':") &&
      text.includes("case 'viewport':") &&
      text.includes("case 'setHeaders':") &&
      text.includes("case 'setOffline':") &&
      text.includes("case 'setCredentials':") &&
      text.includes("case 'cookieGet':") &&
      text.includes("case 'cookieSet':") &&
      text.includes("case 'cookieDelete':") &&
      text.includes("case 'cookieClear':") &&
      text.includes("case 'dialogAccept':") &&
      text.includes("case 'dialogDismiss':") &&
      text.includes('setTauriBrowserPageDeviceEmulation') &&
      text.includes('setTauriBrowserPageCredentials') &&
      text.includes('setTauriBrowserCookie') &&
      text.includes('resolveTauriBrowserPageDialog')
  },
  {
    name: 'Tauri terminal display RPC resizes the native PTY and restores desktop ownership',
    file: 'apps/desktop/src/tauri-terminal-display-runtime-rpc.ts',
    expect: (text) =>
      text.includes('terminal.setDisplayMode') &&
      text.includes('terminal.getDisplayMode') &&
      text.includes('terminal.updateViewport') &&
      text.includes('deps.setMobileFit') &&
      text.includes('deps.resizeMobile') &&
      text.includes('clientId') &&
      text.includes('deps.restoreDesktopFit') &&
      text.includes('invalid_terminal_viewport')
  },
  {
    name: 'Tauri mobile fit preference preserves Electron null and clamp semantics',
    file: 'apps/desktop/src/tauri-mobile-fit-preference.ts',
    expect: (text) =>
      text.includes('MOBILE_AUTO_RESTORE_FIT_MIN_MS = 5_000') &&
      text.includes('MOBILE_AUTO_RESTORE_FIT_MAX_MS = 60 * 60 * 1_000') &&
      text.includes('mobileAutoRestoreFitMs') &&
      text.includes('readPersistentSettingsRaw') &&
      text.includes('writePersistentSettingsRaw')
  },
  {
    name: 'Tauri nested repo scan cancellation aborts the Go HTTP request context',
    file: 'apps/desktop/src/tauri-folder-workspace-api.ts',
    expect: (text) =>
      text.includes('/v1/project-groups/scan-nested/cancel') &&
      text.includes('cancelRuntimeNestedScan') &&
      text.includes('body: { scanId }') &&
      text.includes('runtime.canceled || activeScan.canceled')
  },
  {
    name: 'Go runtime owns scan-id cancellation handles for nested repo walks',
    file: 'runtime/go/internal/runtimehttp/project_group_folder_workspace_routes.go',
    expect: (text) =>
      text.includes('handleProjectGroupScanNestedCancel') &&
      text.includes('beginNestedScan') &&
      text.includes('cancelNestedScan') &&
      text.includes('previous.cancel()')
  },
  {
    name: 'Tauri browser uploads use bounded Rust file reads and real WebView FileLists',
    file: 'apps/desktop/src-tauri/src/commands/browser_upload_files.rs',
    expect: (text) =>
      text.includes('MAX_UPLOAD_FILES') &&
      text.includes('MAX_UPLOAD_TOTAL_BYTES') &&
      text.includes('metadata.is_file()') &&
      text.includes('BASE64_STANDARD.encode')
  },
  {
    name: 'Tauri browser cookie RPC uses the native child WebView cookie store',
    file: 'apps/desktop/src-tauri/src/commands/browser_cookies.rs',
    expect: (text) =>
      text.includes('browser_guest_cookie_get') &&
      text.includes('browser_guest_cookie_set') &&
      text.includes('browser_guest_cookie_delete') &&
      text.includes('cookie_matches_scope') &&
      text.includes('.set_cookie(') &&
      text.includes('.delete_cookie(')
  },
  {
    name: 'Tauri full-page browser screenshots stitch bounded native viewport captures',
    file: 'apps/desktop/src-tauri/src/commands/browser_full_page_screenshot.rs',
    expect: (text) =>
      text.includes('MAX_SEGMENTS') &&
      text.includes('MAX_PAGE_CSS_PIXELS') &&
      text.includes('image::imageops::overlay') &&
      text.includes('BASE64_STANDARD.encode')
  },
  {
    name: 'Tauri child WebViews install bounded persistent console and network capture',
    file: 'apps/desktop/src-tauri/src/commands/browser_child_webview.rs',
    expect: (text) =>
      text.includes('browser_automation_capture_script()') &&
      text.includes('const MAX = 1000') &&
      text.includes('globalThis.__pebbleAutomationCapture') &&
      text.includes('globalThis.fetch = async') &&
      text.includes('XMLHttpRequest.prototype.send') &&
      text.includes('pushBounded(state.intercepted') &&
      text.includes('interceptPatterns')
  },
  {
    name: 'Tauri sends renderer RRULE schedules to the Go scheduler',
    file: 'apps/desktop/src/tauri-automation-runtime-mapping.ts',
    expect: (text) =>
      text.includes("kind: 'rrule'") &&
      text.includes('rrule: snapshot.rrule') &&
      text.includes('dtstart: new Date(snapshot.dtstart).toISOString()') &&
      text.includes('stringValue(runtime.schedule?.rrule)') &&
      !text.includes("Go runtime does not accept Pebble's RRULE")
  },
  {
    name: 'Go scheduler enforces the renderer missed-run grace contract',
    file: 'runtime/go/internal/runtimecore/automation.go',
    expect: (text) =>
      text.includes('AutomationRunSkippedMissed AutomationRunStatus = "skipped_missed"') &&
      text.includes('automationMissedRunGrace') &&
      text.includes('recordMissedAutomationRun') &&
      text.includes('Pebble was unavailable during the missed-run grace window.')
  },
  {
    name: 'Go scheduler accepts every canonical recurrence frequency',
    file: 'runtime/go/internal/runtimecore/automation.go',
    expect: (text) =>
      text.includes('rrule.HOURLY') &&
      text.includes('rrule.DAILY') &&
      text.includes('rrule.WEEKLY') &&
      text.includes('rrule.MONTHLY') &&
      text.includes('supported: HOURLY, DAILY, WEEKLY, MONTHLY')
  },
  {
    name: 'Go runtime owns cancellable clone progress instead of renderer no-ops',
    file: 'runtime/go/internal/runtimecore/manager.go',
    expect: (text) =>
      text.includes('project.cloneProgress') &&
      text.includes('readCloneProgress') &&
      text.includes('CancelClone') &&
      text.includes('gitCloneCommandLimit') &&
      text.includes('Clone canceled.')
  },
  {
    name: 'Tauri repo API exposes clone progress and abort through the Go runtime',
    file: 'apps/desktop/src/pebble-tauri-workspace-runtime-api.ts',
    expect: (text) =>
      text.includes('/v1/projects/clone/abort') &&
      text.includes('project.cloneProgress') &&
      text.includes('onCloneProgress: (callback) => subscribeCloneProgress(callback)') &&
      !text.includes('cloneAbort: () => Promise.resolve()')
  },
  {
    name: 'Tauri owns local Hermes and OpenClaw external automation lifecycle',
    file: 'apps/desktop/src-tauri/src/commands/external_automations.rs',
    expect: (text) =>
      text.includes('external_automations_list_local') &&
      text.includes('external_automations_mutate_local') &&
      text.includes('"cron".into()') &&
      text.includes('"create".into()') &&
      text.includes('"edit".into()') &&
      text.includes('COMMAND_TIMEOUT') &&
      text.includes('Invalid external automation job ID.') &&
      text.includes('resolve_command_from_login_shell')
  },
  {
    name: 'Go relay worker owns purpose-scoped SSH external automations',
    file: 'runtime/go/cmd/pebble-relay-worker/external_automations.go',
    expect: (text) =>
      text.includes('runExternalAutomations') &&
      text.includes('case "runs"') &&
      text.includes('externalAutomationArguments') &&
      text.includes('validateExternalAutomationJobID') &&
      text.includes('externalAutomationCommandTimeout') &&
      text.includes('attachExternalAutomationRunCounts')
  },
  {
    name: 'Go relay worker hydrates Hermes SQLite transcripts without CGO',
    file: 'runtime/go/cmd/pebble-relay-worker/external_automation_sessions.go',
    expect: (text) =>
      text.includes('modernc.org/sqlite') &&
      text.includes('externalAutomationSessionRefs') &&
      text.includes('mergeExternalAutomationSessionRefs') &&
      text.includes('hydrateExternalAutomationSession') &&
      text.includes('SELECT role, content, tool_name, reasoning, reasoning_content')
  },
  {
    name: 'Go runtime exposes bounded SSH external automation routing',
    file: 'runtime/go/internal/runtimecore/ssh_external_automations.go',
    expect: (text) =>
      text.includes('RunSshExternalAutomation') &&
      text.includes('deploySshRelayWorker') &&
      text.includes('"external-automations", "--request"') &&
      text.includes('remoteWorkerCommand(deployment') &&
      text.includes('sshExternalAutomationTimeout') &&
      !text.includes('sh -c')
  },
  {
    name: 'Tauri renderer maps native external automation sources into canonical jobs',
    file: 'apps/desktop/src/tauri-automations-api.ts',
    expect: (text) =>
      text.includes('external_automations_list_local') &&
      text.includes('external_automations_mutate_local') &&
      text.includes('external_automations_list_local_runs') &&
      text.includes('requestRemoteExternalAutomation') &&
      text.includes('mapHermesJobs(managerId, source.jobs)') &&
      text.includes('mapOpenClawJobs(managerId, source.jobs)') &&
      !text.includes('tauri-hermes-local-unavailable')
  },
  {
    name: 'Tauri hydrates paged Hermes output and session history natively',
    file: 'apps/desktop/src-tauri/src/commands/hermes_automation_history.rs',
    expect: (text) =>
      text.includes('external_automations_list_local_runs') &&
      text.includes('join("cron").join("output")') &&
      text.includes('join("state.db")') &&
      text.includes('SQLITE_OPEN_READ_ONLY') &&
      text.includes('## Full session log') &&
      text.includes('Invalid external automation job ID.')
  },
  {
    name: 'Tauri browser import picker exposes every native-importable source',
    file: 'apps/desktop/src/tauri-browser-runtime-profiles.ts',
    expect: (text) =>
      text.includes("return invoke<DetectedBrowserInfo[]>('browser_detect_installed_browsers')") &&
      text.includes('native-firefox-cookie-import') &&
      text.includes('native-safari-cookie-import') &&
      text.includes('native-chromium-cookie-import') &&
      text.includes('native-cookie-file-import')
  },
  {
    name: 'Tauri child browser WebViews bridge native context menus without remote IPC access',
    file: 'apps/desktop/src-tauri/src/commands/browser_child_webview.rs',
    expect: (text) =>
      text.includes('browser_context_menu_script') &&
      text.includes('pebble-context://') &&
      text.includes('parse_context_menu_navigation') &&
      text.includes('event.preventDefault()') &&
      text.includes('PermissionDenied') &&
      text.includes("reportDenied('media')") &&
      text.includes('BROWSER_CONTEXT_MENU_EVENT')
  },
  {
    name: 'Tauri browser API forwards context menu request and dismissal events',
    file: 'apps/desktop/src/tauri-browser-runtime-api.ts',
    expect: (text) =>
      text.includes('onContextMenuRequested: onTauriBrowserContextMenuRequested') &&
      text.includes('onContextMenuDismissed: onTauriBrowserContextMenuDismissed') &&
      text.includes('onPermissionDenied: onTauriBrowserPermissionDenied')
  },
  {
    name: 'Tauri runtime browser RPC reuses native cookie adapters',
    file: 'apps/desktop/src/tauri-browser-runtime-rpc.ts',
    expect: (text) =>
      text.includes('importTauriBrowserCookiesFromBrowser') &&
      text.includes('clearTauriBrowserDefaultCookies') &&
      text.includes('importBrowserProfileCookies') &&
      !text.includes('Browser cookie import requires the Tauri WebView adapter.')
  },
  {
    name: 'Tauri bundles target-qualified Go runtime and relay sidecars',
    file: 'apps/desktop/src-tauri/tauri.conf.json',
    expect: (text) =>
      text.includes('node scripts/prepare-go-sidecars.mjs') &&
      text.includes('"binaries/pebble-runtime"') &&
      text.includes('"binaries/pebble-relay-worker"') &&
      text.includes('"binaries/relay-workers"')
  },
  {
    name: 'Tauri sidecar preparation cross-builds Go and supports macOS universal binaries',
    file: 'apps/desktop/scripts/prepare-go-sidecars.mjs',
    expect: (text) =>
      text.includes('TAURI_ENV_TARGET_TRIPLE') &&
      text.includes("CGO_ENABLED: '0'") &&
      text.includes("'universal-apple-darwin'") &&
      text.includes("run('lipo'") &&
      text.includes("'pebble-runtime'") &&
      text.includes("'pebble-relay-worker'") &&
      text.includes('buildRelayWorkerMatrix()') &&
      text.includes('pebble-relay-worker-${goos}-${goarch}') &&
      text.includes("'-ldflags=-s -w'") &&
      text.includes('signDarwinRelayWorkersForDistribution()') &&
      text.includes('resolveMacosCodeSigningIdentity()')
  },
  {
    name: 'macOS release sidecars discover the identity imported by tauri-action',
    file: 'apps/desktop/scripts/macos-code-signing-identity.mjs',
    expect: (text) =>
      text.includes('APPLE_SIGNING_IDENTITY') &&
      text.includes('APPLE_CERTIFICATE') &&
      text.includes("'find-identity', '-v', '-p', 'codesigning'") &&
      text.includes('Developer ID Application:')
  },
  {
    name: 'macOS bundle finalization signs the native simulator helper',
    file: 'apps/desktop/scripts/finalize-macos-app-bundle.mjs',
    expect: (text) =>
      text.includes('resolveMacosCodeSigningIdentity()') &&
      text.includes('Resources/serve-sim') &&
      text.includes("'--options', 'runtime'")
  },
  {
    name: 'Rust runtime launcher prefers the bundled sidecar before development fallback',
    file: 'apps/desktop/src-tauri/src/commands/runtime_process.rs',
    expect: (text) =>
      text.includes('env::current_exe()') &&
      text.includes('parent.join(runtime_binary_name())') &&
      text.includes('bundled.is_file()') &&
      text.includes('"pebble-runtime.exe"')
  },
  {
    name: 'Tauri renderer bootstrap loads the React app through a guarded dynamic entry',
    file: 'apps/desktop/src/main.tsx',
    expect: (text) =>
      text.includes('installTauriRendererBootstrapDiagnostics()') &&
      text.includes("setTauriRendererBootstrapStage('load-renderer-entry')") &&
      text.includes("import('./renderer-entry')") &&
      text.includes('markTauriRendererBootstrapComplete()') &&
      text.includes("renderTauriRendererBootstrapFailure('load-renderer-entry', error)")
  },
  {
    name: 'Tauri renderer entry imports the root React app and native parity bridges',
    file: 'apps/desktop/src/renderer-entry.ts',
    expect: (text) =>
      /import\s+App\s+from\s+['"]@\/App['"]/.test(text) &&
      text.includes("import { installTauriWindowApi } from './tauri-window-api'") &&
      text.includes(
        "runTauriRendererBootstrapStage('install-window-api', installTauriWindowApi)"
      ) &&
      text.includes("import { installTauriSettingsEventApi } from './tauri-settings-event-api'") &&
      text.includes(
        "runTauriRendererBootstrapStage('install-settings-event-api', installTauriSettingsEventApi)"
      ) &&
      text.includes("import { installTauriMenuApi } from './tauri-menu-api'") &&
      text.includes("runTauriRendererBootstrapStage('install-menu-api', installTauriMenuApi)") &&
      text.includes("import { installTauriAgentStatusApi } from './tauri-agent-status-api'") &&
      text.includes(
        "runTauriRendererBootstrapStage('install-agent-status-api', installTauriAgentStatusApi)"
      ) &&
      text.includes("import { installTauriRuntimePtyApi } from './tauri-runtime-pty-api'") &&
      text.includes(
        "runTauriRendererBootstrapStage('install-runtime-pty-api', installTauriRuntimePtyApi)"
      ) &&
      text.includes("import { installTauriUpdaterApi } from './tauri-updater-api'") &&
      text.includes(
        "runTauriRendererBootstrapStage('install-updater-api', installTauriUpdaterApi)"
      ) &&
      text.includes(
        "import { installTauriBrowserRuntimeApi } from './tauri-browser-runtime-api'"
      ) &&
      text.includes(
        "runTauriRendererBootstrapStage('install-browser-runtime-api', installTauriBrowserRuntimeApi)"
      ) &&
      text.includes(
        "import { installTauriDevEducationSuppression } from './tauri-dev-education-suppression'"
      ) &&
      text.includes('runTauriRendererBootstrapStage(') &&
      text.includes("'install-dev-education-suppression'") &&
      text.includes("import { installTauriShellApi } from './tauri-shell-api'") &&
      text.includes("runTauriRendererBootstrapStage('install-shell-api', installTauriShellApi)") &&
      text.includes("import { installTauriDeepLinkApi } from './tauri-deep-link-api'") &&
      text.includes(
        "runTauriRendererBootstrapStage('install-deep-link-api', installTauriDeepLinkApi)"
      ) &&
      text.includes("runTauriRendererBootstrapStage('render-react-root', renderReactRoot)")
  },
  {
    name: 'Tauri renderer bootstrap failures are visible before React mounts',
    file: 'apps/desktop/src/tauri-renderer-bootstrap-diagnostics.ts',
    expect: (text) =>
      text.includes('export function installTauriRendererBootstrapDiagnostics') &&
      text.includes('export function runTauriRendererBootstrapStage') &&
      text.includes('export function renderTauriRendererBootstrapFailure') &&
      text.includes("setAttribute('data-pebble-tauri-bootstrap-failure', failure.stage)") &&
      text.includes("window.addEventListener('error'") &&
      text.includes("window.addEventListener('unhandledrejection'")
  },
  {
    name: 'Tauri native shell reveals the restored main window after page load',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('use tauri::ActivationPolicy') &&
      text.includes('app.set_activation_policy(ActivationPolicy::Regular)') &&
      text.includes('PageLoadEvent::Finished') &&
      text.includes('LaunchWindowReveal') &&
      text.includes('window_chrome::apply_window_chrome(&window)') &&
      text.includes('primary_window::restore_and_focus(&window)') &&
      text.includes('window_chrome::promote_launch_window(&window)')
  },
  {
    name: 'Tauri macOS chrome uses AppKit activation for unbundled dev launches',
    file: 'apps/desktop/src-tauri/src/window_chrome.rs',
    expect: (text) =>
      text.includes('use objc2::MainThreadMarker') &&
      text.includes('use objc2_app_kit::{NSApp, NSWindow, NSWindowButton}') &&
      text.includes('pub fn promote_launch_window<R: Runtime>') &&
      text.includes('ns_window.deminiaturize(None)') &&
      text.includes('ns_window.orderFrontRegardless()') &&
      text.includes('ns_window.makeKeyAndOrderFront(None)') &&
      text.includes('app.activateIgnoringOtherApps(true)') &&
      text.includes('app.activate()')
  },
  {
    name: 'Tauri renderer CSS scopes Tailwind sources to avoid native build scans',
    file: 'apps/desktop/src/pebble-renderer.css',
    expect: (text) =>
      text.includes(
        "@import '../../../packages/product-core/renderer/src/assets/main.css' source(none);"
      ) && text.includes("@source '../../../packages/product-core/renderer/src';")
  },
  {
    name: 'Tauri Vite dev server ignores Rust build artifacts',
    file: 'apps/desktop/vite.config.ts',
    expect: (text) =>
      text.includes('watch: {') && text.includes("ignored: ['**/src-tauri/target/**']")
  },
  {
    name: 'Tauri dev bootstrap suppresses first-run education surfaces like Electron dev',
    file: 'apps/desktop/src/tauri-dev-education-suppression.ts',
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
    name: 'Tauri renderer suppresses feature tips for unavailable native capabilities',
    file: 'packages/product-core/renderer/src/App.tsx',
    expect: (text) =>
      text.includes('getTauriUnavailableFeatureTipIds') &&
      text.includes('components/feature-tips/tauri-unavailable-feature-tips') &&
      text.includes('suppressedTipIds: getTauriUnavailableFeatureTipIds()')
  },
  {
    name: 'Tauri renderer suppresses pinned feature-tip modals for unavailable native capabilities',
    file: 'packages/product-core/renderer/src/components/feature-tips/FeatureTipsModal.tsx',
    expect: (text) =>
      text.includes(
        "import { getTauriUnavailableFeatureTipIds } from './tauri-unavailable-feature-tips'"
      ) &&
      text.includes('suppressedTipIds: getTauriUnavailableFeatureTipIds()') &&
      text.includes('if (isOpen && !currentTip)') &&
      text.includes('closeModal()')
  },
  {
    name: 'Tauri unavailable feature-tip list is shared by app-open and modal resolution',
    file: 'packages/product-core/renderer/src/components/feature-tips/tauri-unavailable-feature-tips.ts',
    expect: (text) =>
      text.includes("import type { FeatureTipId } from '../../../../shared/feature-tips'") &&
      text.includes('export function getTauriUnavailableFeatureTipIds') &&
      text.includes('return []')
  },
  {
    name: 'Tauri preload installs the web-compatible API bridge',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) => {
      const stable = quoteStable(text)
      return (
        stable.includes("import { installWebPreloadApi } from '@/web/web-preload-api'") &&
        stable.includes("from './pebble-tauri-runtime-control-api'") &&
        stable.includes("from './tauri-crash-reports-api'") &&
        stable.includes("from './tauri-computer-use-permissions-api'") &&
        stable.includes("from './tauri-diagnostics-api'") &&
        stable.includes("from './tauri-file-watch-api'") &&
        stable.includes("from './tauri-folder-workspace-api'") &&
        stable.includes("from './tauri-mobile-runtime-api'") &&
        stable.includes("from './tauri-automations-api'") &&
        stable.includes("from './tauri-preflight-agent-api'") &&
        /createPebbleRuntimeEnvironmentsApi\(\s*api\.runtimeEnvironments,?\s*\)/.test(stable) &&
        stable.includes('createPebbleAutomationsApi(api.automations)') &&
        stable.includes('createPebbleCrashReportsApi(api.crashReports)') &&
        /createPebbleComputerUsePermissionsApi\(\s*api\.computerUsePermissions,?\s*\)/.test(
          stable
        ) &&
        stable.includes('createPebbleDiagnosticsApi(api.diagnostics)') &&
        stable.includes('createPebbleFileWatchApi(api.fs)') &&
        stable.includes('createPebbleProjectGroupsApi(api.projectGroups)') &&
        stable.includes('createPebbleFolderWorkspacesApi(api.folderWorkspaces)') &&
        stable.includes('createPebbleHooksApi(api.hooks)') &&
        stable.includes('createPebbleMobileApi(api.mobile)') &&
        stable.includes('detectTauriAgents()') &&
        stable.includes('refreshTauriAgents()') &&
        stable.includes('waitForTauriStartupServices') &&
        stable.includes('recordTauriStartupDiagnostic') &&
        stable.includes('detectRemoteAgents: async ({ connectionId })') &&
        /callRuntimeEnvironmentResult\(\s*connectionId,\s*'preflight\.detectAgents',?\s*\)/.test(
          stable
        ) &&
        !stable.includes('catch {\n        return []') &&
        stable.includes('detectRemoteWindowsTerminalCapabilities: async ({ connectionId })') &&
        /callRuntimeEnvironmentResult\(\s*connectionId,\s*'preflight\.detectWindowsTerminalCapabilities',?\s*\)/.test(
          stable
        ) &&
        stable.includes('return readSshTerminalCapabilities(requestRuntimeJson, connectionId)') &&
        stable.includes('installWebPreloadApi()') &&
        stable.includes('void ensurePebbleRuntimeProcess()')
      )
    }
  },
  {
    name: 'Tauri settings changes use a real renderer event channel',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes('emitTauriSettingsChanges(updates)') &&
      text.includes('onChanged: subscribeToTauriSettingsChanges')
  },
  {
    name: 'Tauri terminal theme imports use native bounded file discovery',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes('previewGhosttyImport: async () => previewTauriGhosttyImport') &&
      text.includes('previewWarpThemeImport: previewTauriWarpThemeImport')
  },
  {
    name: 'Tauri host registers native Ghostty and Warp import commands',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::ghostty_import::settings_read_ghostty_sources') &&
      text.includes('commands::ghostty_import::settings_read_ghostty_theme') &&
      text.includes('commands::warp_theme_import::settings_read_warp_theme_sources')
  },
  {
    name: 'Tauri startup services are bounded best-effort probes',
    file: 'apps/desktop/src/tauri-startup-services.ts',
    expect: (text) =>
      text.includes('export async function waitForTauriStartupServices') &&
      text.includes('DEFAULT_TAURI_STARTUP_SERVICE_TIMEOUT_MS') &&
      text.includes('settleStartupService') &&
      text.includes('Promise.race') &&
      text.includes('ensurePebbleRuntimeProcess()') &&
      text.includes('readPebbleStatusOrNull()') &&
      text.includes('refreshTauriAgents()') &&
      text.includes('[tauri-startup]')
  },
  {
    name: 'Tauri startup service tests prevent first-window infinite waits',
    file: 'apps/desktop/src/tauri-startup-services.test.ts',
    expect: (text) =>
      text.includes('does not block first-window startup forever when native probes hang') &&
      text.includes('treats startup probes as best-effort so renderer hydration can continue') &&
      text.includes('vi.useFakeTimers()') &&
      text.includes('advanceTimersByTimeAsync')
  },
  {
    name: 'Tauri runtime requests share one process readiness coordinator',
    file: 'apps/desktop/src/pebble-tauri-runtime-transport.ts',
    expect: (text) =>
      text.includes('let runtimeStartupPromise: Promise<void> | null = null') &&
      text.includes('startAndWaitForRuntime') &&
      text.includes('await ensurePebbleRuntimeProcess()') &&
      text.includes('RUNTIME_RESTART_BACKOFF_MS') &&
      text.includes('lastProcessError') &&
      text.includes('RUNTIME_READY_TIMEOUT_MS')
  },
  {
    name: 'Legacy Tauri runtime bridge cannot fork a second readiness state machine',
    file: 'apps/desktop/src/pebble-runtime-http-bridge.ts',
    expect: (text) =>
      text.includes("from './pebble-tauri-runtime-transport'") &&
      !text.includes('startRuntimeProcess(') &&
      !text.includes('getRuntimeProcessStatus(')
  },
  {
    name: 'Tauri runtime readiness tests cover bind races and concurrent startup',
    file: 'apps/desktop/src/pebble-tauri-runtime-transport.test.ts',
    expect: (text) =>
      text.includes('process exists but its HTTP listener is not ready') &&
      text.includes('shares one spawn and readiness wait') &&
      text.includes('first child exits during desktop runtime handoff') &&
      text.includes('last concrete process error after bounded retries fail') &&
      text.includes('does not issue a native JSON request until readiness is proven')
  },
  {
    name: 'Tauri SSH credentials prompt and retry through the native runtime cache',
    file: 'apps/desktop/src/tauri-ssh-targets-api.ts',
    expect: (text) =>
      text.includes('requestSshCredential') &&
      text.includes('credentialRequestListeners') &&
      text.includes('credentialResolvedListeners') &&
      text.includes('seedSshCredentialFromSubmission') &&
      text.includes('finalResult = await testConnection(args)') &&
      text.includes('lastRequiredPassphrase: prompted')
  },
  {
    name: 'Go SSH askpass consumes memory-only credentials without argv or files',
    file: 'runtime/go/internal/runtimecore/ssh_agent_hook_bootstrap.go',
    expect: (text) =>
      text.includes('PEBBLE_SSH_ASKPASS_MODE=1') &&
      text.includes('PEBBLE_SSH_ASKPASS_SECRET=') &&
      text.includes('enableSshCredentialPrompts(cmd.Args)') &&
      text.includes('NumberOfPasswordPrompts=1') &&
      !text.includes('askpass.sh')
  },
  {
    name: 'Go runtime executable owns the cross-platform SSH askpass response',
    file: 'runtime/go/cmd/pebble-runtime/main.go',
    expect: (text) =>
      text.includes('os.Getenv("PEBBLE_SSH_ASKPASS_MODE") == "1"') &&
      text.includes('os.Getenv("PEBBLE_SSH_ASKPASS_SECRET")')
  },
  {
    name: 'Tauri computer-use permissions API calls native helper commands',
    file: 'apps/desktop/src/tauri-computer-use-permissions-api.ts',
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
    name: 'Tauri pairing API uses Go legacy-compatible shared-control identity',
    file: 'apps/desktop/src/tauri-mobile-runtime-api.ts',
    expect: (text) =>
      text.includes('export function createPebbleMobileApi') &&
      text.includes("'/v1/shared-control/pairing'") &&
      text.includes("'/v1/shared-control/pairings'") &&
      text.includes('network_list_interfaces') &&
      text.includes('pebble://pair?code=') &&
      text.includes('listRuntimeAccessGrants') &&
      text.includes('revokeRuntimeAccess') &&
      text.includes('listDevices') &&
      text.includes('revokeDevice') &&
      text.includes('mapRuntimePairingToGrant') &&
      text.includes('mapRuntimePairingToDevice') &&
      !text.includes('catch(() => [])') &&
      !text.includes('Promise.resolve({ grants: [] })') &&
      !text.includes('Promise.resolve({ revoked: false })')
  },
  {
    name: 'Tauri pairing tests cover shared-control offers and reject fake empty state',
    file: 'apps/desktop/src/tauri-mobile-runtime-api.test.ts',
    expect: (text) =>
      text.includes('maps mobile devices and runtime access grants from shared-control pairings') &&
      text.includes('builds the legacy-compatible pairing offer') &&
      text.includes('propagates pairing list runtime failures') &&
      text.includes('/v1/shared-control/pairings') &&
      text.includes('mobile relay unavailable')
  },
  {
    name: 'Go shared-control owns legacy E2EE session and terminal streams',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control.go',
    expect: (text) =>
      text.includes('case "session.tabs.subscribe"') &&
      text.includes('case "session.tabs.subscribeAll"') &&
      text.includes('case "session.tabs.activate", "session.tabs.close"') &&
      text.includes('case "session.tabs.createTerminal"') &&
      text.includes('case "session.tabs.updatePaneLayout"') &&
      text.includes('case "session.tabs.setTabProps"') &&
      text.includes('case "session.tabs.move"') &&
      text.includes('case "terminal.subscribe"') &&
      text.includes('case "terminal.send"') &&
      text.includes('case "terminal.updateViewport"') &&
      text.includes('case "terminal.agentStatus"') &&
      text.includes('case "terminal.resolvePane"') &&
      text.includes('case "terminal.focus"') &&
      text.includes('ActivateSessionTab(session.WorktreeID, tabID)') &&
      text.includes('case "terminal.create"') &&
      text.includes('request.Method == "terminal.wait"') &&
      text.includes('case "terminal.resolveActive"') &&
      text.includes('case "terminal.show"') &&
      text.includes('case "terminal.inspectProcess"') &&
      text.includes('case "terminal.stop", "terminal.stopExact"') &&
      text.includes('"remainingLivePtyIds"') &&
      text.includes('"postStopFailure"') &&
      text.includes('postStopVerified = postStopVerified && len(remainingIDs) == 0') &&
      text.includes('case "terminal.split"') &&
      text.includes('SplitSessionTabPane(') &&
      text.includes('terminal_split_layout_failed') &&
      text.includes('case "terminal.rename"') &&
      text.includes('case "terminal.setDisplayMode"') &&
      text.includes('case "terminal.getDisplayMode"') &&
      text.includes('event.Topic == "session.output"') &&
      text.includes('terminalStreamSnapshotStart') &&
      text.includes('terminalStreamOutput') &&
      text.includes('SessionScreenSnapshot') &&
      text.includes('screen.Alternate') &&
      text.includes('handleLegacySharedControlBinaryFrame') &&
      text.includes('SessionTabsSnapshot') &&
      !text.includes('mock')
  },
  {
    name: 'Go PTY sessions maintain a rendered alternate-screen snapshot',
    file: 'runtime/go/internal/runtimecore/terminal_screen.go',
    expect: (text) =>
      text.includes('vt.NewEmulator') &&
      text.includes('sync.Mutex') &&
      text.includes('output.WriteString("\\x1b[2J\\x1b[H")') &&
      text.includes('cell.Content') &&
      text.includes('cell.Width == 0') &&
      text.includes('style.String()') &&
      text.includes('CursorVisibility:') &&
      text.includes('terminal.CursorPosition()') &&
      text.includes('terminal.IsAltScreen()') &&
      text.includes('terminal.Resize') &&
      !text.includes('vt10x')
  },
  {
    name: 'Go shared-control tests prove live encrypted terminal output',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control_test.go',
    expect: (text) =>
      text.includes('TestLegacySharedControlTerminalJSONStreamWritesAndEmitsLiveOutput') &&
      text.includes('printf live-marker') &&
      text.includes('TestLegacySharedControlTerminalBinaryStreamSnapshotInputAndOutput') &&
      text.includes('TestLegacySharedControlTerminalControlMethodsUseRuntimeSessions') &&
      text.includes('TestLegacySharedControlSessionTabMutationsPersistAndStopNativePTY') &&
      text.includes(
        'TestLegacySharedControlCreatesAndWaitsForNativeTerminalWithoutBlockingConnection'
      ) &&
      text.includes('TestLegacySharedControlStopExactGuardsConcurrentNativeSessions') &&
      text.includes('printf binary-marker') &&
      text.includes('terminal.subscribe') &&
      text.includes('terminal.send')
  },
  {
    name: 'Go runtime event subscriptions cannot close channels during emit',
    file: 'runtime/go/internal/runtimecore/manager.go',
    expect: (text) =>
      text.includes('Sending while the') &&
      text.includes('for _, subscriber := range m.subscribers') &&
      !text.includes('subscribers := make([]chan RuntimeEvent')
  },
  {
    name: 'Tauri speech API exposes cloud dictation and explicit local-model gaps',
    file: 'apps/desktop/src/tauri-speech-api.ts',
    expect: (text) =>
      text.includes('SPEECH_MODEL_CATALOG, getCatalogModel') &&
      text.includes('speech_get_model_states') &&
      text.includes('TAURI_LOCAL_INFERENCE_UNAVAILABLE') &&
      text.includes('speech_start_dictation') &&
      text.includes('speech_stop_dictation') &&
      text.includes('subscribeSpeechEvent') &&
      text.includes('emitSpeechEvent') &&
      !text.includes('getCatalog: () => Promise.resolve([])') &&
      !text.includes('getModelStates: () => Promise.resolve([])') &&
      !text.includes('onPartialTranscript: () => noopUnsubscribe')
  },
  {
    name: 'Renderer voice dictation gate prevents Tauri speech calls that would reject',
    file: 'packages/product-core/renderer/src/components/dictation/speech-feature-availability.ts',
    expect: (text) =>
      text.includes("import { isPebbleTauriShell } from '@/lib/tauri-shell-detection'") &&
      text.includes('export function getVoiceDictationUnavailableReason') &&
      text.includes('isPebbleTauriShell()') &&
      text.includes('TAURI_VOICE_DICTATION_UNAVAILABLE_REASON')
  },
  {
    name: 'Settings voice pane gates Tauri dictation by selected model before permission flow',
    file: 'packages/product-core/renderer/src/components/settings/VoicePane.tsx',
    expect: (text) =>
      text.includes(
        "import { getVoiceDictationUnavailableReason } from '../dictation/speech-feature-availability'"
      ) &&
      text.includes(
        'const voiceDictationUnavailableReason = getVoiceDictationUnavailableReason(voiceSettings.sttModel)'
      ) &&
      text.includes('if (voiceDictationUnavailableReason)') &&
      text.includes('unavailableReason={voiceDictationUnavailableReason}')
  },
  {
    name: 'Native chat composer surfaces Tauri dictation unavailable reason on the mic action',
    file: 'packages/product-core/renderer/src/components/native-chat/NativeChatComposer.tsx',
    expect: (text) =>
      text.includes(
        "import { getVoiceDictationUnavailableReason } from '../dictation/speech-feature-availability'"
      ) &&
      text.includes(
        'const voiceDictationUnavailableReason = getVoiceDictationUnavailableReason('
      ) &&
      text.includes('voiceDictationUnavailableReason !== null') &&
      text.includes('dictationDisabledReason={voiceDictationUnavailableReason}')
  },
  {
    name: 'Tauri automations API bridges the renderer surface to Go runtime storage',
    file: 'apps/desktop/src/tauri-automations-api.ts',
    expect: (text) =>
      text.includes('export function createPebbleAutomationsApi') &&
      text.includes('export async function callTauriAutomationRuntimeRpc') &&
      text.includes("case 'automation.list'") &&
      text.includes("case 'automation.create'") &&
      text.includes("case 'automation.runNow'") &&
      text.includes("'/v1/automations'") &&
      text.includes('`/v1/automations/${encodeURIComponent(id)}/runs`') &&
      text.includes('mapRuntimeAutomation(response)') &&
      text.includes('mapRuntimeAutomationRun(run, automation)') &&
      text.includes('readTauriAutomationPrecheckResult') &&
      text.includes('writeTauriAutomationDispatchResult') &&
      text.includes('rendererReady: () => catchUpTauriAutomationDispatchRequests()') &&
      text.includes('listTauriExternalAutomationManagers') &&
      text.includes('external_automations_list_local') &&
      text.includes('external_automations_mutate_local') &&
      text.includes('mapHermesJobs') &&
      text.includes('mapOpenClawJobs') &&
      !text.includes('list: () => Promise.resolve([])') &&
      !text.includes('listExternalManagers: async () => []') &&
      !text.includes('runNow: () => Promise.resolve')
  },
  {
    name: 'Tauri automation runtime mapping preserves Electron automation metadata',
    file: 'apps/desktop/src/tauri-automation-runtime-mapping.ts',
    expect: (text) =>
      text.includes("const AUTOMATION_PAYLOAD_KEY = 'pebbleAutomation'") &&
      text.includes('toRuntimeCreateAutomationRequest') &&
      text.includes('toRuntimeUpdateAutomationRequest') &&
      text.includes('mapRuntimeAutomation') &&
      text.includes('mapRuntimeAutomationRun') &&
      text.includes('nextAutomationOccurrenceAfter') &&
      text.includes("kind: 'manual'") &&
      text.includes("kind: 'createTask'") &&
      text.includes('readSchedulerOwner') &&
      text.includes('mapRuntimeOutputSnapshot(dispatch?.outputSnapshot)') &&
      !text.includes('Runtime automation completed:')
  },
  {
    name: 'Tauri automations API tests cover runtime-backed list, create, run, and RPC',
    file: 'apps/desktop/src/tauri-automations-api.test.ts',
    expect: (text) =>
      text.includes('lists Go runtime automations as renderer automation records') &&
      text.includes('creates runtime automations without dropping Pebble schedule metadata') &&
      text.includes('runs automations through the runtime run endpoint and maps run history') &&
      text.includes('preserves native missed-run status and scheduled occurrence time') &&
      text.includes('maps native local external automation managers and jobs') &&
      text.includes('runs local external automation actions through the Rust host') &&
      text.includes('loads local Hermes run history through the Rust host') &&
      text.includes('maps SSH external managers through the Go relay-worker route') &&
      text.includes('loads remote Hermes run history through the Go relay-worker route') &&
      text.includes('runs remote external mutations through the Go SSH relay-worker route') &&
      text.includes('handles automation runtime RPC methods for paired-runtime parity') &&
      text.includes("'/v1/automations/auto-1/runs'")
  },
  {
    name: 'Go runtime can list and revoke mobile relay runtime access grants',
    file: 'runtime/go/internal/runtimehttp/mobile_relay_http.go',
    expect: (text) =>
      text.includes('handleMobileRelayPairings') &&
      text.includes('handleMobileRelayPairingByDeviceID') &&
      text.includes('DeleteMobileRelayPairing(deviceID)') &&
      text.includes('map[string]bool{"revoked": revoked}')
  },
  {
    name: 'Tauri runtime control API bridges local runtime and remote environment commands',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) => {
      const stable = quoteStable(text)
      return (
        stable.includes("invoke<PublicKnownRuntimeEnvironment[]>('runtime_environments_list'") &&
        stable.includes("'runtime_environments_add_from_pairing_code'") &&
        stable.includes("'runtime_environments_remove'") &&
        stable.includes("'runtime_environments_call'") &&
        stable.includes('callPebbleRuntimeMethod(method, params)') &&
        stable.includes("case 'preflight.detectAgents':") &&
        stable.includes("case 'preflight.refreshAgents':") &&
        stable.includes("case 'worktree.lineageList':") &&
        stable.includes("case 'projectGroup.list':") &&
        stable.includes("case 'folderWorkspace.list':") &&
        stable.includes('callTauriProjectGroupRuntimeRpc') &&
        stable.includes('callTauriFolderWorkspaceRuntimeRpc') &&
        stable.includes('callTauriAutomationRuntimeRpc') &&
        stable.includes('callTauriSessionTabsRuntimeRpc') &&
        stable.includes('readRuntimeWorktreeLineage()') &&
        stable.includes("case 'worktree.activate':") &&
        stable.includes('emitTauriActivateWorktree({') &&
        stable.includes("case 'worktree.persistSortOrder':") &&
        stable.includes("case 'repo.reorder':") &&
        stable.includes('persistRuntimeProjectSortOrder(toOrderedIds(params))') &&
        stable.includes('persistRuntimeWorktreeSortOrder(toOrderedIds(params))') &&
        stable.includes("case 'preflight.detectRemoteWindowsTerminalCapabilities':") &&
        stable.includes("case 'host.platform':") &&
        stable.includes("case 'host.wsl.isAvailable':") &&
        stable.includes("case 'host.wsl.listDistros':") &&
        stable.includes("case 'host.pwsh.isAvailable':") &&
        stable.includes("case 'host.gitBash.isAvailable':") &&
        stable.includes('readHostTerminalCapabilities(requestRuntimeJson)') &&
        stable.includes('remote_runtime_unavailable') &&
        stable.includes('readOrCreateRuntimeStatus(graph)') &&
        stable.includes('readTerminalFitOverrides()') &&
        stable.includes('restoreTauriTerminalFit(ptyId)') &&
        stable.includes('reclaimTauriBrowserForDesktop(browserPageId)') &&
        stable.includes('terminalDriverListeners') &&
        stable.includes('subscribeTauriRuntimeEnvironment(args, callbacks)') &&
        stable.includes('parsePebbleYaml') &&
        stable.includes('inspectSetupScriptImportCandidates') &&
        stable.includes('readRuntimeRepoHooksCheck(params)') &&
        stable.includes('inspectRuntimeRepoSetupScriptImports(params)') &&
        stable.includes('readRuntimeRepoTextFile(repoId,') &&
        stable.includes("case 'computer.permissionsStatus':") &&
        stable.includes('readTauriComputerUsePermissionStatus()') &&
        stable.includes("case 'computer.permissions':") &&
        stable.includes('openTauriComputerUsePermissionSetup') &&
        stable.includes('readComputerPermissionsArgs(params)') &&
        stable.includes("case 'hostedReview.forBranch':") &&
        stable.includes("case 'hostedReview.getCreationEligibility':") &&
        stable.includes("case 'hostedReview.create':") &&
        stable.includes('fetchHostedReviewForBranch(getProviderJson, params)') &&
        stable.includes('fetchHostedReviewCreationEligibility(getProviderJson, params)') &&
        stable.includes('createTauriHostedReview(params)') &&
        !stable.includes('createTauriHostedReviewUnavailableResult') &&
        !stable.includes("code: 'remote_subscription_unavailable'") &&
        !stable.includes('readUnsupportedComputerPermissions') &&
        !stable.includes('openUnsupportedComputerPermissions') &&
        !stable.includes('searchBaseRefDetails({ repoId, query, limit }).catch(() => [])') &&
        !stable.includes('getTerminalDrivers: () => Promise.resolve([])') &&
        !stable.includes('getBrowserDrivers: () => Promise.resolve([])')
      )
    }
  },
  {
    name: 'Tauri runtime-control tests reject fake empty base-ref details',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.test.ts',
    expect: (text) => {
      const stable = quoteStable(text)
      return (
        stable.includes('propagates base ref detail failures') &&
        stable.includes('base refs unavailable') &&
        stable.includes("method: 'repo.searchRefs'")
      )
    }
  },
  {
    name: 'Tauri hosted-review bridge uses Go capabilities and creation routes',
    file: 'apps/desktop/src/tauri-provider-review-bridge.ts',
    expect: (text) => {
      const stable = quoteStable(text)
      return (
        stable.includes('fetchHostedReviewCreationEligibility') &&
        stable.includes('/v1/providers/review-capabilities?') &&
        stable.includes('buildHostedReviewCreationEligibility') &&
        stable.includes('export async function createHostedReview') &&
        stable.includes('/v1/providers/reviews') &&
        stable.includes('timeoutMs: 60_000') &&
        stable.includes('resolveWorktreeId') &&
        stable.includes('linkedBitbucketPR') &&
        stable.includes('linkedAzureDevOpsPR') &&
        stable.includes('linkedGiteaPR') &&
        stable.includes('findRestHostedReviewForBranch') &&
        stable.includes("value === 'bitbucket'") &&
        stable.includes("value === 'azure-devops'") &&
        stable.includes("value === 'gitea'")
      )
    }
  },
  {
    name: 'Go provider layer owns GitHub and GitLab review creation',
    file: 'runtime/go/internal/providercli/review_creation.go',
    expect: (text) =>
      text.includes('func CreateGitHubPullRequest') &&
      text.includes('func CreateGitLabMergeRequest') &&
      text.includes('"pr", "create"') &&
      text.includes('"mr", "create"') &&
      text.includes('classifyCreateReviewError') &&
      text.includes('parseGitHubCreatePayload') &&
      text.includes('parseGitLabCreatePayload') &&
      text.includes('IsReviewProviderAuthenticated')
  },
  {
    name: 'Go runtime exposes hosted-review capability and mutation routes',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/providers/reviews"') &&
      text.includes('"/v1/providers/review-capabilities"') &&
      text.includes('handleProviderReviewCreate') &&
      text.includes('handleProviderReviewCapabilities')
  },
  {
    name: 'Tauri host terminal capability adapter calls the Go host route',
    file: 'apps/desktop/src/host-terminal-capabilities.ts',
    expect: (text) =>
      text.includes('export async function readHostTerminalCapabilities') &&
      text.includes("'/v1/host/terminal-capabilities'") &&
      text.includes('HOST_TERMINAL_CAPABILITIES_TIMEOUT_MS = 8000') &&
      text.includes('export function normalizeHostTerminalCapabilities') &&
      text.includes("hostPlatform === 'win32'")
  },
  {
    name: 'Tauri relay-only terminal capability adapter targets the selected SSH host',
    file: 'apps/desktop/src/host-terminal-capabilities.ts',
    expect: (text) =>
      text.includes('export async function readSshTerminalCapabilities') &&
      text.includes('/v1/ssh-targets/${encodeURIComponent(targetId)}/terminal-capabilities') &&
      text.includes('return normalizeHostTerminalCapabilities(capabilities)')
  },
  {
    name: 'Tauri remote terminal capability probe targets the selected paired runtime',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes('detectRemoteWindowsTerminalCapabilities: async ({ connectionId })') &&
      text.includes("connectionId,\n            'preflight.detectWindowsTerminalCapabilities'") &&
      text.includes('return readSshTerminalCapabilities(requestRuntimeJson, connectionId)')
  },
  {
    name: 'Tauri SSH target adapter exposes real probe-backed state changes',
    file: 'apps/desktop/src/tauri-ssh-targets-api.ts',
    expect: (text) =>
      text.includes("'/v1/ssh-targets'") &&
      text.includes("'/v1/ssh-targets/import'") &&
      text.includes('`/v1/ssh-targets/${encodeURIComponent(args.targetId)}/probe`') &&
      text.includes('const sshStateByTargetId = new Map<string, SshConnectionState>()') &&
      text.includes('const sshStateListeners = new Set') &&
      text.includes("emitSshState(makeState(args.targetId, 'connecting', null))") &&
      text.includes('emitSshState(state)') &&
      text.includes('async function needsPassphrasePrompt') &&
      text.includes('sshNeedsPassphrasePrompt(args.targetId') &&
      text.includes('candidate.lastRequiredPassphrase === true') &&
      text.includes('function onStateChanged') &&
      text.includes('normalizeProbeStatus') &&
      !text.includes("'/v1/ssh-targets', { method: 'GET' }).catch(() => [])") &&
      !text.includes("'/v1/ssh-targets/import', { method: 'POST' }).catch") &&
      !text.includes('connect: () => Promise.reject')
  },
  {
    name: 'Tauri SSH target adapter tests cover state events and no fake relay success',
    file: 'apps/desktop/src/tauri-ssh-targets-api.test.ts',
    expect: (text) =>
      text.includes('maps ssh.connect to a real runtime probe and emits state changes') &&
      text.includes('returns failed probe state without pretending the relay is connected') &&
      text.includes('updates cached state on disconnect and resetRelay') &&
      text.includes(
        'reads persisted passphrase prompt state when the credential cache is unreachable'
      ) &&
      text.includes(
        'skips the prompt when the runtime credential cache already holds the secret'
      ) &&
      text.includes('does not prompt for a target that is already connected in Tauri state') &&
      text.includes('propagates target list runtime failures') &&
      text.includes('propagates ssh config import failures') &&
      text.includes("'/v1/ssh-targets/ssh-1/probe'") &&
      text.includes("status: 'auth-failed'")
  },
  {
    name: 'Tauri maps project groups and folder workspaces to Go runtime storage',
    file: 'apps/desktop/src/tauri-folder-workspace-api.ts',
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
      text.includes('RuntimeEnvironmentRpcError') &&
      text.includes('isRelayOnlyRuntimeGap') &&
      text.includes("'permission_denied'") === false &&
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
    file: 'runtime/go/internal/runtimecore/project_group_folder_workspace.go',
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
      text.includes(
        'return FolderWorkspacePathStatus{Path: path, Exists: false, Reason: "unavailable"}'
      )
  },
  {
    name: 'Go runtime exposes project group and folder workspace HTTP endpoints',
    file: 'runtime/go/internal/runtimehttp/project_group_folder_workspace_routes.go',
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
    name: 'Tauri folder workspace API tests cover Go runtime CRUD and RPC envelopes',
    file: 'apps/desktop/src/tauri-folder-workspace-api.test.ts',
    expect: (text) =>
      text.includes(
        'routes folder workspace CRUD and path-status calls through Go runtime storage'
      ) &&
      text.includes(
        'handles folder workspace runtime RPC methods with renderer-compatible envelopes'
      ) &&
      text.includes("'/v1/folder-workspaces'") &&
      text.includes("'/v1/folder-workspaces/path-status'") &&
      text.includes("'folderWorkspace.create'") &&
      text.includes("'folderWorkspace.update'") &&
      text.includes("'folderWorkspace.delete'")
  },
  {
    name: 'Tauri file watch API overrides web no-ops with native fs changed events',
    file: 'apps/desktop/src/tauri-file-watch-api.ts',
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
    file: 'apps/desktop/src/tauri-file-watch-api.test.ts',
    expect: (text) =>
      text.includes('bridges connectionId worktree watches through runtime files.watch') &&
      text.includes("method: 'files.watch'") &&
      text.includes("method: 'files.unwatch'") &&
      text.includes('shares one runtime watch across repeated connectionId subscriptions')
  },
  {
    name: 'Tauri Rust filesystem watcher emits Electron-compatible fs changed payloads',
    file: 'apps/desktop/src-tauri/src/commands/filesystem_watch.rs',
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
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::filesystem_watch::FsWatcherState::default()') &&
      text.includes('commands::filesystem_watch::fs_watch_worktree') &&
      text.includes('commands::filesystem_watch::fs_unwatch_worktree')
  },
  {
    name: 'Tauri native shell registers terminal artifact grant state and commands',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::terminal_artifacts::TerminalArtifactsState::default()') &&
      text.includes('commands::terminal_artifacts::terminal_artifact_grant') &&
      text.includes('commands::terminal_artifacts::terminal_artifact_read') &&
      text.includes('commands::terminal_artifacts::terminal_artifact_preview') &&
      text.includes('commands::terminal_artifacts::terminal_artifact_write')
  },
  {
    name: 'Tauri Rust dependencies include native filesystem notification and no-follow support',
    file: 'apps/desktop/src-tauri/Cargo.toml',
    expect: (text) => text.includes('notify = "6"') && text.includes('libc = "0.2"')
  },
  {
    name: 'Tauri hooks API creates real issue-command runner scripts through Rust',
    file: 'apps/desktop/src/tauri-hooks-api.ts',
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
    file: 'apps/desktop/src-tauri/src/commands/hooks.rs',
    expect: (text) =>
      text.includes('pub async fn hooks_create_issue_command_runner') &&
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
    file: 'apps/desktop/src/tauri-runtime-environment-subscription-api.ts',
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
    file: 'apps/desktop/src/pebble-tauri-workspace-runtime-api.ts',
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
      !/requestRuntimeJson<PebbleRuntimeProject\[\]>\('\/v1\/projects'[\s\S]*?\.catch\(\(\) => \[\]\)/.test(
        text
      ) &&
      !/requestRuntimeJson<PebbleRuntimeWorktree\[\]>\([\s\S]*?'\/v1\/worktrees[^']*'[\s\S]*?\.catch\(\(\) => \[\]\)/.test(
        text
      ) &&
      !text.includes('prefetchCreateBase: () => Promise.resolve()')
  },
  {
    name: 'Tauri workspace API tests reject runtime list failures instead of clearing UI data',
    file: 'apps/desktop/src/pebble-tauri-workspace-runtime-api.test.ts',
    expect: (text) =>
      text.includes('propagates project list runtime failures') &&
      text.includes('propagates worktree list runtime failures') &&
      text.includes("await expect(readRepos()).rejects.toThrow('runtime offline')") &&
      text.includes(
        "await expect(readWorktrees('repo-1')).rejects.toThrow('worktrees unavailable')"
      )
  },
  {
    name: 'Go runtime worktree deletion delegates to the shared host removal boundary',
    file: 'runtime/go/internal/runtimecore/manager.go',
    expect: (text) =>
      text.includes(
        'func (m *Manager) DeleteWorktree(ctx context.Context, id string, req DeleteWorktreeRequest)'
      ) &&
      text.includes('if req.ExecuteGit') &&
      text.includes('func removeLocalGitWorktree') &&
      text.includes('RemoveGitWorktreeOnHost(') &&
      text.includes('ForceDeleteGitBranchOnHost(')
  },
  {
    name: 'Shared Go host worktree removal keeps bounded git and branch safeguards',
    file: 'runtime/go/internal/runtimecore/host_git_worktree_removal.go',
    expect: (text) =>
      text.includes('func RemoveGitWorktreeOnHost') &&
      text.includes('"worktree", "remove"') &&
      text.includes('context.WithTimeout(ctx, gitWorktreeCommandLimit)') &&
      text.includes('func ForceDeleteGitBranchOnHost') &&
      text.includes('update-ref') &&
      text.includes('gitBranchIsCheckedOut')
  },
  {
    name: 'Tauri window API bridges native window controls',
    file: 'apps/desktop/src/tauri-window-api.ts',
    expect: (text) =>
      text.includes("import { getCurrentWindow } from '@tauri-apps/api/window'") &&
      text.includes('export function installTauriWindowApi') &&
      text.includes('toggleMaximize()') &&
      text.includes('installTauriWindowCloseInterceptor') &&
      text.includes('event.preventDefault()') &&
      text.includes('requestId: ++nextWindowCloseRequestId') &&
      text.includes('request.requestId !== requestId') &&
      text.includes('pendingWindowCloseRequest = null') &&
      text.includes("listen('pebble://native-quit-requested'") &&
      text.includes("invoke<boolean>('native_quit_take_pending')") &&
      text.includes('tauriNativeQuitPoll = setInterval') &&
      text.includes('__PEBBLE_REQUEST_APP_QUIT__') &&
      !text.includes('pendingCloseIsQuitting')
  },
  {
    name: 'Native exit requests wait for renderer guards and permit one confirmed exit',
    files: [
      'apps/desktop/src-tauri/src/macos_native_quit.rs',
      'apps/desktop/src-tauri/src/native_quit.rs',
      'apps/desktop/src-tauri/src/main.rs',
      'apps/desktop/src-tauri/src/window_state.rs'
    ],
    expect: (text) =>
      text.includes('RunEvent::ExitRequested') &&
      text.includes('api.prevent_exit()') &&
      text.includes('applicationShouldTerminate:') &&
      text.includes('class_addMethod') &&
      text.includes('TerminateCancel') &&
      text.includes('pebble://native-quit-requested') &&
      text.includes('native_quit_take_pending') &&
      text.includes('mark_native_quit_requested') &&
      text.includes('permit_next_exit') &&
      text.includes('native-quit-hook-installing') &&
      text.includes('record_native_startup_failure') &&
      !text.includes('macos_native_quit::install(app.handle())?') &&
      !text.includes('record_stage(app.handle(), "window-configured")?') &&
      !/\.setup\(\|app\| \{[\s\S]*?\?;[\s\S]*?\.on_page_load/.test(text)
  },
  {
    name: 'Native document startup and retry preserve newer renderer mutations',
    file: 'apps/desktop/src/native-document-backend.ts',
    expect: (text) =>
      text.includes('mutationGeneration') &&
      text.includes('generation !== this.mutationGeneration') &&
      text.includes('if (this.pending === null)')
  },
  {
    name: 'Tauri settings API emits renderer-visible settings and UI state changes',
    file: 'apps/desktop/src/tauri-settings-event-api.ts',
    expect: (text) =>
      text.includes('export function installTauriSettingsEventApi') &&
      text.includes('settingsChangedListeners') &&
      text.includes('uiStateChangedListeners') &&
      text.includes('openFileFromMobileListeners') &&
      text.includes('openDiffFromMobileListeners') &&
      text.includes('emitSettingsChanged(updates)') &&
      text.includes('emitUiStateChanged(await uiBase.get())') &&
      text.includes('emitTauriOpenFileFromMobile') &&
      text.includes('emitTauriOpenDiffFromMobile')
  },
  {
    name: 'Tauri menu API bridges native menu actions into renderer callbacks',
    file: 'apps/desktop/src/tauri-menu-api.ts',
    expect: (text) =>
      text.includes('Menu,') &&
      text.includes("from '@tauri-apps/api/menu'") &&
      text.includes("import { getCurrentWebview } from '@tauri-apps/api/webview'") &&
      text.includes('getEffectiveKeybindingsForAction') &&
      text.includes('export function installTauriMenuApi') &&
      text.includes(
        'Menu.new({ items: await buildTauriMenuTemplate(await readTauriKeybindingOverrides()) })'
      ) &&
      text.includes('setAsAppMenu()') &&
      text.includes('popup(undefined, getCurrentWindow())') &&
      text.includes('onTerminalZoom: subscribeTerminalZoom') &&
      text.includes("onOpenQuickOpen: subscribeEmptyUiEvent('openQuickOpen')") &&
      text.includes("onJumpToWorktreeIndex: subscribeIndexedUiEvent('jumpToWorktreeIndex')") &&
      text.includes('onWorktreeHistoryNavigate: subscribeWorktreeHistoryNavigate') &&
      text.includes("onDictationKeyDown: subscribeEmptyUiEvent('dictationKeyDown')") &&
      text.includes("emitEmptyUiEvent('appMenuPaste')") &&
      text.includes('Check for Updates...') &&
      text.includes('Toggle Developer Tools') &&
      text.includes('toggleTauriDevtools()') &&
      text.includes('setZoom(Math.pow(1.2, level))') &&
      text.includes('await buildTauriAppearanceMenuItems(rebuildTauriApplicationMenu)') &&
      text.includes('installTauriMenuKeybindingSubscription') &&
      text.includes('installTauriWindowShortcutBridge') &&
      text.includes('menuLabelWithShortcut') &&
      text.includes('native accelerators would steal terminal/editor/recorder key events') &&
      !text.includes(
        "menuItem('Force Reload', () => reloadTauriRenderer(true), 'CmdOrCtrl+Shift+R')"
      ) &&
      !text.includes(
        "menuItem('Toggle Left Sidebar', () => emitEmptyUiEvent('toggleLeftSidebar'), 'CmdOrCtrl+B')"
      )
  },
  {
    name: 'Tauri UI event bus keeps menu and shortcut bridge callbacks unified',
    file: 'apps/desktop/src/tauri-ui-events.ts',
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
    file: 'apps/desktop/src/tauri-window-shortcut-bridge.ts',
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
      text.includes('Tauri has no Electron before-input-event') &&
      text.includes('TAURI_SPEECH_AVAILABLE') &&
      text.includes('isTauriSpeechModelAvailable') &&
      text.includes('if (!TAURI_SPEECH_AVAILABLE)')
  },
  {
    name: 'Tauri Appearance menu reads persisted settings and UI state',
    file: 'apps/desktop/src/tauri-appearance-menu-state.ts',
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
    files: [
      'apps/desktop/src/tauri-runtime-pty-api.ts',
      'apps/desktop/src/tauri-runtime-pty-events.ts',
      'apps/desktop/src/tauri-runtime-pty-spawn.ts'
    ],
    expect: (text) =>
      text.includes('export function installTauriRuntimePtyApi') &&
      text.includes('spawn: (opts) => spawnRuntimePty(opts, rememberRuntimePtySize)') &&
      text.includes('"/v1/sessions"') &&
      text.includes('createRuntimePtyInputBatcher(sendRuntimePtyInput)') &&
      text.includes('writeRuntimePtyInput(id, data)') &&
      text.includes('clearBuffer: (id) =>') &&
      text.includes('/clear-buffer') &&
      text.includes('resize: resizeRuntimePty') &&
      text.includes('reportGeometry: resizeRuntimePty') &&
      text.includes('const size = rememberRuntimePtySize(id, cols, rows)') &&
      text.includes('runtimePtySizeById.get(id) ?? null') &&
      text.includes('getMainBufferSnapshot: getRuntimePtyBufferSnapshot') &&
      text.includes('configureRuntimePtyEventExit((sessionId) =>') &&
      text.includes('ensureRuntimePtyEventDelivery()') &&
      text.includes('onData: addRuntimePtyDataListener') &&
      text.includes('onExit: addRuntimePtyExitListener') &&
      text.includes('recordRuntimeAgentSessionSpawn({ session, spawnOptions: opts })') &&
      text.includes('markRuntimeAgentSessionStopped(id)') &&
      text.includes('management: {') &&
      text.includes('listSessions: listManagedRuntimePtySessions') &&
      text.includes('killAll: killAllManagedRuntimePtySessions') &&
      text.includes('restart: restartManagedRuntimePtyProcess') &&
      text.includes('ackData: acknowledgeRuntimePtyData') &&
      text.includes('setActiveRendererPty: setActiveRuntimeRendererPty') &&
      text.includes('setRendererPtyVisible: setRuntimeRendererPtyVisible') &&
      text.includes('onReplay: addRuntimePtyReplayListener') &&
      text.includes('onSerializeBufferRequest: addTauriSerializeBufferRequestListener') &&
      text.includes('sendSerializedBuffer: sendTauriSerializedBuffer') &&
      text.includes('declarePendingPaneSerializer: declareTauriPendingPaneSerializer') &&
      text.includes('launchToken: opts.launchToken') &&
      text.includes('tabId: opts.tabId') &&
      text.includes('leafId: opts.leafId') &&
      !text.includes("requestRuntimeJson<RuntimeSession[]>('GET', '/v1/sessions').catch") &&
      text.includes('window.api.worktrees.listAll()')
  },
  {
    name: 'Tauri PTY renderer delivery enforces ACK backpressure and pane priority',
    file: 'apps/desktop/src/tauri-runtime-pty-delivery.ts',
    expect: (text) =>
      text.includes('inFlightCharsByPty') &&
      text.includes('acknowledgeRuntimePtyData') &&
      text.includes('activePtys') &&
      text.includes('visiblePtys') &&
      text.includes('ackGatedFlushSkipCount') &&
      text.includes('getRuntimePtyDeliveryDebugSnapshot')
  },
  {
    name: 'Tauri PTY serializer coordination has real generations and snapshot responses',
    file: 'apps/desktop/src/tauri-runtime-pty-serializer.ts',
    expect: (text) =>
      text.includes('pendingSerializerGenerationByPane') &&
      text.includes('pendingSnapshotRequests') &&
      text.includes('requestTauriSerializedBuffer') &&
      text.includes('sendTauriSerializedBuffer') &&
      text.includes('settleTauriPaneSerializer')
  },
  {
    name: 'Tauri runtime PTY input uses a pooled native data plane',
    file: 'apps/desktop/src-tauri/src/commands/runtime_pty_input.rs',
    expect: (text) =>
      text.includes('static CLIENT: LazyLock<Client>') &&
      text.includes('pool_idle_timeout') &&
      text.includes('tcp_nodelay(true)') &&
      text.includes('write_runtime_pty_input') &&
      text.includes('["v1", "sessions", session_id, "input"]') &&
      text.includes('StatusCode::LOCKED')
  },
  {
    name: 'Tauri runtime PTY input batches printable keys without bridge acknowledgement latency',
    file: 'apps/desktop/src/runtime-pty-input-batcher.ts',
    expect: (text) =>
      text.includes('queueMicrotask(() => flush(sessionId, queue))') &&
      text.includes('flushScheduled: boolean') &&
      text.includes('if (queue.pending.length === 0) return') &&
      !text.includes('sending: boolean') &&
      text.includes('shouldFlushImmediately') &&
      text.includes("writes.map((write) => write.data).join('')") &&
      !text.includes('INPUT_BATCH_WINDOW_MS')
  },
  {
    name: 'Tauri canonical windows declare the core and plugin capabilities used at bootstrap',
    file: 'apps/desktop/src-tauri/capabilities/main.json',
    expect: (text) => {
      const capability = JSON.parse(text)
      return (
        capability.windows?.includes('main') &&
        capability.windows?.includes('optimized') &&
        [
          'core:default',
          'notification:default',
          'process:default',
          'updater:default',
          'deep-link:default'
        ].every((permission) => capability.permissions?.includes(permission))
      )
    }
  },
  {
    name: 'Rust PTY input worker collapses queued bytes before each runtime round trip',
    file: 'apps/desktop/src-tauri/src/commands/runtime_pty_input.rs',
    expect: (text) =>
      text.includes('while let Ok(next) = receiver.try_recv()') &&
      text.includes('queued.input.text.push_str(&next.input.text)') &&
      text.includes('post_runtime_pty_input(queued.input).await')
  },
  {
    name: 'Tauri runtime PTY API tests reject fake empty terminal state on runtime failures',
    file: 'apps/desktop/src/tauri-runtime-pty-api.test.ts',
    expect: (text) =>
      text.includes('maps pty session lists from runtime sessions') &&
      text.includes('propagates session list runtime failures') &&
      text.includes('backs PTY management with native runtime sessions and termination') &&
      text.includes('restarts the Rust-managed runtime process') &&
      text.includes('/v1/sessions') &&
      text.includes('terminal runtime unavailable')
  },
  {
    name: 'Tauri runtime PTY events prefer push delivery with polling fallback',
    file: 'apps/desktop/src/tauri-runtime-pty-events.ts',
    expect: (text) =>
      text.includes('subscribeRuntimeEventPush') &&
      text.includes("entry.topic === 'session.output'") &&
      text.includes("entry.topic === 'session.status'") &&
      text.includes('setRuntimePtyPolling(!pushActive)') &&
      text.includes("readRuntimeEvents('session.output')") &&
      text.includes("readRuntimeEvents('session.status')") &&
      text.includes('emitRuntimeAgentSessionStatus(session)') &&
      text.includes('onSessionExit?.(session.id)')
  },
  {
    name: 'Tauri agent-status API maps runtime sessions to renderer AgentStatus IPC',
    file: 'apps/desktop/src/tauri-agent-status-api.ts',
    expect: (text) =>
      text.includes('export function installTauriAgentStatusApi') &&
      text.includes('window.api.agentStatus =') &&
      text.includes('getSnapshot: async () =>') &&
      text.includes('hydrateRuntimeAgentSessionSnapshot()') &&
      text.includes("createRuntimeResourceGetCommand({ path: '/v1/sessions'") &&
      text.includes('recordRuntimeAgentSessionSpawn') &&
      text.includes('makePaneKey(tabId, leafId)') &&
      text.includes("case 'failed':") &&
      text.includes("return 'blocked'") &&
      text.includes("case 'stopped':") &&
      text.includes('inferRuntimeAgentInterrupt') &&
      text.includes('recordMigrationUnsupportedSession') &&
      text.includes('migrationUnsupportedByPtyId') &&
      text.includes('agent-migration-unsupported') &&
      text.includes('write_settings_document') &&
      !text.includes('onMigrationUnsupported: () => noopUnsubscribe') &&
      !text.includes('getMigrationUnsupportedSnapshot: () => Promise.resolve([])') &&
      !text.includes('listRuntimeSessions().catch(() => [])') &&
      text.includes('dropRuntimeAgentTab(tabId)') &&
      text.includes('connectionId: null')
  },
  {
    name: 'Tauri agent-status tests keep failed sessions visible as blocked activity',
    file: 'apps/desktop/src/tauri-agent-status-api.test.ts',
    expect: (text) =>
      text.includes('maps failed runtime session snapshots to blocked agent status') &&
      text.includes('propagates runtime session snapshot failures') &&
      text.includes("status: 'failed'") &&
      text.includes("state: 'blocked'") &&
      text.includes('preserves stopped runtime sessions as interrupted done status') &&
      text.includes('surfaces and clears legacy numeric pane sessions instead of dropping them') &&
      text.includes("reason: 'legacy-numeric-pane-key'") &&
      text.includes('interrupted: true')
  },
  {
    name: 'Tauri runtime RPC maps terminal lifecycle and IO to Go sessions',
    file: 'apps/desktop/src/tauri-terminal-runtime-rpc.ts',
    expect: (text) =>
      text.includes('export async function callTauriTerminalRuntimeRpc') &&
      text.includes("case 'terminal.create'") &&
      text.includes("case 'terminal.list'") &&
      text.includes("case 'terminal.resolveActive'") &&
      text.includes("case 'terminal.show'") &&
      text.includes("case 'terminal.read'") &&
      text.includes("case 'terminal.inspectProcess'") &&
      text.includes("case 'terminal.clearBuffer'") &&
      text.includes("case 'terminal.send'") &&
      text.includes("case 'terminal.wait'") &&
      text.includes("case 'terminal.agentStatus'") &&
      text.includes("case 'terminal.isRunningAgent'") &&
      text.includes("case 'terminal.resolvePane'") &&
      text.includes("case 'terminal.stop'") &&
      text.includes("case 'terminal.stopExact'") &&
      text.includes("case 'terminal.focus'") &&
      text.includes("case 'terminal.close'") &&
      text.includes("case 'terminal.split'") &&
      text.includes("'/v1/sessions'") &&
      text.includes('/transcript?${query.toString()}') &&
      text.includes('RuntimeTerminalTranscriptRead') &&
      text.includes('/clear-buffer') &&
      text.includes('/input') &&
      text.includes("method: 'DELETE'") &&
      text.includes("['/bin/sh', '-lc', command]") &&
      text.includes('parsePaneKey(paneKey)') &&
      text.includes('appendNewline') &&
      text.includes('expectedPtyIds') &&
      text.includes('Hook-reported readiness') &&
      text.includes('/status`') &&
      text.includes('status.foregroundProcess') &&
      text.includes('status.hasChildProcesses === true')
  },
  {
    name: 'Go runtime owns terminal transcript retention and absolute cursor pagination',
    file: 'runtime/go/internal/runtimecore/terminal_transcript.go',
    expect: (text) =>
      text.includes('completedLineCount uint64') &&
      text.includes('bufferTruncated') &&
      text.includes('pendingUTF8') &&
      text.includes('func (t *terminalTranscript) read(') &&
      text.includes('OldestCursor') &&
      text.includes('NextCursor') &&
      text.includes('LatestCursor') &&
      text.includes('trimTerminalTranscriptPreview') &&
      text.includes('Bare carriage return moves the terminal cursor')
  },
  {
    name: 'Encrypted remote terminal reads reuse the Go transcript cursor contract',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control.go',
    expect: (text) =>
      text.includes('readLegacySharedControlTranscriptRequest') &&
      text.includes('ReadSessionTranscript(terminalID, cursor, limit)') &&
      text.includes('legacySharedControlTerminalReadResult') &&
      !text.includes('"oldestCursor": "0", "nextCursor": legacySharedControlCursor(len(lines))')
  },
  {
    name: 'Go session status reports alternate screen and process inspection',
    file: 'runtime/go/internal/runtimecore/process_session.go',
    expect: (text) =>
      text.includes('AltScreenActive:  s.altScreen.Active()') &&
      text.includes('resolveProcessInspection(pid)') &&
      text.includes('snapshot.HasChildProcesses = hasChildren')
  },
  {
    name: 'Go Windows session status uses bounded structured process inspection',
    file: 'runtime/go/internal/runtimecore/foreground_process_windows.go',
    expect: (text) =>
      text.includes('windowsProcessProbeTimeout') &&
      text.includes('Get-CimInstance -ClassName Win32_Process') &&
      text.includes('ConvertTo-Json -Compress') &&
      text.includes('collectWindowsProcessDescendants') &&
      text.includes('exec.CommandContext') &&
      !text.includes('foregroundProcessSupported = false')
  },
  {
    name: 'Go Windows sessions use real ConPTY instead of pipes',
    file: 'runtime/go/internal/runtimecore/process_session_windows.go',
    expect: (text) =>
      text.includes('github.com/aymanbagabas/go-pty') &&
      text.includes('terminalpty.New()') &&
      text.includes('configured := &exec.Cmd{Args: append([]string(nil), launchCommand...)') &&
      text.includes('launchCommand = configured.Args') &&
      text.includes('pty.Resize(session.cols, session.rows)') &&
      text.includes('session.resizePty = pty.Resize') &&
      text.includes('session.readStream("stdout", pty)') &&
      !text.includes('StdoutPipe') &&
      !text.includes('StderrPipe')
  },
  {
    name: 'Go sessions launch SSH projects through a real system SSH PTY',
    file: 'runtime/go/internal/runtimecore/session_workspace.go',
    expect: (text) =>
      text.includes('resolveSshSessionStartRequest') &&
      text.includes('sshCommandArgs(target, remoteCommand)') &&
      text.includes('interactiveArgs := append([]string{"-tt"}') &&
      text.includes('configureSshAskpass') &&
      text.includes('quoteRemoteSessionCommand') &&
      text.includes('remote session cwd must be absolute') &&
      text.includes('remote session cwd escapes its workspace') &&
      text.includes('pathpkg.Clean')
  },
  {
    name: 'Tauri SSH session termination is runtime-backed',
    file: 'apps/desktop/src/tauri-ssh-targets-api.ts',
    expect: (text) =>
      text.includes('async function terminateSessions') &&
      text.includes('/sessions/terminate`') &&
      text.includes('failedIds') &&
      text.includes('terminateSessions,') &&
      text.includes('resetRelayByTargetId') &&
      text.includes('terminateSessions(args)') &&
      !text.includes('terminateSessions: () => Promise.resolve()')
  },
  {
    name: 'Tauri SSH port forwards, detection, and browsing are runtime-backed',
    file: 'apps/desktop/src/tauri-ssh-targets-api.ts',
    expect: (text) =>
      text.includes('async function addPortForward') &&
      text.includes('/port-forwards/restore`') &&
      text.includes('async function listDetectedPorts') &&
      text.includes('/ports/detected`') &&
      text.includes('async function browseDir') &&
      text.includes('/browse`') &&
      text.includes('onDetectedPortsChanged') &&
      text.includes('terminatePortForwards(args.targetId)') &&
      text.includes('/port-forwards/terminate`') &&
      !text.includes('listDetectedPorts: () => Promise.resolve([])') &&
      !text.includes('browseDir: () => Promise.resolve')
  },
  {
    name: 'Tauri app API uses native unread badge counts',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes('getCurrentWindow') &&
      text.includes('setUnreadDockBadgeCount') &&
      text.includes('setBadgeCount') &&
      !text.includes('setUnreadDockBadgeCount: () => Promise.resolve()')
  },
  {
    name: 'Tauri platform API reports native OS release and Linux display server',
    file: 'apps/desktop/src-tauri/src/commands/app_native.rs',
    expect: (text) =>
      text.includes('pub fn app_platform_info') &&
      text.includes('platform_os_release') &&
      text.includes('XDG_SESSION_TYPE') &&
      text.includes('WAYLAND_DISPLAY') &&
      text.includes('powershell.exe')
  },
  {
    name: 'Tauri local clipboard text and image paths are native',
    file: 'apps/desktop/src-tauri/src/commands/clipboard.rs',
    expect: (text) =>
      text.includes('clipboard_read_text') &&
      text.includes('clipboard_write_text') &&
      text.includes('clipboard_read_selection_text') &&
      text.includes('clipboard_write_selection_text') &&
      text.includes('LinuxClipboardKind::Primary') &&
      text.includes('GetExtLinux') &&
      text.includes('SetExtLinux') &&
      text.includes('clipboard_write_file') &&
      text.includes('.file_list(&[path])') &&
      text.includes('clipboard_file_rejected("is-directory")') &&
      text.includes('clipboard_save_image_as_temp_file') &&
      text.includes('clipboard_write_image') &&
      text.includes('MAX_CLIPBOARD_IMAGE_BYTES') &&
      text.includes('app_cache_dir')
  },
  {
    name: 'Tauri renderer installs the native clipboard adapter',
    file: 'apps/desktop/src/tauri-clipboard-api.ts',
    expect: (text) =>
      text.includes('installTauriClipboardApi') &&
      text.includes('clipboard_read_text') &&
      text.includes('clipboard_read_selection_text') &&
      text.includes('clipboard_write_selection_text') &&
      text.includes('clipboard_write_file') &&
      text.includes('base.writeClipboardFile(args)') &&
      text.includes('clipboard_write_image') &&
      text.includes('base.saveClipboardImageAsTempFile(args)')
  },
  {
    name: 'Tauri native paste uses focused OS responders instead of document execCommand',
    file: 'apps/desktop/src-tauri/src/commands/native_paste.rs',
    expect: (text) =>
      text.includes('sendAction_to_from') &&
      text.includes('sel!(paste:)') &&
      text.includes('sel!(pasteAsPlainText:)') &&
      text.includes('NativePasteMode::Paste => "Paste"') &&
      text.includes('NativePasteMode::PasteAndMatchStyle => "PasteAsPlainText"') &&
      text.includes('WM_PASTE') &&
      text.includes('perform_windows_plain_text_paste') &&
      text.includes('build_plain_text_paste_script') &&
      text.includes('target.setRangeText') &&
      text.includes('target.isContentEditable') &&
      text.includes("inputType: 'insertFromPaste'") &&
      !text.includes('document.execCommand(')
  },
  {
    name: 'Tauri Linux browser cancellation owns the native WebKit download object',
    file: 'apps/desktop/src-tauri/src/commands/browser_webview_download_linux.rs',
    expect: (text) =>
      text.includes('connect_download_started') &&
      text.includes('connect_decide_destination') &&
      text.includes('HashMap<String, Download>') &&
      text.includes('claim_pending_download_for_url') &&
      text.includes('download.cancel()') &&
      text.includes('run_on_main_thread')
  },
  {
    name: 'Tauri macOS browser cancellation retains and forwards native WKDownload delegates',
    file: 'apps/desktop/src-tauri/src/commands/browser_webview_download_macos.rs',
    expect: (text) =>
      text.includes('WKDownload') &&
      text.includes('navigationAction:didBecomeDownload:') &&
      text.includes('navigationResponse:didBecomeDownload:') &&
      text.includes('method_getImplementation') &&
      text.includes('browser download navigation delegate is unavailable') &&
      text.includes('method_implementation(class, action_selector)') &&
      text.includes('Arc::try_unwrap(result)') &&
      text.includes('original(delegate, selector') &&
      text.includes('native_download_id: Option<String>') &&
      text.includes('claim_pending_download_for_url') &&
      text.includes('entry.native_download_id.as_deref() == Some(&native_download_id)') &&
      text.includes('entry.download.cancel(None)') &&
      text.includes('Duration::from_secs(600)') &&
      text.includes('downloads.len() > 128') &&
      text.includes('run_on_main_thread')
  },
  {
    name: 'Tauri browser HTTP auth resolves native challenges on every desktop platform',
    file: 'apps/desktop/src-tauri/src/commands/browser_http_auth.rs',
    expect: (text) =>
      text.includes('browser_child_webview_set_http_auth') &&
      text.includes('MAX_AUTH_USER_CHARS') &&
      text.includes('MAX_AUTH_PASSWORD_CHARS') &&
      text.includes('didReceiveAuthenticationChallenge:completionHandler:') &&
      text.includes('class_addMethod') &&
      text.includes('class_replaceMethod') &&
      text.includes('NSURLSessionAuthChallengeDisposition::UseCredential') &&
      text.includes('NSURLAuthenticationMethodHTTPBasic') &&
      text.includes('NSURLAuthenticationMethodHTTPDigest') &&
      text.includes('webkit_authentication_request_authenticate') &&
      text.includes('BasicAuthenticationRequestedEventHandler') &&
      text.includes('add_BasicAuthenticationRequested') &&
      text.includes('"scope": "native-http-basic"')
  },
  {
    name: 'Canonical Tauri browser credentials configure native and document request paths',
    file: 'packages/product-core/renderer/src/components/browser-pane/tauri-browser-page-webview.ts',
    expect: (text) =>
      text.includes('browser_child_webview_set_http_auth') &&
      text.includes('capture.authorization') &&
      text.includes("scope: 'native-http-basic'")
  },
  {
    name: 'Go source-control parity preserves conflicts binary metadata and submodule pointers',
    file: 'runtime/go/internal/runtimecore/git_diff_metadata.go',
    expect: (text) =>
      text.includes('binaryGitFileDiffResult') &&
      text.includes('OriginalByteSize') &&
      text.includes('ModifiedByteSize') &&
      text.includes('previewableBinaryMimeTypes') &&
      text.includes('buildSubmodulePointerDiff') &&
      text.includes('OldSHA') &&
      text.includes('NewSHA') &&
      text.includes('Dirty') &&
      text.includes('submoduleWorktreeDirty')
  },
  {
    name: 'Go review creation hydrates the full provider template candidate set',
    file: 'runtime/go/internal/providercli/review_creation.go',
    expect: (text) =>
      text.includes('github') &&
      text.includes('azuredevops') &&
      text.includes('gitea') &&
      text.includes('docs') &&
      text.includes('gitlab') &&
      text.includes('append')
  },
  {
    name: 'Tauri notification settings opens the native OS settings surface',
    file: 'apps/desktop/src-tauri/src/commands/notifications.rs',
    expect: (text) =>
      text.includes('open_notification_system_settings') &&
      text.includes('ms-settings:notifications') &&
      text.includes('gnome-control-center') &&
      text.includes('com.apple.preference.notifications') &&
      text.includes('load_notification_sound') &&
      text.includes('MAX_NOTIFICATION_SOUND_BYTES')
  },
  {
    name: 'Tauri notifications API does not inherit the web settings no-op',
    file: 'apps/desktop/src/tauri-notifications-api.ts',
    expect: (text) =>
      text.includes(
        "openSystemSettings: () => invoke<void>('open_notification_system_settings')"
      ) &&
      text.includes('playSound') &&
      text.includes('load_notification_sound') &&
      text.includes('two-tone.mp3?url') &&
      text.includes("invoke<NativePermissionResult>('native_notification_permission')") &&
      text.includes("invoke<NativePermissionResult>('request_native_notification_permission')") &&
      !text.includes("native_notification_permission').catch") &&
      !text.includes('dismiss/openSystemSettings/playSound')
  },
  {
    name: 'Tauri native file drops route through canonical DOM targets',
    file: 'apps/desktop/src/tauri-file-drop-api.ts',
    expect: (text) =>
      text.includes('onDragDropEvent') &&
      text.includes('document.elementFromPoint') &&
      text.includes('window.devicePixelRatio') &&
      text.includes('resolveNativeFileDropPath') &&
      text.includes('createNativeFileDropPayload') &&
      text.includes('onFileDrop: (callback)') &&
      !text.includes('onFileDrop: () => noopUnsubscribe')
  },
  {
    name: 'Tauri persists UI and local workspace session outside WebView storage',
    file: 'apps/desktop/src/native-settings-store-bridge.ts',
    expect: (text) =>
      text.includes("'pebble.web.ui.v1': 'ui'") &&
      text.includes("'pebble.web.workspaceSession.v1': 'workspace-session'") &&
      text.includes('NativeDocumentBackend') &&
      text.includes('backend.prime()')
  },
  {
    name: 'Tauri persists remote host workspace sessions in path-safe native files',
    file: 'apps/desktop/src-tauri/src/commands/session_store.rs',
    expect: (text) =>
      text.includes('Sha256::digest(host_id.as_bytes())') &&
      text.includes('read_host_workspace_session') &&
      text.includes('write_host_workspace_session') &&
      text.includes('MAX_SESSION_BYTES') &&
      text.includes('replace_session_file')
  },
  {
    name: 'Tauri session API routes non-local hosts to native persistence',
    file: 'apps/desktop/src/tauri-session-persistence-api.ts',
    expect: (text) =>
      text.includes('installTauriSessionPersistenceApi') &&
      text.includes('read_host_workspace_session') &&
      text.includes('write_host_workspace_session') &&
      text.includes('remoteSessionCache') &&
      text.includes('isLocalHost')
  },
  {
    name: 'Tauri preload replaces browser-guessed platform metadata',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes('api.platform = { get: () => platformInfo }') &&
      /invoke<PlatformInfo>\(["']app_platform_info["']\)/.test(text) &&
      !text.includes('api.platform = { get: () => ({ platform: getBrowserPlatform()')
  },
  {
    name: 'Tauri child WebViews route popups into Pebble tabs',
    file: 'apps/desktop/src-tauri/src/commands/browser_child_webview.rs',
    expect: (text) =>
      text.includes('on_new_window') &&
      text.includes('BROWSER_NEW_WINDOW_EVENT') &&
      text.includes('matches!(url.scheme(), "http" | "https")') &&
      text.includes('NewWindowResponse::Deny')
  },
  {
    name: 'Tauri browser API exposes native popup and open-link events',
    file: 'apps/desktop/src/tauri-browser-runtime-events.ts',
    expect: (text) =>
      text.includes('NATIVE_BROWSER_NEW_WINDOW_EVENT') &&
      text.includes('onTauriBrowserPopup') &&
      text.includes('onTauriBrowserOpenLink') &&
      text.includes('onTauriBrowserGuestLoadFailed') &&
      text.includes('__pebbleReportTauriBrowserLoadFailure') &&
      text.includes('safeBrowserOrigin') &&
      !text.includes('onPopup: () => noopUnsubscribe')
  },
  {
    name: 'Go owns SSH forward processes and remote discovery',
    file: 'runtime/go/internal/runtimecore/ssh_port_forwards.go',
    expect: (text) =>
      text.includes('ExitOnForwardFailure=yes') &&
      text.includes('RestoreSshPortForwards') &&
      text.includes('sshPortForwards[forward.ID]') &&
      text.includes('command.Process.Kill()')
  },
  {
    name: 'Tauri session-tabs runtime RPC exposes real Go session snapshots',
    file: 'apps/desktop/src/tauri-session-tabs-runtime-rpc.ts',
    expect: (text) =>
      text.includes('export async function callTauriSessionTabsRuntimeRpc') &&
      text.includes("case 'session.tabs.list'") &&
      text.includes("case 'session.tabs.listAll'") &&
      text.includes("case 'session.tabs.createTerminal'") &&
      text.includes("case 'session.tabs.close'") &&
      text.includes("case 'session.tabs.activate'") &&
      text.includes("case 'session.tabs.move'") &&
      text.includes("case 'session.tabs.updatePaneLayout'") &&
      text.includes("case 'session.tabs.setTabProps'") &&
      text.includes("case 'terminal.rename'") &&
      text.includes("case 'session.tabs.subscribe'") &&
      text.includes("case 'session.tabs.unsubscribe'") &&
      text.includes('sessionTabViewStateByWorktree') &&
      text.includes('moveSessionTab(params)') &&
      text.includes('updateSessionPaneLayout(params)') &&
      text.includes('setSessionTabProps(params)') &&
      text.includes('renameSessionTerminal(params)') &&
      text.includes('customTitle: title') &&
      text.includes('insertTabGroupSplit') &&
      text.includes("requestRuntimeJson<RuntimeSession[]>('/v1/sessions'") &&
      text.includes('`/v1/sessions/${encodeURIComponent(target.id)}`') &&
      text.includes("status: 'ready'") &&
      text.includes('terminal: session.id') &&
      text.includes("activeTabType: activeTabId ? 'terminal' : null") &&
      !text.includes('Promise.resolve([])') &&
      !text.includes('return []')
  },
  {
    name: 'Tauri clipboard runtime RPC persists bounded local image uploads natively',
    file: 'apps/desktop/src/tauri-clipboard-runtime-rpc.ts',
    expect: (text) =>
      text.includes("case 'clipboard.saveImageAsTempFile'") &&
      text.includes("case 'clipboard.startImageUpload'") &&
      text.includes("case 'clipboard.appendImageUploadChunk'") &&
      text.includes("case 'clipboard.commitImageUpload'") &&
      text.includes("case 'clipboard.abortImageUpload'") &&
      text.includes('clipboard_save_image_bytes_as_temp_file') &&
      text.includes('/v1/ssh-targets/clipboard-image') &&
      text.includes('MAX_CONCURRENT_UPLOADS') &&
      text.includes('UPLOAD_TTL_MS')
  },
  {
    name: 'Go SSH relay writes clipboard images into the remote system temp directory',
    file: 'runtime/go/cmd/pebble-relay-worker/main.go',
    expect: (text) =>
      text.includes('case "clipboard-write-json"') &&
      text.includes('runClipboardWriteJSON') &&
      text.includes('os.CreateTemp(os.TempDir()') &&
      text.includes('map[string]string{"path": path}')
  },
  {
    name: 'Tauri notification dispatch publishes mobile events through the Go runtime',
    file: 'apps/desktop/src/tauri-notifications-api.ts',
    expect: (text) =>
      text.includes('/v1/notifications/dispatch') &&
      text.includes("args.source !== 'test'") &&
      text.includes('buildNotificationOptions(args)') &&
      text.includes('notificationId: args.notificationId') &&
      text.includes('async function dismiss') &&
      text.includes("body: { type: 'dismiss', notificationId }")
  },
  {
    name: 'Go mobile relay forwards transient notification events independent of projection diet',
    file: 'runtime/go/internal/runtimecore/mobile_relay.go',
    expect: (text) =>
      text.includes('case "notification.dispatched"') && text.includes('return event, true')
  },
  {
    name: 'Tauri stats summary reads Go-owned persisted lifetime aggregates',
    file: 'apps/desktop/src/tauri-stats-runtime-rpc.ts',
    expect: (text) =>
      text.includes("method !== 'stats.summary'") &&
      text.includes('/v1/stats/summary') &&
      text.includes('firstEventAt: summary.firstEventAt ?? null')
  },
  {
    name: 'Go runtime persists agent and hosted-review lifetime statistics',
    file: 'runtime/go/internal/runtimecore/stats.go',
    expect: (text) =>
      text.includes('recordSessionStats') &&
      text.includes('TotalAgentsSpawned++') &&
      text.includes('TotalAgentTimeMs') &&
      text.includes('recordCreatedReview') &&
      text.includes('CountedPRURLs')
  },
  {
    name: 'Tauri skill discovery uses the native Go scanner',
    file: 'apps/desktop/src/tauri-skills-runtime-rpc.ts',
    expect: (text) =>
      text.includes("method !== 'skills.discover'") &&
      text.includes('/v1/skills/discover') &&
      text.includes('timeoutMs: 15_000')
  },
  {
    name: 'Go skill scanner preserves Electron roots, bounds, metadata, and symlink safety',
    file: 'runtime/go/internal/runtimecore/skills.go',
    expect: (text) =>
      text.includes('"home-codex"') &&
      text.includes('"codex-plugin-cache"') &&
      text.includes('"repo-agents-"') &&
      text.includes('maxSkillMarkdownBytes') &&
      text.includes('maxSkillPackageFiles') &&
      text.includes('filepath.EvalSymlinks') &&
      text.includes('summarizeSkillMarkdown')
  },
  {
    name: 'Tauri diagnostics memory RPC maps Go PTY PIDs into the native process collector',
    file: 'apps/desktop/src/tauri-diagnostics-runtime-rpc.ts',
    expect: (text) =>
      text.includes("method !== 'diagnostics.memory'") &&
      text.includes('export async function readTauriMemorySnapshot') &&
      text.includes('diagnostics_memory_snapshot') &&
      text.includes('session.pid') &&
      text.includes('HISTORY_CAPACITY = 60') &&
      text.includes('pushMemoryHistory')
  },
  {
    name: 'Tauri Resource Manager uses the native memory collector instead of the web zero snapshot',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes('readTauriMemorySnapshot') &&
      text.includes('api.memory = { getSnapshot: readTauriMemorySnapshot }') &&
      text.indexOf('api.memory = { getSnapshot: readTauriMemorySnapshot }') <
        text.indexOf('installTauriAccountsSnapshotSync()')
  },
  {
    name: 'Go runtime owns bounded cross-platform workspace port discovery and safe termination',
    file: 'runtime/go/internal/runtimecore/workspace_ports.go',
    expect: (text) =>
      text.includes('workspacePortLimit = 200') &&
      text.includes('context.WithTimeout(parent, 4*time.Second)') &&
      text.includes('runtime.GOOS == "windows"') &&
      text.includes('exec.CommandContext(ctx, "lsof"') &&
      text.includes('attributeWorkspacePort') &&
      text.includes('project.LocationKind == "ssh"') &&
      text.includes('m.ScanWorkspacePorts(ctx, req.RepoID)') &&
      text.includes('req.PID == os.Getpid()') &&
      text.includes('terminateWorkspacePortProcess(req.PID)')
  },
  {
    name: 'Tauri workspace port UI uses real Go routes instead of the web fallback proxy',
    file: 'apps/desktop/src/tauri-workspace-ports-api.ts',
    expect: (text) =>
      text.includes('/v1/workspace-ports') &&
      text.includes('/v1/workspace-ports/kill') &&
      text.includes('workspace-port.advertised-url-changed')
  },
  {
    name: 'Go owns validated repo-scoped sparse preset persistence and change events',
    file: 'runtime/go/internal/runtimecore/sparse_presets.go',
    expect: (text) =>
      text.includes('normalizeSparsePresetDirectories') &&
      text.includes('Preset name is required.') &&
      text.includes('Preset directories must be repo-relative paths.') &&
      text.includes('m.saveLocked()') &&
      text.includes('m.emit("repo.sparse-presets.changed"')
  },
  {
    name: 'Tauri sparse preset UI no longer inherits web fallback results',
    file: 'apps/desktop/src/tauri-sparse-presets-api.ts',
    expect: (text) =>
      text.includes('/v1/sparse-presets') &&
      text.includes('repo.sparse-presets.changed') &&
      text.includes('ensurePebbleRuntimeProcess')
  },
  {
    name: 'Go runtime owns cancellable workspace disk analysis without following symlinks',
    file: 'runtime/go/internal/runtimecore/workspace_space.go',
    expect: (text) =>
      text.includes('workspaceSpaceTopItemLimit = 20') &&
      text.includes('context.WithCancel(parent)') &&
      text.includes('m.workspaceSpaceCancel = cancel') &&
      text.includes('func (m *Manager) CancelWorkspaceSpaceAnalysis() bool') &&
      text.includes('workspaceSpaceProjectWorktrees') &&
      !text.includes('var workspaceSpaceScans') &&
      text.includes('filepath.WalkDir') &&
      text.includes('fs.ModeSymlink') &&
      text.includes('project.LocationKind == "ssh"') &&
      text.includes('m.emit("workspace-space.progress"')
  },
  {
    name: 'Tauri workspace space manager uses Go analyze, cancel, and progress APIs',
    file: 'apps/desktop/src/tauri-workspace-space-api.ts',
    expect: (text) =>
      text.includes('/v1/workspace-space/analyze') &&
      text.includes('/v1/workspace-space/cancel') &&
      text.includes('workspace-space.progress')
  },
  {
    name: 'Rust diagnostics collector aggregates cross-platform process trees and host metrics',
    file: 'apps/desktop/src-tauri/src/commands/diagnostics_memory.rs',
    expect: (text) =>
      text.includes('System::new_all()') &&
      text.includes('process_tree_usage') &&
      text.includes('process.parent()') &&
      text.includes('system.total_memory()') &&
      text.includes('MINIMUM_CPU_UPDATE_INTERVAL')
  },
  {
    name: 'Tauri runtime RPC maps file explorer operations to Go file endpoints',
    file: 'apps/desktop/src/tauri-file-runtime-rpc.ts',
    expect: (text) =>
      text.includes('export async function callTauriFileRuntimeRpc') &&
      text.includes("case 'files.list'") &&
      text.includes("case 'files.open'") &&
      text.includes("case 'files.openDiff'") &&
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
      text.includes('legacySshRelayFileMethods.has(method)') &&
      text.includes('Paired runtime') &&
      text.includes('emitTauriOpenFileFromMobile') &&
      text.includes('emitTauriOpenDiffFromMobile') &&
      text.includes('/v1/files/tree') &&
      text.includes('/v1/files/read-chunk') &&
      text.includes('/v1/files/write') &&
      text.includes('/v1/files/write-base64') &&
      text.includes('/v1/files/browse-dir') &&
      text.includes('/v1/files/search')
  },
  {
    name: 'Go SSH relay worker supports bounded live file lists, tree, chunk, and stat reads',
    file: 'runtime/go/cmd/pebble-relay-worker/main.go',
    expect: (text) =>
      text.includes('case "file-read-json":') &&
      text.includes('case "file-tree-json":') &&
      text.includes('case "file-read-chunk-json":') &&
      text.includes('case "file-stat-json":') &&
      text.includes('case "file-list-all-json":') &&
      text.includes('case "file-mutate-json":') &&
      text.includes('case "file-search-json":') &&
      text.includes('case "file-watch-snapshot-json":') &&
      text.includes('flag.NewFlagSet("file-read-json"') &&
      text.includes('flag.NewFlagSet("file-tree-json"') &&
      text.includes('flag.NewFlagSet("file-read-chunk-json"') &&
      text.includes('flag.NewFlagSet("file-stat-json"') &&
      text.includes('flag.NewFlagSet("file-list-all-json"') &&
      text.includes('readWorkspaceFile') &&
      text.includes('readWorkspaceFileChunk') &&
      text.includes('runFileMutateJSON') &&
      text.includes('runFileSearchJSON') &&
      text.includes('runFileWatchSnapshotJSON') &&
      text.includes('resolveWorkspaceMutationTarget') &&
      text.includes('json.NewEncoder(output).Encode(runtimecore.FileContent')
  },
  {
    name: 'Go file manager falls back to the auto-deployed SSH relay for live reads',
    file: 'runtime/go/internal/runtimecore/files.go',
    expect: (text) =>
      text.includes('m.readSshFile(ctx, req)') &&
      text.includes('m.listSshFiles(ctx, req)') &&
      text.includes('m.readSshFileChunk(ctx, req)') &&
      text.includes('m.statSshFile(ctx, req)') &&
      text.includes('m.listAllSshFiles(ctx, req)') &&
      text.includes('m.mutateSshFile(') &&
      text.includes('m.searchSshFiles(ctx, req)') &&
      text.includes('m.sshFileWatchSnapshot(ctx, req)') &&
      text.includes('"file-read-json"') &&
      text.includes('"file-tree-json"') &&
      text.includes('"file-read-chunk-json"') &&
      text.includes('"file-stat-json"') &&
      text.includes('"file-list-all-json"') &&
      text.includes('"file-mutate-json"') &&
      text.includes('"file-search-json"') &&
      text.includes('"file-watch-snapshot-json"') &&
      text.includes('m.runSshRelayWorker') &&
      text.includes('return FileContent{}, relayErr')
  },
  {
    name: 'Tauri legacy SSH watches diff Go relay metadata snapshots',
    file: 'apps/desktop/src/tauri-file-watch-api.ts',
    expect: (text) =>
      text.includes('startLegacySshWatch') &&
      text.includes('/v1/files/watch-snapshot') &&
      text.includes('diffFileWatchSnapshots') &&
      text.includes('LEGACY_SSH_WATCH_INTERVAL_MS') &&
      text.includes('globalThis.clearTimeout')
  },
  {
    name: 'Go SSH relay transport streams mutation payloads over stdin',
    file: 'runtime/go/internal/runtimecore/ssh_text_generation_relay.go',
    expect: (text) =>
      text.includes('runSshRelayWorkerWithInput') &&
      text.includes('cmd.Stdin = bytes.NewReader(input)') &&
      text.includes('runSshRelayWorkerCommand') &&
      text.includes('remoteWorkerCommand(deployment, relayArgs)')
  },
  {
    name: 'Go owns scoped TTL grants for legacy SSH terminal artifacts',
    file: 'runtime/go/internal/runtimecore/ssh_terminal_artifacts.go',
    expect: (text) =>
      text.includes('sshTerminalArtifactGrantTTL') &&
      text.includes('GrantSshTerminalArtifact') &&
      text.includes('requireSshTerminalArtifactGrant') &&
      text.includes('terminal_file_grant_mismatch') &&
      text.includes('"terminal-artifact-json"')
  },
  {
    name: 'SSH relay worker enforces terminal artifact path and identity safety',
    file: 'runtime/go/cmd/pebble-relay-worker/terminal_artifacts.go',
    expect: (text) =>
      text.includes('resolveAllowedTerminalArtifact') &&
      text.includes('rejectHardLinkedArtifact') &&
      text.includes('terminal_file_grant_stale') &&
      text.includes('replaceTerminalArtifact') &&
      text.includes('terminalArtifactTextLimit')
  },
  {
    name: 'Tauri falls back to Go grants for legacy SSH terminal artifacts',
    file: 'apps/desktop/src/tauri-file-runtime-rpc.ts',
    expect: (text) =>
      text.includes('resolveLegacySshTerminalPath') &&
      text.includes('/v1/files/terminal-artifact/grant') &&
      text.includes('/v1/files/terminal-artifact/read') &&
      text.includes('/v1/files/terminal-artifact/preview') &&
      text.includes('/v1/files/terminal-artifact/write') &&
      text.includes('hasRecentTerminalOutputPath')
  },
  {
    name: 'Go relay worker emits structured remote clone progress',
    file: 'runtime/go/cmd/pebble-relay-worker/project_clone.go',
    expect: (text) =>
      text.includes('flag.NewFlagSet("project-clone-json"') &&
      text.includes('"git", "clone", "--progress"') &&
      text.includes('Type: "progress"') &&
      text.includes('Type: "complete"') &&
      text.includes('expandCloneDestination')
  },
  {
    name: 'Go streams and cancels SSH project clones through the shared clone slot',
    file: 'runtime/go/internal/runtimecore/ssh_project_clone.go',
    expect: (text) =>
      text.includes('cloneSshProject') &&
      text.includes('m.beginClone(cancel)') &&
      text.includes('m.deploySshRelayWorker') &&
      text.includes('m.emit("project.cloneProgress"') &&
      text.includes('LocationKind: "ssh"')
  },
  {
    name: 'Tauri exposes repos.cloneRemote through the Go SSH clone route',
    file: 'apps/desktop/src/pebble-tauri-workspace-runtime-api.ts',
    expect: (text) =>
      text.includes('cloneRemote: async') &&
      text.includes('body: { hostId: connectionId, url, destination }') &&
      text.includes("'/v1/projects/clone'")
  },
  {
    name: 'Tauri inspects SSH hooks, setup scripts, and issue commands through Go relay files',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('inspectRuntimeRepoSetupScriptImports') &&
      text.includes('readRuntimeRepoHooksCheck') &&
      text.includes('readRuntimeRepoIssueCommand') &&
      text.includes('readRuntimeRepoTextFile(repoId, relativePath)') &&
      !text.includes('repo.kind === "folder" || repo.connectionId') &&
      !text.includes('if (repo.connectionId)')
  },
  {
    name: 'Tauri PTYs reconcile missed native exit events against Go runtime state',
    files: [
      'apps/desktop/src/tauri-runtime-pty-api.ts',
      'apps/desktop/src/tauri-runtime-pty-spawn.ts'
    ],
    expect: (text) =>
      text.includes('monitorRuntimePty(session.id)') &&
      text.includes('RUNTIME_PTY_HEALTH_POLL_MS') &&
      text.includes('reportRuntimePtyUnavailable') &&
      text.includes('isTerminalSessionFinished')
  },
  {
    name: 'Tauri runtime RPC maps terminal artifact grants to native temp-file commands',
    file: 'apps/desktop/src/tauri-file-runtime-rpc.ts',
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
    file: 'apps/desktop/src-tauri/src/commands/terminal_artifacts.rs',
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
    file: 'runtime/go/internal/runtimehttp/server.go',
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
    file: 'apps/desktop/src/tauri-git-runtime-rpc.ts',
    expect: (text) =>
      text.includes('export async function callTauriGitRuntimeRpc') &&
      text.includes("case 'github.repoSlug'") &&
      text.includes("case 'github.repoUpstream'") &&
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
      text.includes("case 'git.checkout'") &&
      text.includes("case 'git.localBranches'") &&
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
      text.includes('/v1/source-control/local-branches') &&
      text.includes('/v1/source-control/checkout') &&
      text.includes('/v1/source-control/check-ignored') &&
      text.includes('/v1/source-control/submodule-status') &&
      text.includes('/v1/source-control/remote-file-url') &&
      text.includes('/v1/source-control/remote-commit-url') &&
      text.includes('/v1/source-control/repository-identity') &&
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
    name: 'Renderer enables source-control text generation for the native Tauri host',
    file: 'packages/product-core/renderer/src/components/right-sidebar/source-control-text-generation-availability.ts',
    expect: (text) =>
      text.includes('export function getSourceControlTextGenerationUnavailableReason') &&
      text.includes('Tauri now provides a native local text-generation host') &&
      text.includes('return null')
  },
  {
    name: 'Source Control threads native text-generation availability into commit and review flows',
    file: 'packages/product-core/renderer/src/components/right-sidebar/SourceControl.tsx',
    expect: (text) =>
      text.includes(
        "import { getSourceControlTextGenerationUnavailableReason } from './source-control-text-generation-availability'"
      ) &&
      /const\s+sourceControlTextGenerationUnavailableReason\s*=\s*getSourceControlTextGenerationUnavailableReason\(\)/.test(
        text
      ) &&
      text.includes('generateUnavailableReason={sourceControlTextGenerationUnavailableReason}') &&
      text.includes(
        'textGenerationUnavailableReason: sourceControlTextGenerationUnavailableReason'
      ) &&
      text.includes('if (sourceControlTextGenerationUnavailableReason)')
  },
  {
    name: 'Checks panel threads native hosted-review text-generation availability',
    file: 'packages/product-core/renderer/src/components/right-sidebar/ChecksPanel.tsx',
    expect: (text) =>
      text.includes(
        "import { getSourceControlTextGenerationUnavailableReason } from './source-control-text-generation-availability'"
      ) &&
      /const\s+sourceControlTextGenerationUnavailableReason\s*=\s*getSourceControlTextGenerationUnavailableReason\(\)/.test(
        text
      ) &&
      text.includes('textGenerationUnavailableReason: sourceControlTextGenerationUnavailableReason')
  },
  {
    name: 'Tauri preload installs the native source-control text-generation API',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes('createPebbleGitTextGenerationApi') &&
      text.includes('api.git = createPebbleGitTextGenerationApi(createTauriGitRuntimeApi(api.git))')
  },
  {
    name: 'Tauri source-control text generation uses native context and bounded agent execution',
    file: 'apps/desktop/src/tauri-source-control-text-generation.ts',
    expect: (text) =>
      text.includes('createPebbleGitTextGenerationApi') &&
      text.includes('generateTauriCommitMessage') &&
      text.includes('generateTauriPullRequestFields') &&
      text.includes('source_control_text_generation_commit_context') &&
      text.includes('source_control_text_generation_pull_request_context') &&
      text.includes('GENERATION_TIMEOUT_MS = 60_000') &&
      text.includes('fetchSshCommitContext') &&
      text.includes('fetchSshPullRequestContext') &&
      text.includes('/v1/providers/text-generation/execute') &&
      text.includes('/v1/providers/text-generation/cancel') &&
      text.includes('requestRuntimeJson')
  },
  {
    name: 'Tauri runtime RPC reuses native source-control text generation for CLI and mobile',
    file: 'apps/desktop/src/tauri-git-runtime-rpc.ts',
    expect: (text) =>
      text.includes('generateTauriCommitMessage(readCommitGenerationParams(params))') &&
      text.includes('generateTauriPullRequestFields(readPullRequestGenerationParams(params))') &&
      text.includes('discoverTauriCommitMessageModels(readModelDiscoveryParams(params))') &&
      text.includes("cancelTauriGeneration('commit-message'") &&
      !text.includes('not yet wired through the Tauri SSH relay')
  },
  {
    name: 'Tauri native source-control text-generation commands are registered',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('SourceControlTextGenerationState::default()') &&
      text.includes('source_control_text_generation_cancel') &&
      text.includes('source_control_text_generation_commit_context') &&
      text.includes('source_control_text_generation_execute_plan') &&
      text.includes('source_control_text_generation_pull_request_context')
  },
  {
    name: 'Tauri source-control text-generation tests cover commit and pull-request generation',
    file: 'apps/desktop/src/tauri-source-control-text-generation.test.ts',
    expect: (text) =>
      text.includes('generates a commit message through the native Tauri text-generation host') &&
      text.includes('generates pull request fields from native branch context') &&
      text.includes('/v1/providers/text-generation/execute') &&
      text.includes('generates a commit message through the SSH relay context')
  },
  {
    name: 'Hosted-review creation hook accepts text-generation unavailable reason',
    file: 'packages/product-core/renderer/src/components/right-sidebar/useCreatePullRequestDialogFields.ts',
    expect: (text) =>
      text.includes('textGenerationUnavailableReason?: string | null') &&
      text.includes('textGenerationUnavailableReason,') &&
      text.includes('generateDisabledReason = textGenerationUnavailableReason')
  },
  {
    name: 'Go runtime preserves staged and unstaged git status areas for Tauri',
    file: 'runtime/go/internal/runtimecore/source_control_projection.go',
    expect: (text) =>
      text.includes('Area      string `json:"area,omitempty"`') &&
      text.includes('OldPath   string `json:"oldPath,omitempty"`') &&
      text.includes(
        'func parseGitChangeLine(line string, worktreePath string) []SourceControlChange'
      ) &&
      text.includes('sourceControlChangeForGitStatus(path, oldPath, status, "staged")') &&
      text.includes('sourceControlChangeForGitStatus(path, oldPath, status, "unstaged")') &&
      text.includes('Area: "untracked"') &&
      text.includes('func normalizeSourceControlChangeArea(area string, status string) string') &&
      text.includes('case "staged", "index"') &&
      text.includes('case "unstaged", "working", "worktree"')
  },
  {
    name: 'Go runtime exposes content-level git file diff for Tauri Source Control',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/source-control/file-diff"') &&
      text.includes('"/v1/source-control/ref-file-diff"') &&
      text.includes('"/v1/source-control/mutate"') &&
      text.includes('"/v1/source-control/local-branches"') &&
      text.includes('"/v1/source-control/checkout"') &&
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
      text.includes('handleGitLocalBranches') &&
      text.includes('handleGitCheckout') &&
      text.includes('handleGitCheckIgnored') &&
      text.includes('handleGitSubmoduleStatus') &&
      text.includes('handleGitRemoteFileURL') &&
      text.includes('handleGitRemoteCommitURL') &&
      text.includes('handleGitRepositoryIdentity') &&
      text.includes('handleGitForkSync') &&
      text.includes('handleGitBaseStatus') &&
      text.includes('handleGitBranchCompare') &&
      text.includes('handleGitCommitCompare') &&
      text.includes('handleGitHistory')
  },
  {
    name: 'Tauri owns the Source Control huge-folder ignore recovery flow',
    file: 'apps/desktop/src/tauri-source-control-text-generation.ts',
    expect: (text) =>
      text.includes('findHugeFoldersToIgnore') &&
      text.includes('findTauriHugeFoldersToIgnore') &&
      text.includes('appendGitignore') &&
      text.includes('appendTauriHugeFolderToGitignore')
  },
  {
    name: 'Go runtime validates and persists huge-folder gitignore suggestions',
    file: 'runtime/go/internal/runtimecore/manager.go',
    expect: (text) =>
      text.includes('func (m *Manager) GitFindHugeFoldersToIgnore') &&
      text.includes('func (m *Manager) GitAppendHugeFolderToIgnore') &&
      text.includes('refusing to write a symlinked .gitignore') &&
      text.includes('exitErr.ExitCode() == 1')
  },
  {
    name: 'Go HTTP runtime exposes huge-folder ignore endpoints',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/source-control/huge-folders"') &&
      text.includes('"/v1/source-control/append-gitignore"') &&
      text.includes('handleGitHugeFolders') &&
      text.includes('handleGitAppendGitignore')
  },
  {
    name: 'Go runtime exposes host terminal capability probes for Tauri runtime calls',
    file: 'runtime/go/internal/runtimehttp/host_routes.go',
    expect: (text) =>
      text.includes('handleHostTerminalCapabilities') &&
      text.includes('hostprobe.NewProber().Detect()') &&
      text.includes('http.MethodGet')
  },
  {
    name: 'Go runtime persists created base SHA and computes worktree base status',
    file: 'runtime/go/internal/runtimecore/manager.go',
    expect: (text) =>
      text.includes('CreatedBaseSHA') &&
      text.includes('resolveGitCommitQuiet(ctx, project.Path, req.Base)') &&
      text.includes('func (m *Manager) GitBaseStatus') &&
      text.includes('parseRemoteTrackingBaseRef') &&
      text.includes(
        'fetchGit(ctx, base, GitMutationRequest{RemoteName: remote, BranchName: branch})'
      ) &&
      text.includes('merge-base') &&
      text.includes('rev-list') &&
      text.includes('checkGitRemoteBranchConflict') &&
      text.includes('resolveGitPublishRemote')
  },
  {
    name: 'Go runtime sessions persist pane identity for Tauri agent-status snapshots',
    file: 'runtime/go/internal/runtimecore/domain.go',
    expect: (text) =>
      /TabID\s+string\s+`json:"tabId,omitempty"`/.test(text) &&
      /LeafID\s+string\s+`json:"leafId,omitempty"`/.test(text) &&
      /LaunchToken\s+string\s+`json:"launchToken,omitempty"`/.test(text) &&
      /Prompt\s+string\s+`json:"prompt,omitempty"`/.test(text)
  },
  {
    name: 'Tauri updater API uses the native updater plugin instead of a download no-op',
    file: 'apps/desktop/src/tauri-updater-api.ts',
    expect: (text) =>
      text.includes('export function installTauriUpdaterApi') &&
      text.includes("from '@tauri-apps/plugin-updater'") &&
      text.includes("from '@tauri-apps/plugin-process'") &&
      text.includes("from '../../../packages/product-core/shared/updater-changelog-selection'") &&
      text.includes('getVersion: readCurrentAppVersion') &&
      text.includes("state: 'checking'") &&
      text.includes('resolvePebbleRelease(currentVersion, options)') &&
      text.includes('checkDefaultTauriUpdate()') &&
      text.includes('checkTaggedTauriUpdate(result.tag)') &&
      text.includes("invoke<unknown>('updater_fetch_changelog_entries'") &&
      text.includes('selectChangelogData(json, incomingVersion, currentVersion)') &&
      text.includes("state: 'available'") &&
      text.includes('https://github.com/nebutra/pebble/releases/tag/v') &&
      text.includes('await update.download(') &&
      text.includes("invoke<string>('app_linux_install_kind')") &&
      text.includes("installKind !== 'appimage'") &&
      text.includes('createTauriUpdateDownloadProgressHandler(version') &&
      text.includes('await update.install()') &&
      text.includes('await relaunch()') &&
      text.includes('PEBBLE_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT') &&
      text.includes('updaterStatusListeners') &&
      !text.includes('Automatic Tauri update download is not wired yet') &&
      !text.includes('Automatic Tauri update install is not wired yet')
  },
  {
    name: 'Tauri updater resolves stable and tagged signed manifests through native resources',
    file: 'apps/desktop/src/tauri-updater-release-check.ts',
    expect: (text) =>
      text.includes('check as checkTauriUpdate, Update') &&
      text.includes('export async function checkDefaultTauriUpdate') &&
      text.includes('export async function checkTaggedTauriUpdate') &&
      text.includes("'updater_check_release_tag'") &&
      text.includes('return metadata ? new Update(metadata) : null') &&
      text.includes('export function requiresTaggedReleaseCheck')
  },
  {
    name: 'Tauri updater tests cover Nebutra changelog attachment',
    file: 'apps/desktop/src/tauri-updater-api.test.ts',
    expect: (text) =>
      text.includes('attaches Nebutra changelog data to available release statuses') &&
      text.includes('falls back to the Nebutra release feed when the signed updater check fails') &&
      text.includes('reports an error when both signed updater and release feed checks fail') &&
      text.includes('prefers a signed native package without consulting the release fallback') &&
      text.includes('uses a tag-scoped signed manifest for explicit prerelease checks') &&
      text.includes("'updater_fetch_changelog_entries'") &&
      text.includes('https://www.nebutra.com/pebble/media/release-popup.gif') &&
      text.includes('https://github.com/nebutra/pebble/releases/tag/v1.4.128')
  },
  {
    name: 'Tauri updater operations prevent check, download, and relaunch races',
    file: 'apps/desktop/src/tauri-updater-operation-state.ts',
    expect: (text) =>
      text.includes('export class TauriUpdaterOperationState') &&
      text.includes('startCheck(operation:') &&
      text.includes('startDownload(operation:') &&
      text.includes('await this.checkPromise') &&
      text.includes('startRelaunch(operation:') &&
      text.includes('this.relaunchPromise = null')
  },
  {
    name: 'Tauri updater channel tests keep RC and perf checks on tag-scoped manifests',
    file: 'apps/desktop/src/tauri-updater-release-check.test.ts',
    expect: (text) =>
      text.includes('explicit RC and perf channels') &&
      text.includes('keeps prerelease installations on their tagged channel') &&
      text.includes('prereleases are explicitly disabled')
  },
  {
    name: 'Tauri updater tests cover duplicate operations and relaunch recovery',
    file: 'apps/desktop/src/tauri-updater-api.test.ts',
    expect: (text) =>
      text.includes('joins duplicate checks instead of starting competing updater resources') &&
      text.includes('ignores duplicate download requests') &&
      text.includes('does not replace download progress with a concurrent manual check') &&
      text.includes('latches a successful relaunch') &&
      text.includes('allows relaunch retry after the native process plugin rejects')
  },
  {
    name: 'Shared updater changelog selection canonicalizes Nebutra release links',
    file: 'packages/product-core/shared/updater-changelog-selection.ts',
    expect: (text) =>
      text.includes('export function selectChangelogData') &&
      text.includes("'www.nebutra.com'") &&
      text.includes('https://github.com/nebutra/pebble/releases/tag/') &&
      text.includes('releaseNotesUrl: CHANGELOG_URL') &&
      text.includes('function canonicalReleaseNotesUrl') &&
      text.includes('export function compareReleaseVersions')
  },
  {
    name: 'Tauri updater and process plugins are registered in the native shell',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('.plugin(tauri_plugin_process::init())') &&
      text.includes('.plugin(tauri_plugin_updater::Builder::new().build())')
  },
  {
    name: 'Tauri force reload clears native WebView data before reloading',
    file: 'apps/desktop/src-tauri/src/commands/webview_reload.rs',
    expect: (text) =>
      text.includes('clear_all_browsing_data') &&
      text.includes('window.location.reload()') &&
      text.includes('ignore_cache') &&
      text.includes('webview_toggle_devtools') &&
      text.includes('window.is_devtools_open()') &&
      text.includes('window.open_devtools()') &&
      text.includes('window.close_devtools()')
  },
  {
    name: 'Tauri force reload routes through the shared native command',
    file: 'apps/desktop/src/tauri-webview-reload.ts',
    expect: (text) =>
      text.includes("invoke('webview_reload', { ignoreCache })") &&
      text.includes("invoke<boolean>('webview_toggle_devtools')") &&
      !text.includes("Tauri JS does not expose Electron's reloadIgnoringCache")
  },
  {
    name: 'Tauri menu and shortcut bridge share native force reload',
    file: 'apps/desktop/src/tauri-window-shortcut-bridge.ts',
    expect: (text) =>
      text.includes('reloadTauriWebview(true)') &&
      !text.includes("case 'forceReload':\n      window.location.reload()")
  },
  {
    name: 'Tauri updater plugin has a non-null Pebble release configuration',
    file: 'apps/desktop/src-tauri/tauri.conf.json',
    expect: (text) =>
      text.includes('"updater"') &&
      text.includes('https://github.com/nebutra/pebble/releases/latest/download/latest.json') &&
      text.includes('"pubkey"') &&
      !text.includes('"updater": null')
  },
  {
    name: 'Tauri updater dependencies are declared on both Rust and renderer sides',
    file: 'apps/desktop/package.json',
    expect: (text) =>
      text.includes('"@tauri-apps/plugin-updater"') && text.includes('"@tauri-apps/plugin-process"')
  },
  {
    name: 'Tauri updater Rust crates are declared for native install/relaunch support',
    file: 'apps/desktop/src-tauri/Cargo.toml',
    expect: (text) =>
      text.includes('tauri-plugin-updater = "2"') && text.includes('tauri-plugin-process = "2"')
  },
  {
    name: 'Tauri shell API bridges native path/url/file-picker calls',
    file: 'apps/desktop/src/tauri-shell-api.ts',
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
    file: 'apps/desktop/src-tauri/src/commands/shell.rs',
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
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::shell::shell_open_in_file_manager') &&
      text.includes('commands::shell::shell_open_in_external_editor') &&
      text.includes('commands::shell::shell_pick_file') &&
      text.includes('commands::shell::shell_pick_repo_icon_image') &&
      text.includes('commands::shell::shell_copy_file')
  },
  {
    name: 'Tauri runtime environment commands persist pairing-backed servers',
    file: 'apps/desktop/src-tauri/src/commands/runtime_environments.rs',
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
    file: 'apps/desktop/src-tauri/src/commands/remote_runtime_rpc.rs',
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
    file: 'apps/desktop/src-tauri/src/main.rs',
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
    name: 'Tauri registers Pebble deep links as a native desktop protocol',
    files: [
      'apps/desktop/src-tauri/src/main.rs',
      'apps/desktop/src-tauri/src/primary_window.rs'
    ],
    expect: (text) =>
      text.includes('.plugin(tauri_plugin_deep_link::init())') &&
      text.includes('tauri_plugin_single_instance::init') &&
      text.includes('window.unminimize()') &&
      text.includes('commands::deep_link::deep_link_initial_urls') &&
      text.includes('tauri::RunEvent::Opened { urls }') &&
      text.includes('commands::deep_link::emit_deep_links(')
  },
  {
    name: 'Tauri bundle declares the Pebble deep-link scheme',
    file: 'apps/desktop/src-tauri/tauri.conf.json',
    expect: (text) => text.includes('"deep-link"') && text.includes('"schemes": ["pebble"]')
  },
  {
    name: 'Tauri renderer deep links create runtime environments from pairing URLs',
    file: 'apps/desktop/src/tauri-deep-link-api.ts',
    expect: (text) =>
      text.includes("invoke<string[]>('deep_link_initial_urls')") &&
      text.includes('listen<string>(DEEP_LINK_EVENT') &&
      text.includes("const DEEP_LINK_EVENT = 'pebble:deep-link'") &&
      text.includes('parseDeepLinkAction') &&
      text.includes("case 'pair':") &&
      text.includes('window.api.runtimeEnvironments.addFromPairingCode') &&
      text.includes('state.refreshRuntimeEnvironmentStatus(result.environment.id)') &&
      text.includes('createUniqueRuntimeName')
  },
  {
    name: 'Tauri deep-link tests cover startup, runtime, settings, and rejection paths',
    file: 'apps/desktop/src/tauri-deep-link-api.test.ts',
    expect: (text) =>
      text.includes('imports startup pairing URLs into runtime environments') &&
      text.includes('handles runtime deep-link events without going through the web no-op path') &&
      text.includes('pebble://settings/voice?section=local-models') &&
      text.includes('pebble://settings/not-a-pane') &&
      text.includes('expect(openSettingsTarget).toHaveBeenCalledWith') &&
      text.includes("expect(deepLinkMocks.listen).toHaveBeenCalledWith('pebble:deep-link'")
  },
  {
    name: 'Tauri CLI registration bridges renderer actions to native commands',
    file: 'apps/desktop/src/tauri-cli-api.ts',
    expect: (text) =>
      text.includes("import { invoke } from '@tauri-apps/api/core'") &&
      text.includes("callCli('cli_install_status')") &&
      text.includes("callCli('cli_install')") &&
      text.includes("callCli('cli_remove')") &&
      text.includes("callWslCli('cli_wsl_install_status', args)") &&
      text.includes("installWsl: (args) => callWslCli('cli_wsl_install', args)") &&
      text.includes("removeWsl: (args) => callWslCli('cli_wsl_remove', args)") &&
      text.includes('hasTauriInternals()') &&
      text.includes('webUnsupportedStatus()') &&
      !text.includes('.catch(() => webUnsupportedStatus())')
  },
  {
    name: 'Tauri native CLI registration owns Unix symlink install/remove',
    file: 'apps/desktop/src-tauri/src/commands/cli_registration.rs',
    expect: (text) =>
      text.includes('#[tauri::command]') &&
      text.includes('pub async fn cli_install_status()') &&
      text.includes('pub async fn cli_install()') &&
      text.includes('pub async fn cli_remove()') &&
      text.includes('pub async fn cli_wsl_install_status(input: WslCliInput)') &&
      text.includes('pub async fn cli_wsl_install(input: WslCliInput)') &&
      text.includes('pub async fn cli_wsl_remove(input: WslCliInput)') &&
      text.includes('unix_fs::symlink(&launcher, &command_path)') &&
      text.includes('fs::remove_file(&command_path)') &&
      text.includes('mod cli_registration_windows') &&
      text.includes('PEBBLE_CLI_INSTALL_DIR') &&
      text.includes('foreign_file_is_a_conflict_and_never_replaced')
  },
  {
    name: 'Tauri CLI commands are registered with the Rust invoke handler',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::cli_registration::cli_install_status') &&
      text.includes('commands::cli_registration::cli_install') &&
      text.includes('commands::cli_registration::cli_remove') &&
      text.includes('commands::cli_registration::cli_wsl_install_status') &&
      text.includes('commands::cli_registration::cli_wsl_install') &&
      text.includes('commands::cli_registration::cli_wsl_remove')
  },
  {
    name: 'Tauri CLI API tests prove native command routing',
    file: 'apps/desktop/src/tauri-cli-api.test.ts',
    expect: (text) =>
      text.includes('routes CLI status, install, and remove through native Tauri commands') &&
      text.includes('does not report native success when the Tauri command bridge is absent') &&
      text.includes('preserves native bridge failures instead of misreporting platform support') &&
      text.includes('routes WSL registration through native commands with the selected distro') &&
      text.includes("'cli_install_status'") &&
      text.includes("'cli_install'") &&
      text.includes("'cli_remove'") &&
      text.includes("'cli_wsl_install_status'") &&
      text.includes("'cli_wsl_install'") &&
      text.includes("'cli_wsl_remove'")
  },
  {
    name: 'Tauri browser API bridges runtime profiles, downloads, and explicit unsupported guest ops',
    file: 'apps/desktop/src/tauri-browser-runtime-api.ts',
    expect: (text) =>
      text.includes('export function installTauriBrowserRuntimeApi') &&
      text.includes('registerTauriBrowserGuest(args)') &&
      text.includes('sessionListProfiles: listTauriBrowserSessionProfiles') &&
      text.includes('sessionCreateProfile: createTauriBrowserSessionProfile') &&
      text.includes('sessionDeleteProfile: deleteTauriBrowserSessionProfile') &&
      text.includes('sessionDetectBrowsers: detectTauriBrowserSessionBrowsers') &&
      text.includes('cancelDownload: cancelTauriBrowserDownload') &&
      text.includes('openTauriBrowserPageDevTools(browserPageId)') &&
      text.includes('sessionClearDefaultCookies: clearTauriBrowserDefaultCookies') &&
      text.includes('setViewportOverride: async ({ browserPageId, override })') &&
      text.includes('setTauriBrowserViewportOverride({ browserPageId, override })') &&
      text.includes('setAnnotationViewportBridge: setTauriBrowserAnnotationViewportBridge') &&
      text.includes('setGrabMode: setTauriBrowserGrabMode') &&
      text.includes('awaitGrabSelection: awaitTauriBrowserGrabSelection') &&
      text.includes('cancelGrab: cancelTauriBrowserGrab') &&
      text.includes('captureSelectionScreenshot: captureTauriBrowserSelectionScreenshot') &&
      text.includes('extractHoverPayload: extractTauriBrowserHoverPayload') &&
      text.includes('TAURI_BROWSER_GUEST_UNAVAILABLE') &&
      text.includes('installTauriBrowserActionExecutorBridge()') &&
      text.includes('ensureTauriBrowserRuntimeEventPump()') &&
      text.includes('ensureTauriBrowserProviderRefresh()') &&
      text.includes('ensureTauriBrowserActionConsumer()')
  },
  {
    name: 'Renderer browser feature availability enables native Tauri grab, annotation, and find',
    file: 'packages/product-core/renderer/src/components/browser-pane/browser-guest-feature-availability.ts',
    expect: (text) =>
      text.includes('export function getBrowserGuestFeatureAvailability') &&
      text.includes("'__TAURI_INTERNALS__' in window") &&
      text.includes('canGrabElement: true') &&
      text.includes('canAnnotateElement: true') &&
      text.includes('canFindInPage: true') &&
      text.includes('elementGrabUnavailableReason: null') &&
      text.includes('annotationUnavailableReason: null') &&
      text.includes('findInPageUnavailableReason: null') &&
      text.includes('canImportCookies: true') &&
      text.includes('cookieImportUnavailableReason: null')
  },
  {
    name: 'Tauri reconciles Claude-compatible managed hooks through the native host',
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks.rs',
    expect: (text) =>
      text.includes('pub fn agent_hooks_apply_claude_compatible') &&
      text.includes('install_claude_compatible') &&
      text.includes('remove_claude_compatible') &&
      text.includes('write_json_atomically') &&
      text.includes('Settings are written last') &&
      text.includes('remove_managed_definitions') &&
      text.includes('fs::Permissions::from_mode(0o700)')
  },
  {
    name: 'Tauri agent hook API routes every managed agent to native status inspection',
    file: 'apps/desktop/src/tauri-agent-hooks-api.ts',
    expect: (text) =>
      [
        'claude',
        'openclaude',
        'codex',
        'gemini',
        'antigravity',
        'amp',
        'cursor',
        'droid',
        'command_code',
        'grok',
        'copilot',
        'hermes',
        'devin',
        'kimi'
      ].every((agent) => text.includes(`agent_hooks_${agent}_status`)) &&
      text.includes('inspectionFailureStatus') &&
      text.includes('Could not inspect') &&
      !text.includes('not yet implemented in the Tauri desktop shell')
  },
  {
    name: 'Tauri agent hook reconciliation owns every managed native lifecycle',
    file: 'apps/desktop/src/tauri-agent-hooks-api.ts',
    expect: (text) =>
      [
        'claude_compatible',
        'gemini',
        'cursor',
        'droid',
        'command_code',
        'grok',
        'devin',
        'kimi',
        'amp',
        'copilot',
        'antigravity',
        'hermes',
        'codex'
      ].every((agent) => text.includes(`agent_hooks_apply_${agent}`))
  },
  {
    name: 'Tauri reconciles Gemini hooks with source-specific native semantics',
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks_gemini.rs',
    expect: (text) =>
      text.includes('const GEMINI_EVENTS: &[&str]') &&
      text.includes('"BeforeAgent", "AfterAgent", "AfterTool", "BeforeTool"') &&
      text.includes('printf \\"{}\\\\n\\"') &&
      text.includes('"timeout":10000') &&
      text.includes('remove_managed') &&
      text.includes('write_json_atomically') &&
      text.includes('fs::Permissions::from_mode(0o700)')
  },
  {
    name: 'Tauri reconciles Cursor hooks with its documented top-level command schema',
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks_cursor.rs',
    expect: (text) =>
      text.includes('"beforeSubmitPrompt"') &&
      text.includes('"afterAgentResponse"') &&
      text.includes('object.entry("version").or_insert(serde_json::json!(1))') &&
      text.includes('{"command": command, "timeout": 10}') &&
      text.includes('definition_references_managed_script') &&
      text.includes('remove_managed') &&
      text.includes('write_json_atomically') &&
      text.includes('fs::Permissions::from_mode(0o700)')
  },
  {
    name: 'Tauri reconciles Droid hooks with Factory events and disabled-state semantics',
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks_droid.rs',
    expect: (text) =>
      text.includes('("SessionStart", false)') &&
      text.includes('("PermissionRequest", true)') &&
      text.includes('("Notification", false)') &&
      text.includes('get("hooksDisabled")') &&
      text.includes('Droid hooks are disabled in Factory settings') &&
      text.includes('"timeout": 10') &&
      text.includes('remove_managed') &&
      text.includes('write_json_atomically')
  },
  {
    name: 'Tauri reconciles Command Code hooks with sanitized-environment recovery',
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks_command_code.rs',
    expect: (text) =>
      text.includes('(\"PreToolUse\", true)') &&
      text.includes('(\"PostToolUse\", true)') &&
      text.includes('(\"Stop\", false)') &&
      text.includes('__pebble_read_ancestor_var') &&
      text.includes('__pebble_fill_from_endpoint_file') &&
      text.includes('!= \"$PEBBLE_AGENT_HOOK_PORT\"') &&
      text.includes('sourceEndpointByPort') &&
      text.includes('write_json_atomically')
  },
  {
    name: 'Tauri reconciles Grok hooks through its dedicated global hook file',
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks_grok.rs',
    expect: (text) =>
      text.includes('join("pebble-status.json")') &&
      text.includes('(\"SessionStart\", false)') &&
      text.includes('(\"PostToolUseFailure\", true)') &&
      text.includes('(\"Notification\", false)') &&
      text.includes('"timeout": 10') &&
      text.includes('remove_managed') &&
      text.includes('write_json_atomically')
  },
  {
    name: 'Tauri reconciles Devin JSONC hooks and reports Claude import overlap',
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks_devin.rs',
    expect: (text) =>
      text.includes('json5::from_str::<serde_json::Value>') &&
      text.includes('join("devin").join("config.json")') &&
      text.includes('"PostCompaction"') &&
      text.includes('"PermissionRequest"') &&
      text.includes('read_config_from.claude is enabled') &&
      text.includes('cmd /d /s /c') &&
      text.includes('write_json_atomically')
  },
  {
    name: 'Tauri reconciles Kimi hooks without rewriting user TOML',
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks_kimi.rs',
    expect: (text) =>
      text.includes('pebble-managed-kimi-hooks') &&
      text.includes('"StopFailure"') &&
      text.includes('strip_managed') &&
      text.includes('managed_block') &&
      text.includes('join("kimi-hook.sh")') &&
      text.includes('path.with_extension("toml.bak")') &&
      text.includes('write_text_atomically')
  },
  {
    name: 'Tauri owns the complete bounded Amp status plugin lifecycle',
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks_amp.rs',
    expect: (text) =>
      text.includes('Managed by Pebble. Do not edit') &&
      text.includes("amp.on('session.start'") &&
      text.includes("amp.on('tool.call'") &&
      text.includes("amp.on('agent.end'") &&
      text.includes('MAX_PENDING_POSTS = 50') &&
      text.includes('PEBBLE_AGENT_HOOK_ENDPOINT') &&
      text.includes('Amp Pebble status plugin exists but is not Pebble-managed') &&
      text.includes('is_some_and(|text| !managed(text))')
  },
  {
    name: "Tauri owns Copilot's complete local managed hook lifecycle",
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks_copilot.rs',
    expect: (text) =>
      text.includes('"SessionStart"') &&
      text.includes('"PermissionRequest"') &&
      text.includes('"Notification"') &&
      text.includes('COPILOT_HOME') &&
      text.includes('remove_managed') &&
      text.includes('write_script(&path)?') &&
      text.includes('write_atomic(&config_path') &&
      text.includes('Managed Copilot hook file contains stale entries')
  },
  {
    name: "Tauri owns Antigravity's mixed-schema local hook bundle",
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks_antigravity.rs',
    expect: (text) =>
      text.includes('const BUNDLE: &str = "pebble-status"') &&
      text.includes('name: "PreInvocation"') &&
      text.includes('name: "PostToolUse"') &&
      text.includes('"matcher": "*"') &&
      text.includes('PEBBLE_ANTIGRAVITY_EVENT') &&
      text.includes('antigravity-post-tool-use.cmd') &&
      text.includes('.replace(\'\\n\', "\\r\\n")') &&
      text.includes('write_script(&core, &core_source)?') &&
      !text.includes('sweep_legacy_bundle') &&
      !text.toLowerCase().includes('orca') &&
      text.includes('remove_managed')
  },
  {
    name: 'Tauri owns Hermes YAML enablement and managed Python plugin lifecycle',
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks_hermes.rs',
    expect: (text) =>
      text.includes('const PLUGIN: &str = "pebble-status"') &&
      text.includes('include_str!("agent_hooks_hermes_plugin.py")') &&
      text.includes('write_plugin()?') &&
      text.includes('format!("{}.bak", path.display())') &&
      text.includes('present && managed') &&
      text.includes('fs::remove_dir_all') &&
      text.includes('config must never enable a plugin')
  },
  {
    name: 'Hermes native plugin preserves all events and bounded payload normalization',
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks_hermes_plugin.py',
    expect: (text) =>
      text.includes('on_session_finalize') &&
      text.includes('post_approval_response') &&
      text.includes('MAX_JSONABLE_DEPTH = 5') &&
      text.includes('MAX_JSONABLE_NODES = 500') &&
      text.includes('MAX_JSONABLE_STRING = 8192') &&
      text.includes('timeout=0.75') &&
      text.includes('/hook/hermes') &&
      text.includes('ctx.register_hook')
  },
  {
    name: 'Tauri owns Codex managed home hooks resources and trust lifecycle',
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks_codex.rs',
    expect: (text) =>
      text.includes('codex-runtime-home/home') &&
      text.includes('("PermissionRequest", "permission_request")') &&
      text.includes('Sha256::digest') &&
      text.includes('EncodedCommand') &&
      text.includes('sync_system_resources()?') &&
      text.includes('system_user_hooks') &&
      text.includes('mirrored_user_trust') &&
      text.includes('group,') &&
      text.includes('entry.enabled') &&
      text.includes('remove_managed_trust') &&
      text.includes('write_atomic(&toml_path')
  },
  {
    name: 'Tauri has no unsupported managed-agent status placeholder',
    file: 'apps/desktop/src-tauri/src/commands/agent_hooks.rs',
    expect: (text) =>
      !text.includes('unsupported_status') &&
      !text.includes('Agent hook status for this agent is not yet implemented')
  },
  {
    name: 'Go runtime owns a bounded purpose-scoped SSH agent-hook bootstrap transport',
    file: 'runtime/go/internal/runtimecore/ssh_agent_hook_bootstrap.go',
    expect: (text) =>
      text.includes('BootstrapSshAgentHooks') &&
      text.includes('pebble-agent-hooks-v1') &&
      text.includes('maxAgentHookBootstrapBytes') &&
      text.includes('maxAgentHookBootstrapOutput') &&
      text.includes('sshAgentHookBootstrapTimeout') &&
      text.includes('configureSshAskpass') &&
      text.includes('PEBBLE_SSH_ASKPASS_SECRET') &&
      !text.includes('action == "remote-command"')
  },
  {
    name: 'Go runtime deploys a matching relay worker before SSH hook bootstrap',
    file: 'runtime/go/internal/runtimecore/ssh_relay_worker_deploy.go',
    expect: (text) =>
      text.includes('"uname -s && uname -m"') &&
      text.includes('windowsRelayPlatformProbeCommand') &&
      text.includes('"CGO_ENABLED=0"') &&
      text.includes('"GOOS="+goos') &&
      text.includes('"GOARCH="+goarch') &&
      text.includes('.pebble-relay-worker.tmp') &&
      text.includes('chmod 700') &&
      text.includes('mv ') &&
      text.includes('PEBBLE_RELAY_WORKER_PATH') &&
      text.includes('PEBBLE_RELAY_WORKER_BUNDLE_DIR') &&
      text.includes('bundledRelayWorkerPath') &&
      text.includes('PEBBLE_GO_RUNTIME_SOURCE_DIR')
  },
  {
    name: 'Tauri has a versioned client for SSH agent-hook bootstrap',
    file: 'apps/desktop/src/tauri-ssh-agent-hook-bootstrap.ts',
    expect: (text) =>
      text.includes('agent-hooks/bootstrap') &&
      text.includes('body: { version: 1, script }') &&
      text.includes('timeoutMs: 50_000')
  },
  {
    name: 'Relay worker owns Claude-compatible remote hook mutation',
    file: 'runtime/go/internal/remotehooks/claude_compatible.go',
    expect: (text) =>
      text.includes('name: "claude"') &&
      text.includes('name: "openclaude"') &&
      text.includes('"PermissionRequest"') &&
      text.includes('removeManagedDefinitions') &&
      text.includes('writeAtomic(scriptPath') &&
      text.includes('writeAtomic(configPath') &&
      text.includes('0o700') &&
      text.includes('/hook/%s')
  },
  {
    name: 'Relay worker owns Gemini Cursor and Droid remote JSON schemas',
    file: 'runtime/go/internal/remotehooks/json_agents.go',
    expect: (text) =>
      text.includes('"BeforeAgent", "AfterAgent", "AfterTool", "BeforeTool"') &&
      text.includes('timeout: 10000') &&
      text.includes('stdoutJSON: true') &&
      text.includes('config["version"] = 1') &&
      text.includes('removeCursorManaged') &&
      text.includes('"PermissionRequest": "*"') &&
      text.includes('installDroid(home)') &&
      text.includes('installGrok(home)') &&
      text.includes('config: ".grok/hooks/pebble-status.json"') &&
      text.includes('"PostToolUseFailure": "*"') &&
      text.includes('writeAtomic(scriptPath') &&
      text.includes('writeJSONStatus')
  },
  {
    name: 'Relay worker owns the complete safe Amp remote plugin',
    file: 'runtime/go/internal/remotehooks/amp.go',
    expect: (text) =>
      text.includes('Managed by Pebble. Do not edit') &&
      text.includes('exists but is not Pebble-managed') &&
      text.includes('MAX_PENDING_POSTS=50') &&
      text.includes('AbortController') &&
      text.includes("amp.on('session.start'") &&
      text.includes("amp.on('tool.call'") &&
      text.includes("amp.on('agent.end'") &&
      text.includes('writeAtomic(path')
  },
  {
    name: 'Relay worker owns Antigravity and Copilot remote schemas',
    file: 'runtime/go/internal/remotehooks/antigravity_copilot.go',
    expect: (text) =>
      text.includes('config["pebble-status"] = bundle') &&
      text.includes('"PostToolUse", true') &&
      text.includes('"matcher": "*"') &&
      text.includes('PEBBLE_ANTIGRAVITY_EVENT') &&
      text.includes('config["version"] = 1') &&
      text.includes('delete(config, "disableAllHooks")') &&
      text.includes('PEBBLE_COPILOT_HOOK_EVENT') &&
      text.includes('"timeoutSec": 5')
  },
  {
    name: 'Relay worker owns Command Code remote hooks and sanitized environment recovery',
    file: 'runtime/go/internal/remotehooks/command_code.go',
    expect: (text) =>
      text.includes('filepath.Join(home, ".commandcode", "settings.json")') &&
      text.includes('{{"PreToolUse", true}, {"PostToolUse", true}, {"Stop", false}}') &&
      text.includes('/proc/$pid/environ') &&
      text.includes('pebble-dev/agent-hooks"/*/endpoint.env') &&
      text.includes('[ "$endpoint_port" = "$PEBBLE_AGENT_HOOK_PORT" ]') &&
      text.includes('/hook/command-code') &&
      text.includes('"payload@-"')
  },
  {
    name: 'Relay worker owns Hermes YAML and bounded Python plugin lifecycle',
    file: 'runtime/go/internal/remotehooks/hermes.go',
    expect: (text) =>
      text.includes('yaml.Unmarshal(content, &config)') &&
      text.includes('yaml.Marshal(config)') &&
      text.includes('Managed by Pebble. Do not edit') &&
      text.includes('MAX_JSONABLE_NODES=500') &&
      text.includes('/hook/hermes') &&
      text.includes('for event in EVENTS:ctx.register_hook')
  },
  {
    name: 'Relay worker owns Devin JSONC remote hook lifecycle',
    file: 'runtime/go/internal/remotehooks/devin.go',
    expect: (text) =>
      text.includes('hujson.Standardize(content)') &&
      text.includes('"PostCompaction"') &&
      text.includes('"PermissionRequest"') &&
      text.includes('removeManagedDefinitions(definitions, "devin-hook.sh")') &&
      text.includes('statusScript("devin", false)') &&
      !text.includes('definition["matcher"]')
  },
  {
    name: 'Relay worker owns convergent Kimi TOML hooks with rolling backup',
    file: 'runtime/go/internal/remotehooks/kimi.go',
    expect: (text) =>
      text.includes('pebble-managed-kimi-hooks') &&
      text.includes('removeKimiBlock(content)') &&
      text.includes('configPath+".bak"') &&
      text.includes('"PostToolUseFailure"') &&
      text.includes('statusScript("kimi", false)')
  },
  {
    name: 'Relay worker owns Codex remote hooks and canonical trust hashes',
    file: 'runtime/go/internal/remotehooks/codex.go',
    expect: (text) =>
      text.includes('"SessionStart", "session_start"') &&
      text.includes('"PermissionRequest", "permission_request"') &&
      text.includes('sha256.Sum256(serialized)') &&
      text.includes('[hooks.state.') &&
      text.includes('trusted_hash =') &&
      text.includes('Run /hooks in Codex on the remote host to approve.')
  },
  {
    name: 'Successful Tauri SSH connect best-effort installs remote managed hooks',
    file: 'apps/desktop/src/tauri-ssh-targets-api.ts',
    expect: (text) =>
      text.includes('installSshManagedAgentHooks') &&
      text.includes("state.status === 'connected'") &&
      text.includes('must not take the SSH workspace itself offline')
  },
  {
    name: 'Tauri settings changes reconcile managed agent hooks',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes('reconcileTauriManagedAgentHooks') &&
      /["']agentStatusHooksEnabled["'] in updates/.test(text) &&
      text.includes('settings.agentStatusHooksEnabled !== false')
  },
  {
    name: 'Renderer browser pane disables Tauri guest-hook controls before unsupported calls',
    file: 'packages/product-core/renderer/src/components/browser-pane/BrowserPane.tsx',
    expect: (text) =>
      text.includes(
        "import { getBrowserGuestFeatureAvailability } from './browser-guest-feature-availability'"
      ) &&
      text.includes('browserElementGrabDisabled') &&
      text.includes('browserAnnotationDisabled') &&
      text.includes('browserElementGrabUnavailableReason') &&
      text.includes('browserAnnotationUnavailableReason') &&
      text.includes('browserFindUnavailableReason') &&
      text.includes('disabled={browserElementGrabDisabled}') &&
      text.includes('disabled={browserAnnotationDisabled}') &&
      text.includes('setResourceNotice(browserElementGrabUnavailableReason)') &&
      text.includes('setResourceNotice(browserFindUnavailableReason)') &&
      text.includes('isOpen={findOpen && !browserFindUnavailableReason}')
  },
  {
    name: 'Renderer browser toolbar separates native file import from unavailable source-browser import',
    file: 'packages/product-core/renderer/src/components/browser-pane/BrowserToolbarMenu.tsx',
    expect: (text) =>
      text.includes(
        "import { getBrowserGuestFeatureAvailability } from './browser-guest-feature-availability'"
      ) &&
      text.includes('browserCookieImportUnavailableReason') &&
      text.includes('cookieFileImportUnavailableReason') &&
      text.includes('toast.message(browserCookieImportUnavailableReason)') &&
      text.includes('toast.message(cookieFileImportUnavailableReason)') &&
      text.includes('cookieImportUnavailableReason={browserCookieImportUnavailableReason}')
  },
  {
    name: 'Renderer browser import hint keeps native file import visible under Tauri',
    file: 'packages/product-core/renderer/src/components/browser-pane/BrowserImportHintButton.tsx',
    expect: (text) =>
      text.includes(
        "import { getBrowserGuestFeatureAvailability } from './browser-guest-feature-availability'"
      ) &&
      text.includes('browserCookieImportUnavailableReason') &&
      text.includes('cookieFileImportUnavailableReason') &&
      text.includes(
        '!browserCookieImportUnavailableReason || !cookieFileImportUnavailableReason'
      ) &&
      text.includes('toast.message(browserCookieImportUnavailableReason)')
  },
  {
    name: 'Renderer browser menu explains unavailable source import while enabling file import',
    file: 'packages/product-core/renderer/src/components/browser-pane/browser-toolbar-menu-dropdown.tsx',
    expect: (text) =>
      text.includes('cookieImportUnavailableReason: string | null') &&
      text.includes('cookieFileImportUnavailableReason: string | null') &&
      text.includes('open && !cookieImportUnavailableReason') &&
      text.includes('cookieImportUnavailableReason ?') &&
      text.includes('disabled={Boolean(cookieFileImportUnavailableReason)}') &&
      text.includes('max-w-64 whitespace-normal text-muted-foreground')
  },
  {
    name: 'Tauri browser action consumer exposes renderer Webview action executors',
    file: 'apps/desktop/src/tauri-browser-action-consumer.ts',
    expect: (text) =>
      text.includes('export function installTauriBrowserActionExecutorBridge') &&
      text.includes('window.__pebbleTauriBrowserActionExecutors') &&
      text.includes('register: registerTauriBrowserActionExecutor') &&
      text.includes('browserActionExecutors.get(resolveBrowserActionTabId(action))') &&
      text.includes('shouldMarkRuntimeBrowserTabErrored(action)') &&
      text.includes("case 'screenshot':") &&
      text.includes("status: 'completed'") &&
      text.includes("status: 'failed'")
  },
  {
    name: 'Renderer browser mounting uses Tauri child Webviews under the Tauri shell',
    file: 'packages/product-core/renderer/src/components/browser-pane/browser-page-webview.ts',
    expect: (text) =>
      text.includes('ensureTauriBrowserPageWebview') &&
      text.includes('isTauriBrowserHost()') &&
      text.includes('__pebbleSetNativeBrowserInputLocked') &&
      text.includes("document.createElement('webview')")
  },
  {
    name: 'Tauri browser pane adapter creates native child Webviews instead of Electron webview tags',
    file: 'packages/product-core/renderer/src/components/browser-pane/tauri-browser-page-webview.ts',
    expect: (text) =>
      text.includes(
        "import type { Webview as NativeTauriBrowserWebview } from '@tauri-apps/api/webview'"
      ) &&
      text.includes('export function ensureTauriBrowserPageWebview') &&
      text.includes('export async function openTauriBrowserPageDevTools') &&
      text.includes('export async function clearTauriBrowserDefaultCookies') &&
      text.includes('export async function importTauriBrowserCookiesFromFile') &&
      text.includes("import('@tauri-apps/api/webview')") &&
      text.includes("from '@tauri-apps/api/core'") &&
      text.includes('browser_child_webview_create') &&
      text.includes('browserTabId: state.browserTabId') &&
      text.includes('Webview.getByLabel(label)') &&
      text.includes('profileKey: tauriBrowserProfileKey') &&
      !text.includes('new Webview(') &&
      text.includes('internal_toggle_devtools') &&
      text.includes("dispatchTauriBrowserWebviewEvent(element, 'dom-ready')") &&
      text.includes("dispatchTauriBrowserWebviewEvent(element, 'did-navigate'") &&
      text.includes('__pebbleDestroyNativeWebview') &&
      text.includes('__pebbleSetNativeBrowserInputLocked') &&
      text.includes('__pebbleTauriBrowserActionExecutors?.register') &&
      text.includes('executeTauriBrowserAction') &&
      text.includes('captureTauriBrowserWebviewScreenshot') &&
      text.includes('export async function captureTauriBrowserSelectionScreenshot') &&
      text.includes('HIDE_GRAB_SCREENSHOT_OVERLAYS') &&
      text.includes('RESTORE_GRAB_SCREENSHOT_OVERLAYS') &&
      text.includes('GRAB_BUDGET.screenshotMaxBytes') &&
      text.includes('browser_child_webview_screenshot') &&
      text.includes("command === 'screenshot'") &&
      text.includes('browser_guest_find') &&
      text.includes('browser_guest_stop_find') &&
      text.includes('found-in-page') &&
      text.includes('export async function setTauriBrowserAnnotationViewportBridge') &&
      text.includes('browser_annotation_overlay_set') &&
      text.includes('MutationObserver') &&
      text.includes("replace(/[^a-zA-Z0-9_/:_-]/g, '-')") &&
      text.includes('state.webviewPartition !== PEBBLE_BROWSER_PARTITION') &&
      text.includes('browser_guest_clear_cookies') &&
      text.includes('browser_guest_import_cookie_file') &&
      text.includes('buildGuestOverlayScript') &&
      text.includes('evaluateTauriBrowserGuest') &&
      text.includes('browser_guest_evaluate') &&
      !text.includes('nativeWebview.eval(') &&
      text.includes('setTauriNativeWebviewBounds') &&
      text.includes('stableNegativeId')
  },
  {
    name: 'Tauri browser pane adapter tests cover action executor lifecycle',
    file: 'packages/product-core/renderer/src/components/browser-pane/tauri-browser-page-webview.test.ts',
    expect: (text) =>
      text.includes(
        'registers a page-scoped browser action executor and unregisters it on destroy'
      ) &&
      text.includes('captures screenshot actions through the live native WebView command') &&
      text.includes('captures and crops grab screenshots through the native WebView command') &&
      text.includes('opens native devtools for the live Tauri child WebView') &&
      text.includes('does not claim devtools opened before the native WebView exists') &&
      text.includes('clears only cookies for live default-partition Tauri child WebViews') &&
      text.includes('clears a shared default cookie store through one live child WebView') &&
      text.includes(
        'does not clear isolated-profile child WebView cookies from the default action'
      ) &&
      text.includes('bridges compatibility find calls to the native Tauri child WebView') &&
      text.includes(
        'routes persisted annotation markers through the native child WebView bridge'
      ) &&
      text.includes('creates isolated-profile child WebViews through the Rust host boundary') &&
      text.includes(
        'reuses the canonical guest grab runtime through the bounded native eval bridge'
      ) &&
      text.includes('browser_guest_find') &&
      text.includes('browser_guest_stop_find') &&
      text.includes('__pebbleTauriBrowserActionExecutors') &&
      text.includes("kind: 'browser.stop'") &&
      text.includes("kind: 'browser.screenshot'") &&
      text.includes('__pebbleDestroyNativeWebview') &&
      text.includes('PEBBLE_BROWSER_BLANK_URL')
  },
  {
    name: 'Tauri Rust browser find commands stay scoped to child WebViews',
    file: 'apps/desktop/src-tauri/src/commands/browser_guest_find.rs',
    expect: (text) =>
      text.includes('pub async fn browser_guest_find') &&
      text.includes('pub async fn browser_guest_stop_find') &&
      text.includes('validate_browser_webview_label') &&
      text.includes('get_webview(&label)') &&
      text.includes('eval_with_callback') &&
      text.includes('FIND_RESULT_TIMEOUT') &&
      text.includes('tracks_find_selection_across_navigation')
  },
  {
    name: 'Tauri Rust annotation overlay validates structured marker geometry',
    file: 'apps/desktop/src-tauri/src/commands/browser_annotation_overlay.rs',
    expect: (text) =>
      text.includes('pub fn browser_annotation_overlay_set') &&
      text.includes('validate_browser_webview_label') &&
      text.includes('validate_markers') &&
      text.includes('MAX_MARKERS') &&
      text.includes('get_webview(&label)') &&
      text.includes('serde_json::to_string(markers)') &&
      text.includes('__pebbleTauriAnnotationOverlay') &&
      text.includes('rejects_invalid_annotation_marker_geometry')
  },
  {
    name: 'Tauri Rust browser cookies support scoped clearing and validated file import',
    file: 'apps/desktop/src-tauri/src/commands/browser_cookies.rs',
    expect: (text) =>
      text.includes('pub async fn browser_guest_clear_cookies') &&
      text.includes('pub async fn browser_guest_import_cookie_file') &&
      text.includes('validate_browser_webview_label') &&
      text.includes('webview.cookies()') &&
      text.includes('delete_cookie(cookie)') &&
      text.includes('webview.set_cookie(cookie)') &&
      text.includes('MAX_COOKIE_FILE_BYTES') &&
      text.includes('MAX_COOKIE_ENTRIES') &&
      text.includes('build_import_cookie') &&
      text.includes('scopes_cookie_clearing_to_browser_child_labels') &&
      !text.includes('clear_all_browsing_data')
  },
  {
    name: 'Tauri Rust imports installed Firefox cookies through a bounded SQLite snapshot',
    file: 'apps/desktop/src-tauri/src/commands/browser_cookie_source_import.rs',
    expect: (text) =>
      text.includes('pub async fn browser_guest_import_from_browser') &&
      text.includes('input.browser_family != "firefox"') &&
      text.includes('cookies.sqlite') &&
      text.includes('SQLITE_OPEN_READ_ONLY') &&
      text.includes('MAX_FIREFOX_COOKIE_DB_BYTES') &&
      text.includes('MAX_COOKIE_ENTRIES + 1') &&
      text.includes('is_safe_profile_directory') &&
      text.includes('FirefoxCookieSnapshot') &&
      text.includes('for suffix in ["-wal", "-shm"]') &&
      text.includes('spawn_blocking') &&
      text.includes('webview.set_cookie(cookie)') &&
      text.includes('reads_firefox_cookie_schema_into_validated_entries')
  },
  {
    name: 'Tauri Rust child WebView creation owns persistent profile isolation',
    file: 'apps/desktop/src-tauri/src/commands/browser_child_webview.rs',
    expect: (text) =>
      text.includes('pub fn browser_child_webview_create') &&
      text.includes('.on_download(') &&
      text.includes('NativeBrowserDownloadEvent') &&
      text.includes('reserve_browser_download_path') &&
      text.includes('sanitize_browser_download_filename') &&
      text.includes('BROWSER_DOWNLOAD_EVENT') &&
      text.includes('pub async fn browser_child_webview_screenshot') &&
      text.includes('BASE64_STANDARD.encode(bytes)') &&
      text.includes('validate_screenshot_crop') &&
      text.includes('validate_device_scale_factor') &&
      text.includes('validate_browser_url') &&
      text.includes('validate_profile_key') &&
      text.includes('browser_profile_data_directory') &&
      text.includes('.data_directory(data_directory)') &&
      text.includes('.data_store_identifier(stable_profile_identifier(profile_key))') &&
      text.includes('.add_child(') &&
      text.includes('accepts_supported_browser_urls_only') &&
      text.includes('profile_identifiers_are_stable_and_distinct')
  },
  {
    name: 'Tauri browser screenshot adapter captures macOS, Windows, and Linux native WebViews',
    file: 'apps/desktop/src-tauri/src/commands/browser_webview_screenshot.rs',
    expect: (text) =>
      text.includes('bitmapImageRepForCachingDisplayInRect') &&
      text.includes('representationUsingType_properties') &&
      text.includes('CapturePreviewCompletedHandler') &&
      text.includes('webview.CapturePreview') &&
      text.includes('CreateStreamOnHGlobal') &&
      text.includes('read_windows_stream') &&
      text.includes('SnapshotRegion::Visible') &&
      text.includes('.write_to_png(&mut png)') &&
      text.includes('browser WebKitGTK snapshot timed out') &&
      text.includes('Duration::from_secs(10)') &&
      text.includes('image::load_from_memory_with_format') &&
      text.includes('decoded.crop_imm') &&
      text.includes('device_scale_factor')
  },
  {
    name: 'Tauri Rust guest evaluation is bounded and browser-child scoped',
    file: 'apps/desktop/src-tauri/src/commands/browser_guest_evaluate.rs',
    expect: (text) =>
      text.includes('pub async fn browser_guest_evaluate') &&
      text.includes('validate_browser_webview_label') &&
      text.includes('MAX_SCRIPT_BYTES') &&
      text.includes('MAX_TIMEOUT_MS') &&
      text.includes('eval_with_callback') &&
      text.includes('browser guest evaluation timed out') &&
      text.includes('bounds_guest_evaluation_scripts')
  },
  {
    name: 'Tauri registers native browser child WebView commands in the app host',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::browser_child_webview::browser_child_webview_create') &&
      text.includes('commands::browser_child_webview::browser_child_webview_cancel_download') &&
      text.includes('commands::browser_child_webview::browser_child_webview_screenshot') &&
      text.includes('commands::browser_cookies::browser_guest_clear_cookies') &&
      text.includes('commands::browser_cookies::browser_guest_import_cookie_file') &&
      text.includes('browser_guest_import_from_browser') &&
      text.includes('commands::browser_guest_find::browser_guest_find') &&
      text.includes('commands::browser_guest_find::browser_guest_stop_find') &&
      text.includes('commands::browser_guest_evaluate::browser_guest_evaluate') &&
      text.includes('commands::browser_annotation_overlay::browser_annotation_overlay_set')
  },
  {
    name: 'Tauri native WebView downloads persist through Go runtime records',
    file: 'apps/desktop/src/tauri-browser-runtime-events.ts',
    expect: (text) =>
      text.includes('NATIVE_BROWSER_DOWNLOAD_EVENT') &&
      text.includes('handleNativeBrowserDownload') &&
      text.includes('nativeDownloadRuntimeIds') &&
      text.includes('runtimeDownloadNativeIds') &&
      text.includes('cancelNativeTauriBrowserDownload') &&
      text.includes("kind === 'progress'") &&
      text.includes("'/v1/browser/downloads'") &&
      text.includes("status: 'inProgress'") &&
      text.includes("status: event.success ? 'completed' : 'failed'") &&
      text.includes('sanitizeDownloadOrigin')
  },
  {
    name: 'Tauri native WebView download bridge tests progress, cancellation, and persistence',
    file: 'apps/desktop/src/tauri-browser-runtime-events.test.ts',
    expect: (text) =>
      text.includes(
        'persists native requested and finished events through the Go runtime record'
      ) &&
      text.includes("nativeDownloadId: 'native-1'") &&
      text.includes('receivedBytes: 4096') &&
      text.includes('browser_child_webview_cancel_download') &&
      text.includes("'/v1/browser/downloads/download-runtime-1'") &&
      text.includes("status: 'completed'")
  },
  {
    name: 'Tauri browser viewport state records toolbar overrides for runtime RPC fallback',
    file: 'apps/desktop/src/tauri-browser-viewport-state.ts',
    expect: (text) =>
      text.includes('setTauriBrowserViewportOverride') &&
      text.includes('readTauriBrowserViewport') &&
      text.includes('viewportOverridesByPageId') &&
      text.includes('DEFAULT_TAURI_BROWSER_VIEWPORT') &&
      text.includes('clearTauriBrowserViewportOverrides')
  },
  {
    name: 'Tauri browser events consume runtime browser.changed instead of web no-ops',
    file: 'apps/desktop/src/tauri-browser-runtime-events.ts',
    expect: (text) =>
      text.includes("topic: 'browser.changed'") &&
      text.includes('emitBrowserTab(value)') &&
      text.includes('emitBrowserDownload(value)') &&
      text.includes('notifyTauriBrowserActiveTab') &&
      text.includes('downloadFinishedListeners')
  },
  {
    name: 'Tauri browser profiles use runtime browser resources and degraded provider status',
    file: 'apps/desktop/src/tauri-browser-runtime-profiles.ts',
    expect: (text) =>
      text.includes("'/v1/browser/profiles'") &&
      text.includes('`/v1/browser/profiles/${encodeURIComponent(args.profileId)}`') &&
      text.includes('deleteTauriBrowserProfileStorage(args.profileId)') &&
      text.includes("invoke<boolean>('browser_profile_storage_delete', { profileKey })") &&
      text.includes('`/v1/browser/downloads/${encodeURIComponent(args.downloadId)}`') &&
      text.includes("'browser_detect_installed_browsers'") &&
      text.includes("status: 'degraded'") &&
      text.includes("'runtime-browser-profiles'") &&
      text.includes("'native-webview'") &&
      text.includes("'native-profile-isolation'") &&
      text.includes("'native-element-grab'") &&
      text.includes("'native-annotation-selection'") &&
      text.includes("'native-find-in-page'") &&
      text.includes("'native-annotation-overlay'") &&
      text.includes("'native-cookie-clear'") &&
      text.includes("'native-cookie-file-import'") &&
      text.includes("'native-firefox-cookie-import'") &&
      text.includes("'native-safari-cookie-import'") &&
      text.includes("'native-chromium-cookie-import'") &&
      text.includes("'native-download-progress'") &&
      text.includes("'native-download-cancel'") &&
      text.includes('getTauriNativeDownloadCapabilities') &&
      text.includes('nativeCanceled === false') &&
      text.includes('Full CDP inspection parity is still being migrated') &&
      !text.includes('catch(() => [])') &&
      text.includes("'runtime-browser-events'")
  },
  {
    name: 'Tauri browser profile tests reject fake empty profile state on runtime failures',
    file: 'apps/desktop/src/tauri-browser-runtime-profiles.test.ts',
    expect: (text) =>
      text.includes('maps runtime browser profiles after the default partition profile') &&
      text.includes('propagates profile list runtime failures') &&
      text.includes('purges native WebView storage before deleting runtime profile metadata') &&
      text.includes('/v1/browser/profiles') &&
      text.includes('runtime browser store unavailable')
  },
  {
    name: 'Tauri Windows WebView2 downloads expose real byte progress and cancellation',
    file: 'apps/desktop/src-tauri/src/commands/browser_webview_download_windows.rs',
    expect: (text) =>
      text.includes('DownloadStartingEventHandler') &&
      text.includes('claim_pending_download_for_url') &&
      text.includes('BytesReceivedChangedEventHandler') &&
      text.includes('TotalBytesToReceive') &&
      text.includes('DOWNLOAD_OPERATIONS') &&
      text.includes('with_webview') &&
      text.includes('operation.Cancel()') &&
      text.includes('tokio::sync::oneshot::channel')
  },
  {
    name: 'Tauri macOS and Linux downloads emit real file byte progress without polling forever',
    file: 'apps/desktop/src-tauri/src/commands/browser_download_file_progress.rs',
    expect: (text) =>
      text.includes('FILE_PROGRESS_INTERVAL') &&
      text.includes('Duration::from_millis(400)') &&
      text.includes('std::fs::metadata(&pending.path)') &&
      text.includes('last_emitted_bytes') &&
      text.includes('is_download_active') &&
      text.includes('NativeBrowserDownloadEvent::Progress') &&
      !text.includes('loop {}')
  },
  {
    name: 'Tauri runtime RPC maps browser profile and tab lifecycle onto Go runtime routes',
    file: 'apps/desktop/src/tauri-browser-runtime-rpc.ts',
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
      text.includes("case 'browser.screenshot'") &&
      text.includes("case 'browser.eval'") &&
      text.includes("case 'browser.viewport'") &&
      text.includes('evaluateBrowserExpression(params)') &&
      text.includes("from './tauri-browser-page-control-rpc'") &&
      text.includes('queueTauriBrowserNavigation') &&
      text.includes('queueTauriBrowserScreenshot(params)') &&
      text.includes("queueTauriBrowserNavigation('goto'") &&
      text.includes("queueTauriBrowserNavigation('goBack'") &&
      text.includes("queueTauriBrowserNavigation('goForward'") &&
      text.includes('readTauriBrowserViewport(params)') &&
      text.includes('importTauriBrowserCookiesFromBrowser') &&
      text.includes('clearTauriBrowserDefaultCookies')
  },
  {
    name: 'Tauri browser navigation RPC waits for provider action results',
    file: 'apps/desktop/src/tauri-browser-navigation-rpc.ts',
    expect: (text) =>
      text.includes('export async function queueTauriBrowserNavigation') &&
      text.includes("command: 'goto'") &&
      text.includes("command === 'reload'") &&
      text.includes('`/v1/browser/tabs/${encodeURIComponent(pageId)}/commands`') &&
      text.includes('getTauriBrowserProviderActionCursor()') &&
      text.includes('waitForTauriBrowserProviderAction(action.id, actionCursor)') &&
      text.includes('readNavigationActionResult(completedAction, tab)') &&
      text.includes('Tauri browser command failed:')
  },
  {
    name: 'Tauri browser runtime RPC tests cover live child WebView evaluation',
    file: 'apps/desktop/src/tauri-browser-runtime-rpc.test.ts',
    expect: (text) =>
      text.includes('evaluates browser expressions in the live Tauri child WebView') &&
      text.includes('evaluateBrowserPageExpressionMock') &&
      text.includes("'browser.eval'") &&
      text.includes('JSON.stringify({ width: innerWidth, height: innerHeight })')
  },
  {
    name: 'Tauri computer actions complete through push with grouped disconnected polling',
    files: [
      'apps/desktop/src/tauri-computer-action-waiter.ts',
      'apps/desktop/src/tauri-computer-action-event.ts'
    ],
    expect: (text) =>
      text.includes('export function waitForTauriComputerAction') &&
      text.includes('subscribeRuntimeEventPush(handleActionEvent, handlePushState)') &&
      text.includes("entry.topic !== 'computer.changed'") &&
      text.includes('readTauriComputerAction(envelope.payload)') &&
      text.includes('if (pushActive) return') &&
      text.includes('FALLBACK_POLL_INTERVAL_MS') &&
      text.includes('pollGroups') &&
      text.includes('TERMINAL_CACHE_LIMIT')
  },
  {
    name: 'Tauri browser and emulator waiters share push-first action completion',
    files: [
      'apps/desktop/src/tauri-browser-provider-action-result.ts',
      'apps/desktop/src/tauri-emulator-runtime-rpc.ts'
    ],
    expect: (text) =>
      text.includes("kindPrefix: 'browser.'") &&
      text.includes("kindPrefix: 'emulator.'") &&
      text.includes('waitForTauriComputerAction({') &&
      text.includes('getTauriComputerActionCursor') &&
      text.includes('afterSequence') &&
      !text.includes('PROVIDER_ACTION_POLL_INTERVAL_MS') &&
      !text.includes('setTimeout(resolve, 25)')
  },
  {
    name: 'Tauri browser screenshot RPC waits for runtime provider action results',
    file: 'apps/desktop/src/tauri-browser-screenshot-rpc.ts',
    expect: (text) =>
      text.includes('export async function queueTauriBrowserScreenshot') &&
      text.includes("command: 'screenshot'") &&
      text.includes('payload: { format }') &&
      text.includes('getTauriBrowserProviderActionCursor()') &&
      text.includes('waitForTauriBrowserProviderAction(action.id, actionCursor)') &&
      text.includes('Tauri browser screenshot provider completed without image data.')
  },
  {
    name: 'Tauri browser runtime RPC tests cover provider action navigation queueing',
    file: 'apps/desktop/src/tauri-browser-runtime-rpc.test.ts',
    expect: (text) =>
      text.includes('queues browser.goto through the runtime browser provider action path') &&
      text.includes('queues browser.screenshot and returns the provider-completed image payload') &&
      text.includes(
        'surfaces browser.screenshot provider failures instead of returning fake image data'
      ) &&
      text.includes('echoes browser viewport requests as a deterministic fallback') &&
      text.includes(
        'reads stored Tauri browser viewport overrides when no explicit size is passed'
      ) &&
      text.includes("method: 'PATCH'") &&
      text.includes("command: 'goto'") &&
      text.includes("command: 'reload'") &&
      text.includes("command: 'screenshot'") &&
      text.includes("'Example Reloaded'")
  },
  {
    name: 'Tauri runtime status commands keep blocking runtime I/O off the WebKit main thread',
    file: 'apps/desktop/src-tauri/src/commands/runtime_status.rs',
    expect: (text) =>
      text.includes('pub async fn read_runtime_event_stream') &&
      text.includes('pub async fn get_runtime_resource_json') &&
      text.includes('pub async fn request_runtime_resource_json') &&
      text.includes('tauri::async_runtime::spawn_blocking(operation)') &&
      text.includes('blocking runtime HTTP/SSE reads here freezes pointer and keyboard input')
  },
  {
    name: 'Tauri native runtime event push bridge is registered and falls back safely',
    file: 'apps/desktop/src-tauri/src/commands/runtime_event_stream.rs',
    expect: (text) =>
      text.includes('const RUNTIME_EVENT: &str = "pebble://runtime-event"') &&
      text.includes('const RUNTIME_EVENT_STATUS: &str = "pebble://runtime-event-status"') &&
      text.includes('pub async fn start_runtime_event_stream') &&
      text.includes('pub fn stop_runtime_event_stream') &&
      text.includes('tauri::async_runtime::spawn(async move') &&
      text.includes('Channel<RuntimeEventPush>') &&
      text.includes('Channel<RuntimeEventStreamStatus>') &&
      text.includes('deliver_status(app, on_status, true)') &&
      text.includes('deliver_status(app, on_status, false)') &&
      text.includes('request = request.bearer_auth(token)') &&
      text.includes('struct SseParser')
  },
  {
    name: 'Tauri main process registers runtime event push commands and state',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::runtime_event_stream::RuntimeEventStreamState::default()') &&
      text.includes('commands::runtime_event_stream::start_runtime_event_stream') &&
      text.includes('commands::runtime_event_stream::stop_runtime_event_stream')
  },
  {
    name: 'Tauri runtime RPC exposes real native provider status through Go runtime',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) => {
      const stable = quoteStable(text)
      return (
        stable.includes("case 'provider.list':") &&
        stable.includes("case 'provider.status':") &&
        stable.includes("case 'provider.register':") &&
        stable.includes('readRuntimeNativeProviders(params)') &&
        stable.includes('readRuntimeSubsystemStatus(params)') &&
        stable.includes('registerRuntimeNativeProvider(params)')
      )
    }
  },
  {
    name: 'Tauri native provider requests use Go runtime provider routes',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) => {
      const stable = quoteStable(text)
      return (
        stable.includes('async function readRuntimeNativeProviders') &&
        stable.includes('async function readRuntimeSubsystemStatus') &&
        stable.includes('async function registerRuntimeNativeProvider') &&
        stable.includes('function readSubsystemName') &&
        stable.includes('function readProviderSubsystem') &&
        stable.includes('requestRuntimeJson<RuntimeNativeProvider[]>(`/v1/providers${query}`') &&
        stable.includes('requestRuntimeJson<RuntimeSubsystemStatus>(`/v1/${subsystem}/status`') &&
        stable.includes("requestRuntimeJson<RuntimeNativeProvider>('/v1/providers'")
      )
    }
  },
  {
    name: 'Go runtime can delete browser profiles for Tauri settings parity',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('s.mux.HandleFunc("/v1/browser/profiles/", s.handleBrowserProfileByID)') &&
      text.includes('func (s *Server) handleBrowserProfileByID') &&
      text.includes('s.manager.DeleteBrowserProfile(id)')
  },
  {
    name: 'Tauri deletes browser profile data only beneath the native profile root',
    file: 'apps/desktop/src-tauri/src/commands/browser_child_webview.rs',
    expect: (text) =>
      text.includes('browser_profile_storage_delete') &&
      text.includes('delete_browser_profile_storage') &&
      text.includes('browser_profile_data_directory_from_root') &&
      text.includes('validate_profile_key(Some(profile_key))') &&
      text.includes('std::fs::remove_dir_all(directory)')
  },
  {
    name: 'Tauri deep link API handles pebble pairing links through runtime environments',
    file: 'apps/desktop/src/tauri-deep-link-api.ts',
    expect: (text) =>
      text.includes('export function installTauriDeepLinkApi') &&
      text.includes("invoke<string[]>('deep_link_initial_urls')") &&
      text.includes('listen<string>(DEEP_LINK_EVENT') &&
      text.includes('parseDeepLinkAction') &&
      text.includes('activeActionKeys.delete(action.key)') &&
      text.includes('runtimeEnvironments.addFromPairingCode') &&
      text.includes('setRuntimeEnvironments(environments)') &&
      text.includes('refreshRuntimeEnvironmentStatus(result.environment.id)')
  },
  {
    name: 'Tauri Rust deep link bridge filters Pebble protocol events',
    file: 'apps/desktop/src-tauri/src/commands/deep_link.rs',
    expect: (text) =>
      text.includes('pub fn deep_link_initial_urls') &&
      text.includes('pub fn emit_deep_links') &&
      text.includes('collect_pebble_deep_links') &&
      text.includes('DeepLinkState') &&
      text.includes('renderer_ready') &&
      text.includes('pending.drain(..)') &&
      text.includes('dedupe_deep_links') &&
      text.includes('MAX_PENDING_DEEP_LINKS') &&
      text.includes('Url::parse(value)') &&
      text.includes('pebble://pair?code=abc')
  },
  {
    name: 'Tauri registers deep link commands and opened URL events',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('tauri_plugin_deep_link::init()') &&
      text.includes('tauri_plugin_single_instance::init') &&
      text.includes('commands::deep_link::deep_link_initial_urls') &&
      text.includes('tauri::RunEvent::Opened') &&
      text.includes('commands::deep_link::emit_deep_links')
  },
  {
    name: 'Tauri crash report API persists renderer errors through native commands',
    file: 'apps/desktop/src/tauri-crash-reports-api.ts',
    expect: (text) =>
      text.includes('export function createPebbleCrashReportsApi') &&
      text.includes("invoke<CrashReportRecord | null>('crash_reports_get_latest_pending'") &&
      text.includes(
        "invoke<ReactErrorBoundaryReportResult>('crash_reports_record_renderer_error'"
      ) &&
      text.includes("invoke<void>('crash_reports_record_breadcrumb'") &&
      text.includes("invoke<CrashReportSubmitResult>('crash_reports_submit'") &&
      text.includes("invoke<string>('crash_reports_format'") &&
      text.includes('breadcrumbWriteQueue = breadcrumbWriteQueue') &&
      text.includes('await waitForBreadcrumbWrites()') &&
      text.includes('getVersion as getTauriAppVersion') &&
      text.includes('readAppVersion') &&
      !text.includes('rootPackage.version')
  },
  {
    name: 'Tauri diagnostics API uses native bundle commands instead of web fallback',
    file: 'apps/desktop/src/tauri-diagnostics-api.ts',
    expect: (text) =>
      text.includes('export function createPebbleDiagnosticsApi') &&
      text.includes("invoke<DiagnosticsStatusPayload>('diagnostics_get_status'") &&
      text.includes("invoke<DiagnosticsBundlePayload>('diagnostics_collect_bundle'") &&
      text.includes("invoke<void>('diagnostics_open_bundle_preview'") &&
      text.includes("invoke<DiagnosticsUploadPayload>('diagnostics_upload_bundle'") &&
      text.includes("invoke<void>('diagnostics_delete_bundle'") &&
      text.includes('getVersion as getTauriAppVersion') &&
      text.includes('readAppVersion') &&
      !text.includes('rootPackage.version')
  },
  {
    name: 'Tauri Rust crash report store mirrors Electron crash-report lifecycle',
    file: 'apps/desktop/src-tauri/src/commands/crash_reports.rs',
    expect: (text) =>
      text.includes('const CRASH_REPORTS_FILE: &str = "crash-reports.json"') &&
      text.includes('pub async fn crash_reports_get_latest_pending') &&
      text.includes('pub async fn crash_reports_record_renderer_error') &&
      text.includes('pub fn crash_reports_record_breadcrumb') &&
      text.includes('pub async fn crash_reports_submit') &&
      text.includes('is_related_crash_event') &&
      text.includes('sanitize_crash_report_string') &&
      text.includes('format_desktop_shell_line') &&
      text.includes('"Desktop shell: Tauri"') &&
      text.includes('FEEDBACK_API_URL') &&
      text.includes('collect_crash_diagnostic_bundle_attachment') &&
      text.includes('create_feedback_multipart_form')
  },
  {
    name: 'Tauri Rust host panics persist through the native crash journal',
    file: 'apps/desktop/src-tauri/src/commands/crash_reports.rs',
    expect: (text) =>
      text.includes('pub fn install_native_panic_hook') &&
      text.includes('std::panic::take_hook()') &&
      text.includes('std::panic::set_hook') &&
      text.includes('PANIC_HOOK_RECORDING') &&
      text.includes('"tauri-host"') &&
      text.includes('"rust-panic: {reason}"') &&
      text.includes('record_native_process_failure') &&
      text.includes('previous(info)')
  },
  {
    name: 'Tauri imports unseen macOS system crash reports into the native journal',
    file: 'apps/desktop/src-tauri/src/commands/macos_system_crash_import.rs',
    expect: (text) =>
      text.includes('Library/Logs/DiagnosticReports') &&
      text.includes('macos-system-crash: {indicator}') &&
      text.includes('system_report_id') &&
      text.includes('incident_ids.contains') &&
      text.includes('record_native_process_failure') &&
      text.includes('MAX_REPORT_BYTES')
  },
  {
    name: 'Tauri recovers dead unclean desktop sessions on the next launch',
    file: 'apps/desktop/src-tauri/src/commands/native_session_recovery.rs',
    expect: (text) =>
      text.includes('const SESSION_FILE: &str = "tauri-session.json"') &&
      text.includes('const SESSION_MARKER_SCHEMA_VERSION: u32 = 2') &&
      text.includes('previous-native-abnormal-exit') &&
      text.includes('process_started_at_epoch_seconds') &&
      text.includes('identity_matches') &&
      text.includes('recovery_evidence_kind') &&
      text.includes('marker.clean = true') &&
      text.includes('PEBBLE_PARITY_CAPTURE_PATH') &&
      text.includes('PEBBLE_NATIVE_SESSION_RECOVERY_DISABLED') &&
      text.includes('record_native_process_failure')
  },
  {
    name: 'Tauri records macOS WebKit content-process termination as a native crash',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('on_web_content_process_terminate') &&
      text.includes('record_web_content_process_termination(webview)')
  },
  {
    name: 'Tauri child WebViews record Windows and Linux native process failures',
    file: 'apps/desktop/src-tauri/src/commands/browser_process_failure.rs',
    expect: (text) =>
      text.includes('connect_web_process_terminated') &&
      text.includes('WebProcessTerminationReason::TerminatedByApi => return') &&
      text.includes('ProcessFailedEventHandler::create') &&
      text.includes('add_ProcessFailed') &&
      text.includes('record_native_webview_process_failure')
  },
  {
    name: 'Tauri installs process-failure hooks on every child browser WebView',
    file: 'apps/desktop/src-tauri/src/commands/browser_child_webview.rs',
    expect: (text) =>
      text.includes('mod browser_process_failure;') &&
      text.includes('browser_process_failure::attach(&webview')
  },
  {
    name: 'Tauri browser lifecycle is driven by native page-load events',
    file: 'apps/desktop/src-tauri/src/commands/browser_child_webview.rs',
    expect: (text) =>
      text.includes('const BROWSER_PAGE_LOAD_EVENT') &&
      text.includes('builder.on_page_load') &&
      text.includes('PageLoadEvent::Started') &&
      text.includes('PageLoadEvent::Finished') &&
      text.includes('NativeBrowserPageLoadEvent')
  },
  {
    name: 'Tauri browser renderer rejects stale synthetic readiness timers',
    file: 'packages/product-core/renderer/src/components/browser-pane/tauri-browser-page-webview.ts',
    expect: (text) =>
      text.includes("const TAURI_BROWSER_PAGE_LOAD_EVENT = 'pebble://browser-page-load'") &&
      text.includes('waitForTauriBrowserPageLoad(pageLoadFinished)') &&
      text.includes("payload.event === 'finished'") &&
      text.includes('payload.label === label') &&
      !text.includes('window.setTimeout(() => void complete(), 750)')
  },
  {
    name: 'Unexpected Go runtime exits are persisted as native crash reports',
    file: 'apps/desktop/src-tauri/src/commands/runtime_process.rs',
    expect: (text) =>
      text.includes('record_native_process_failure') &&
      text.includes('"runtime-process-exited"') &&
      text.includes('"go-runtime"') &&
      text.includes('should_report_runtime_exit') &&
      text.includes('RUNTIME_STARTUP_GRACE')
  },
  {
    name: 'Tauri Rust diagnostics command collects previews and uploadable bundles',
    file: 'apps/desktop/src-tauri/src/commands/diagnostics.rs',
    expect: (text) =>
      text.includes('pub async fn diagnostics_get_status') &&
      text.includes('pub async fn diagnostics_collect_bundle') &&
      text.includes('pub async fn diagnostics_open_bundle_preview') &&
      text.includes('pub fn diagnostics_discard_bundle_preview') &&
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
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::crash_reports::CrashReportsState::default()') &&
      text.includes('commands::crash_reports::crash_reports_get_latest_pending') &&
      text.includes('commands::crash_reports::crash_reports_record_renderer_error') &&
      text.includes('commands::crash_reports::crash_reports_record_breadcrumb') &&
      text.includes('commands::crash_reports::crash_reports_submit')
  },
  {
    name: 'Tauri installs the native panic hook before entering the event loop',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('install_native_panic_hook(app.handle().clone())') &&
      text.indexOf('install_native_panic_hook(app.handle().clone())') <
        text.indexOf('app.run(|app_handle, event|')
  },
  {
    name: 'Tauri registers native diagnostics commands with the Rust invoke handler',
    file: 'apps/desktop/src-tauri/src/main.rs',
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
    file: 'apps/desktop/src-tauri/src/commands/computer_permissions.rs',
    expect: (text) =>
      text.includes('pub async fn computer_permissions_status') &&
      text.includes('pub async fn computer_permissions_open') &&
      text.includes('pub async fn computer_permissions_reset') &&
      text.includes('Pebble Computer Use.app') &&
      text.includes('pebble-computer-use-macos') &&
      text.includes('--permission-status-file') &&
      text.includes('PEBBLE_COMPUTER_MACOS_HELPER_APP_PATH') &&
      text.includes('tccutil') &&
      text.includes('ComputerUsePermissionStatus::NotGranted') &&
      text.includes('unsupported_permission_status()') &&
      text.includes('unsupported_permissions()')
  },
  {
    name: 'Tauri registers native computer-use permission commands with the Rust invoke handler',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::computer_permissions::computer_permissions_status') &&
      text.includes('commands::computer_permissions::computer_permissions_open') &&
      text.includes('commands::computer_permissions::computer_permissions_reset')
  },
  {
    name: 'Tauri Rust updater command checks Nebutra Pebble GitHub release readiness',
    file: 'apps/desktop/src-tauri/src/commands/updater.rs',
    expect: (text) =>
      text.includes(
        'const ATOM_FEED_URL: &str = "https://github.com/nebutra/pebble/releases.atom"'
      ) &&
      text.includes(
        'const CHANGELOG_JSON_URL: &str = "https://www.nebutra.com/pebble/whats-new/changelog.json"'
      ) &&
      text.includes('pub async fn updater_check_latest_release') &&
      text.includes('pub async fn updater_check_release_tag') &&
      text.includes('pub async fn updater_fetch_changelog_entries') &&
      text.includes('has_ready_tauri_manifest') &&
      text.includes('tauri_manifest_has_current_platform') &&
      text.includes('current_updater_platform_prefix') &&
      text.includes('format!("{}/latest.json"') &&
      text.includes('updater_builder()') &&
      text.includes('.endpoints(vec![endpoint])') &&
      text.includes('is_perf_prerelease_tag') &&
      text.includes('compare_versions')
  },
  {
    name: 'Tauri registers native updater check command with the Rust invoke handler',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::updater::updater_check_latest_release') &&
      text.includes('commands::updater::updater_check_release_tag') &&
      text.includes('commands::updater::updater_fetch_changelog_entries')
  },
  {
    name: 'Tauri preflight API detects installed agents instead of returning mock empties',
    file: 'apps/desktop/src/tauri-preflight-agent-api.ts',
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
    file: 'apps/desktop/src-tauri/src/commands/preflight.rs',
    expect: (text) =>
      text.includes('pub async fn preflight_detect_commands') &&
      text.includes('fn is_command_on_path') &&
      text.includes('fn common_agent_install_dirs') &&
      text.includes('PATHEXT') &&
      text.includes('/opt/homebrew/bin')
  },
  {
    name: 'Tauri registers native preflight command detection with the Rust invoke handler',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) => text.includes('commands::preflight::preflight_detect_commands')
  },
  {
    name: 'Tauri git base-ref API backs the canonical branch picker with native git refs',
    file: 'apps/desktop/src/tauri-git-base-ref-api.ts',
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
    file: 'apps/desktop/src-tauri/src/commands/git_refs.rs',
    expect: (text) =>
      text.includes('pub async fn git_search_base_ref_details') &&
      text.includes('pub async fn git_get_base_ref_default') &&
      text.includes('pub async fn git_resolve_pr_start_point') &&
      text.includes('pub async fn git_resolve_mr_start_point') &&
      text.includes('for-each-ref') &&
      text.includes('refs/remotes') &&
      text.includes('resolve_local_branch_name') &&
      text.includes('fetch_github_pr_head_sha') &&
      text.includes('refs/merge-requests/{}/head')
  },
  {
    name: 'Tauri registers native git base-ref commands with the Rust invoke handler',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::git_refs::git_get_base_ref_default') &&
      text.includes('commands::git_refs::git_search_base_ref_details') &&
      text.includes('commands::git_refs::git_resolve_pr_start_point') &&
      text.includes('commands::git_refs::git_resolve_mr_start_point') &&
      text.includes('commands::hooks::hooks_create_issue_command_runner')
  },
  {
    name: 'Tauri Vite aliases @ to the canonical renderer source and emits packaged relative assets',
    file: 'apps/desktop/vite.config.ts',
    expect: (text) =>
      text.includes("base: './'") &&
      text.includes(
        "const rendererSource = resolve(repoRoot, 'packages/product-core/renderer/src')"
      ) &&
      text.includes("'@': rendererSource") &&
      text.includes("dedupe: ['react', 'react-dom']")
  },
  {
    name: 'Tauri production chunks preserve Rollup dependency initialization order',
    file: 'apps/desktop/vite.config.ts',
    // Why: explicit-only manual chunks created renderer-entry/vendor-ui cycles
    // that passed the build but crashed before React could mount.
    expect: (text) => !text.includes('onlyExplicitManualChunks')
  },
  {
    name: 'Tauri CSS imports the canonical renderer stylesheet',
    file: 'apps/desktop/src/pebble-renderer.css',
    expect: (text) =>
      text.includes(
        "@import '../../../packages/product-core/renderer/src/assets/main.css' source(none);"
      ) && text.includes("@source '../../../packages/product-core/renderer/src';")
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
      text.includes(
        '"verify:tauri-mainline": "node config/scripts/verify-tauri-version-sync.mjs && node config/scripts/verify-tauri-mainline.mjs"'
      ) &&
      text.includes('"build:tauri:no-bundle":') &&
      text.includes('"build:tauri:bundle":')
  },
  {
    name: 'Tauri desktop package exposes bundled and no-bundle build scripts',
    file: 'apps/desktop/package.json',
    expect: (text) =>
      text.includes(
        '"tauri:build": "tauri build --ci --bundles app && node scripts/finalize-macos-app-bundle.mjs"'
      ) &&
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
      text.includes('projectPath: apps/desktop') &&
      text.includes('macos-universal') &&
      text.includes('--target universal-apple-darwin --bundles app') &&
      text.includes('linux-x64') &&
      text.includes('linux-arm64') &&
      text.includes('args: --bundles deb') &&
      !text.includes('appimage') &&
      text.includes('windows-x64') &&
      text.includes('prepare-tauri-release-config.mjs') &&
      text.includes('TAURI_UPDATER_PUBLIC_KEY') &&
      text.includes('TAURI_RELEASE_VERSION') &&
      text.includes('TAURI_SIGNING_PRIVATE_KEY') &&
      text.includes('TAURI_SIGNING_PRIVATE_KEY_PASSWORD') &&
      text.includes('PEBBLE_MAC_RELEASE') &&
      text.includes('uploadUpdaterJson: true') &&
      text.includes('verify-tauri-updater-manifest.mjs') &&
      text.includes('Verify merged updater manifest') &&
      text.includes('TAURI_REQUIRED_UPDATER_PLATFORMS') &&
      text.includes('darwin-aarch64,darwin-x86_64,windows-x86_64') &&
      !text.includes('steps.tauri-build.outputs.updaterJson')
  },
  {
    name: 'Linux release evidence enforces Debian-only packaging and the glibc support floor',
    file: 'config/scripts/verify-tauri-release-artifacts.mjs',
    expect: (text) =>
      text.includes("requireSingle(debPackages, 'Linux Debian installer')") &&
      text.includes('verifyLinuxGlibcSymbolCeiling') &&
      text.includes("'glibc-symbol-ceiling'") &&
      text.includes('GLIBC_2.35') &&
      !text.includes('--appimage-extract')
  },
  {
    name: 'Tauri release config replaces the placeholder updater key and enables updater artifacts',
    file: 'config/scripts/prepare-tauri-release-config.mjs',
    expect: (text) =>
      text.includes('validateUpdaterPublicKey') &&
      text.includes('validateSigningPrivateKey') &&
      text.includes('validateSigningPrivateKeyPassword') &&
      text.includes('validateReleaseVersion') &&
      text.includes('createUpdaterArtifacts: true') &&
      text.includes('version: process.env.TAURI_RELEASE_VERSION || rootPackage.version') &&
      text.includes('TAURI_UPDATER_PUBLIC_KEY') &&
      text.includes('Tauri updater endpoints must be configured before release packaging.')
  },
  {
    name: 'Tauri updater release output is signature and repository verified',
    file: 'config/scripts/verify-tauri-updater-manifest.mjs',
    expect: (text) =>
      text.includes('github.com/nebutra/pebble/releases/download/') &&
      text.includes('has no signature') &&
      text.includes('fetchReleaseUpdaterManifest') &&
      text.includes('missing required platform') &&
      text.includes('TAURI_RELEASE_TAG')
  },
  {
    name: 'Tauri updater compares the installed bundle version',
    file: 'apps/desktop/src/tauri-updater-api.ts',
    expect: (text) =>
      text.includes('getVersion as getTauriAppVersion') &&
      text.includes('readCurrentAppVersion') &&
      text.includes('currentVersion') &&
      !text.includes('rootPackage.version')
  },
  {
    name: 'Tauri SSH review base resolution uses the Go relay instead of a remote rejection',
    file: 'apps/desktop/src/tauri-git-base-ref-api.ts',
    expect: (text) =>
      text.includes('/v1/git/base-refs/default') &&
      text.includes('/v1/git/base-refs/search') &&
      text.includes('/v1/git/review-start') &&
      text.includes('requestRemoteReviewStart') &&
      !text.includes('SSH review base resolution is handled by the remote runtime host')
  },
  {
    name: 'Go relay owns SSH base-ref and review start-point Git operations',
    file: 'runtime/go/cmd/pebble-relay-worker/main.go',
    expect: (text) =>
      text.includes('case "git-base-refs-json"') && text.includes('case "git-review-start-json"')
  },
  {
    name: 'Roadmap runtime parity corrections are backed by native implementations',
    file: 'ROADMAP.md',
    expect: (text) =>
      text.includes('## Runtime parity table corrections') &&
      text.includes('/v1/project-groups/scan-nested/cancel') &&
      text.includes('pebble-relay-worker agent-detect') &&
      text.includes('feature-gated sherpa-onnx Rust engine') &&
      text.includes('terminal-artifact-json') &&
      text.includes('preserves OSC 8/52/133 bytes')
  },
  {
    name: 'Go runtime implements scan cancellation relay import credential cache and terminal artifacts',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('handleProjectGroupScanNestedCancel') &&
      text.includes('handleSshTargetByID') &&
      text.includes('handleTerminalArtifactGrant') &&
      text.includes('handleTerminalArtifactRead') &&
      text.includes('handleTerminalArtifactPreview') &&
      text.includes('handleTerminalArtifactWrite')
  },
  {
    name: 'Legacy SSH terminal artifacts retain grants through preview and writeback',
    file: 'runtime/go/internal/runtimecore/ssh_terminal_artifacts.go',
    expect: (text) =>
      text.includes('GrantSshTerminalArtifact') &&
      text.includes('PreviewSshTerminalArtifact') &&
      text.includes('WriteSshTerminalArtifact') &&
      text.includes('terminal_file_grant_mismatch')
  },
  {
    name: 'SSH relay terminal artifacts preserve canonical binary preview MIME types',
    file: 'runtime/go/cmd/pebble-relay-worker/terminal_artifacts.go',
    expect: (text) =>
      text.includes('return "image/x-icon"') &&
      text.includes('return "application/pdf"') &&
      text.includes('terminalArtifactPreviewLimit')
  },
  {
    name: 'Tauri routes relay-only terminal artifacts through Go',
    file: 'apps/desktop/src/tauri-file-runtime-rpc.ts',
    expect: (text) =>
      text.includes('resolveLegacySshTerminalPath') &&
      text.includes('/v1/files/terminal-artifact/preview') &&
      text.includes('/v1/files/terminal-artifact/write')
  },
  {
    name: 'Go mobile terminal snapshots truncate only at complete OSC and UTF-8 boundaries',
    file: 'runtime/go/internal/runtimehttp/terminal_snapshot_suffix.go',
    expect: (text) =>
      text.includes('terminalSnapshotSuffix') &&
      text.includes('activeOSC8') &&
      text.includes('finishOSC') &&
      text.includes('isUTF8Boundary')
  },
  {
    name: 'Go paired runtimes expose renderer-compatible project and worktree discovery',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control.go',
    expect: (text) =>
      text.includes('case "repo.list"') &&
      text.includes('case "worktree.list"') &&
      text.includes('runtimeRPCProject') &&
      text.includes('runtimeRPCWorktree')
  },
  {
    name: 'Go paired runtimes own project-group and folder-workspace mutations',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control_workspace_mutations.go',
    expect: (text) =>
      text.includes('case "projectGroup.scanNested"') &&
      text.includes('case "projectGroup.importNested"') &&
      text.includes('case "projectGroup.create"') &&
      text.includes('case "projectGroup.moveProject"') &&
      text.includes('case "folderWorkspace.create"') &&
      text.includes('case "folderWorkspace.getPathStatus"')
  },
  {
    name: 'Go paired runtimes own encrypted remote file explorer operations',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control_files.go',
    expect: (text) =>
      text.includes('runLegacySharedControlFileMethod') &&
      text.includes('case "files.readDir"') &&
      text.includes('case "files.readPreview"') &&
      text.includes('case "files.readChunk"') &&
      text.includes('case "files.list"') &&
      text.includes('case "files.listAll"') &&
      text.includes('case "files.search"') &&
      text.includes('case "files.write"') &&
      text.includes('case "files.commitUpload"') &&
      text.includes('case "files.resolveTerminalPath"') &&
      text.includes('case "files.readTerminalArtifact"') &&
      text.includes('case "files.writeTerminalArtifact"') &&
      text.includes('legacySharedControlFilePreviewLimit')
  },
  {
    name: 'Go paired runtime terminal artifacts use expiring provenance grants',
    file: 'runtime/go/internal/runtimecore/local_terminal_artifacts.go',
    expect: (text) =>
      text.includes('GrantLocalTerminalArtifact') &&
      text.includes('requireLocalTerminalArtifactGrant') &&
      text.includes('localTerminalArtifactPathAllowed') &&
      text.includes('localTerminalArtifactTextLimit') &&
      text.includes('replaceLocalTerminalArtifact')
  },
  {
    name: 'Go paired runtimes own hosted review lookup eligibility and creation',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control_hosted_reviews.go',
    expect: (text) =>
      text.includes('runLegacySharedControlHostedReviewMethod') &&
      text.includes('legacySharedControlHostedReviewMethod') &&
      text.includes(
        'case "hostedReview.forBranch", "hostedReview.getCreationEligibility", "hostedReview.create"'
      ) &&
      text.includes('GetGitHubPRForBranch') &&
      text.includes('GetGitLabMergeRequestForBranch') &&
      text.includes('HostedReviewCapabilities') &&
      text.includes('CreateHostedReview') &&
      text.includes('case "github.prChecks"') &&
      text.includes('case "github.prCheckDetails"') &&
      text.includes('case "github.rerunPRChecks"') &&
      text.includes('case "gitlab.listMRs"') &&
      text.includes('case "github.updatePR", "github.updatePRTitle", "github.updatePRState"') &&
      text.includes('case "github.mergePR", "gitlab.mergeMR"') &&
      text.includes('case "github.addPRReviewComment", "gitlab.addMRInlineComment"') &&
      text.includes('case "github.resolveReviewThread", "gitlab.resolveMRDiscussion"') &&
      text.includes('AddHostedInlineReviewComment') &&
      text.includes('SetHostedReviewFileViewed')
  },
  {
    name: 'Go paired runtimes detect agents on the runtime host',
    file: 'runtime/go/internal/runtimecore/host_agent_detection.go',
    expect: (text) =>
      text.includes('DetectHostAgents') &&
      text.includes('ID: "codex"') &&
      text.includes('Commands: []string{"auggie"}') &&
      text.includes('Commands: []string{"vibe", "mistral-vibe"}')
  },
  {
    name: 'Go paired runtime preflight preserves check detect and refresh contracts',
    file: 'runtime/go/internal/runtimecore/host_preflight.go',
    expect: (text) =>
      text.includes('DetectHostPreflight') &&
      text.includes('hostProviderAuthStatus') &&
      text.includes('BitbucketConfigFromEnv') &&
      text.includes('AzureDevOpsConfigFromEnv') &&
      text.includes('GiteaConfigFromEnv') &&
      text.includes('HostAgentRefreshResult') &&
      text.includes('"pathSource": "shell_hydrate"')
  },
  {
    name: 'Go paired runtimes report provider and terminal capabilities from the runtime host',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control_host_capabilities.go',
    expect: (text) =>
      text.includes('case "provider.list", "providers.list", "nativeProvider.list"') &&
      text.includes('case "provider.status", "subsystem.status"') &&
      text.includes('case "provider.register", "nativeProvider.register"') &&
      text.includes('case "preflight.detectWindowsTerminalCapabilities"') &&
      text.includes('case "host.platform"') &&
      text.includes('case "host.wsl.listDistros"') &&
      text.includes('case "host.pwsh.isAvailable"') &&
      text.includes('hostprobe.NewProber().Detect()')
  },
  {
    name: 'Go SSH relay worker reports terminal capabilities through a purpose-scoped route',
    file: 'runtime/go/cmd/pebble-relay-worker/main.go',
    expect: (text) =>
      text.includes('case "terminal-capabilities-json":') &&
      text.includes('hostprobe.NewProber().Detect()')
  },
  {
    name: 'Go runtime queries terminal capabilities on the selected SSH target',
    file: 'runtime/go/internal/runtimehttp/ssh_target_routes.go',
    expect: (text) =>
      text.includes('action == "terminal-capabilities"') &&
      text.includes('s.manager.DetectSshTerminalCapabilities(r.Context(), id)')
  },
  {
    name: 'Go runtime proxies the complete provider API through configured SSH relay targets',
    file: 'runtime/go/internal/runtimehttp/provider_relay.go',
    expect: (text) =>
      text.includes('strings.HasPrefix(r.URL.Path, "/v1/providers/")') &&
      text.includes('ResolveRemoteProviderContext') &&
      text.includes('RelayProviderRequest') &&
      text.includes('response.Status < 100 || response.Status > 599')
  },
  {
    name: 'Go SSH relay worker reuses native provider HTTP handlers on the remote workspace',
    file: 'runtime/go/cmd/pebble-relay-worker/provider_http.go',
    expect: (text) =>
      text.includes('runtimehttp.NewServer(manager).ServeHTTP') &&
      text.includes('rewriteProviderRelayRequest') &&
      text.includes('LocationKind: "local"') &&
      text.includes('provider relay path is outside the provider API')
  },
  {
    name: 'Go paired runtimes own provider work item reads and mutations',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control_work_items.go',
    expect: (text) =>
      text.includes('runLegacySharedControlWorkItemMethod') &&
      text.includes('case "github.listIssues"') &&
      text.includes('"github.createIssue", "github.updateIssue"') &&
      text.includes('"gitlab.listIssues", "gitlab.listWorkItems"') &&
      text.includes('"gitlab.createIssue", "gitlab.updateIssue", "gitlab.addIssueComment"') &&
      text.includes('case "providerReview.listWorkItems"') &&
      text.includes('case "github.rateLimit"') &&
      text.includes('case "gitlab.rateLimit"') &&
      text.includes('case "github.prForBranch"') &&
      text.includes('case "github.prFileContents"') &&
      text.includes('case "gitlab.jobTrace"') &&
      text.includes('case "gitlab.retryJob"') &&
      text.includes('GetGitHubPRFileContents') &&
      text.includes('GetGitLabJobTrace') &&
      text.includes('resolveLegacySharedControlWorkItemScope')
  },
  {
    name: 'Go paired runtimes own the GitHub Projects v2 surface',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control_github_projects.go',
    expect: (text) =>
      text.includes('runLegacySharedControlGitHubProjectMethod') &&
      text.includes('case "github.project.resolveRef"') &&
      text.includes('case "github.project.viewTable"') &&
      text.includes('case "github.project.workItemDetailsBySlug"') &&
      text.includes('case "github.project.updateIssueBySlug"') &&
      text.includes('case "github.project.updatePullRequestBySlug"') &&
      text.includes('case "github.project.updateItemField"') &&
      text.includes('case "github.project.clearItemField"') &&
      text.includes('UpdateGitHubIssueTypeBySlug')
  },
  {
    name: 'Go paired runtimes own safe repo and worktree metadata mutations',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control_workspace_mutations.go',
    expect: (text) =>
      text.includes('case "repo.add"') &&
      text.includes('case "repo.create"') &&
      text.includes('case "repo.gitAvailable"') &&
      text.includes('case "repo.hooksCheck"') &&
      text.includes('case "repo.setupScriptImports"') &&
      text.includes('case "repo.issueCommandRead"') &&
      text.includes('case "repo.issueCommandWrite"') &&
      text.includes('case "repo.update"') &&
      text.includes('case "repo.rm"') &&
      text.includes('case "worktree.set"') &&
      text.includes('case "worktree.persistSortOrder"') &&
      text.includes('case "repo.clone"') &&
      text.includes('case "worktree.create"') &&
      text.includes('case "worktree.prefetchCreateBase"') &&
      text.includes('case "worktree.resolvePrBase", "worktree.resolveMrBase"') &&
      text.includes('case "worktree.forceDeleteBranch"') &&
      text.includes('case "worktree.detectedList"') &&
      text.includes('case "worktree.rm", "worktree.remove"') &&
      text.includes('ExecuteGit: true') &&
      text.includes('ForceBranchDelete: true') &&
      text.includes('repository update field is not migrated')
  },
  {
    name: 'Go paired runtimes resolve default bases and search refs on the runtime host',
    file: 'runtime/go/internal/runtimecore/host_git_base_refs.go',
    expect: (text) =>
      text.includes('HostGitBaseRefDefault') &&
      text.includes('SearchHostGitBaseRefs') &&
      text.includes('"refs/remotes/origin/HEAD"') &&
      text.includes('"for-each-ref"') &&
      text.includes('context.WithTimeout')
  },
  {
    name: 'Go paired worktree create owns sparse setup and startup phases',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control_workspace_mutations.go',
    expect: (text) =>
      text.includes('ConfigureWorktreeSparseCheckout') &&
      text.includes('RunWorktreeSetupHookOnHost') &&
      text.includes('builtinAgentStartupCommand') &&
      text.includes('StartSession') &&
      text.includes('result["startupTerminal"]')
  },
  {
    name: 'Go paired startup agent catalog preserves canonical prompt modes',
    file: 'runtime/go/internal/runtimehttp/builtin_agent_launch.go',
    expect: (text) =>
      text.includes('"claude-agent-teams": {"pebble claude-teams", "stdin"}') &&
      text.includes('"opencode": {"opencode", "flag-prompt"}') &&
      text.includes('"copilot": {"copilot", "flag-interactive"}') &&
      text.includes('quoteBuiltinAgentPrompt')
  },
  {
    name: 'Go paired startup drafts preserve review before send',
    file: 'runtime/go/internal/runtimecore/session_draft_paste.go',
    expect: (text) =>
      text.includes('PasteSessionDraftWhenReady') &&
      text.includes('codex-composer-prompt') &&
      text.includes('render-cursor-after-bracketed-paste') &&
      text.includes('"\\x1b[200~" + clean + "\\x1b[201~"')
  },
  {
    name: 'Go runtime owns automation workspace provenance capabilities',
    file: 'runtime/go/internal/runtimecore/automation_workspace_provenance.go',
    expect: (text) =>
      text.includes('BeginAutomationWorkspaceProvenance') &&
      text.includes('ReleaseAutomationWorkspaceProvenance') &&
      text.includes('FinishAutomationWorkspaceProvenance') &&
      text.includes('automationDispatchTokens')
  },
  {
    name: 'Tauri catches up startup automation dispatches with runtime-issued tokens',
    file: 'apps/desktop/src/tauri-automation-dispatch-events.ts',
    expect: (text) =>
      text.includes('payload.dispatchToken') &&
      text.includes("'/v1/automations/renderer-ready'") &&
      text.includes('deliverDispatchRequest(dispatch)') &&
      !text.includes('`${runtimeAutomation.id}:${runtimeRun.id}`')
  },
  {
    name: 'Tauri Rust owns real local sherpa inference',
    file: 'apps/desktop/src-tauri/src/commands/speech_local_engine.rs',
    expect: (text) =>
      text.includes('WhisperRecognizer') &&
      text.includes('TransducerRecognizer') &&
      text.includes('SherpaOnnxCreateOnlineRecognizer') &&
      text.includes('SherpaOnnxOnlineStreamAcceptWaveform')
  },
  {
    name: 'Tauri local speech capability reaches the native engine through the renderer gate',
    file: 'apps/desktop/src/tauri-speech-api.ts',
    expect: (text) =>
      text.includes('speech_local_inference_supported') &&
      text.includes('readPublishedLocalInferenceSupport() !== false') &&
      text.includes('await probeLocalInferenceSupport()') &&
      text.includes('speech_start_dictation')
  },
  {
    name: 'Renderer blocks local dictation only after a definitive native capability failure',
    file: 'packages/product-core/renderer/src/components/dictation/speech-feature-availability.ts',
    expect: (text) => text.includes('__PEBBLE_LOCAL_SPEECH_SUPPORTED__ === false')
  },
  {
    name: 'Tauri browser cookie import has native Firefox Safari and Chromium paths',
    file: 'apps/desktop/src-tauri/src/commands/browser_cookie_source_import.rs',
    expect: (text) =>
      text.includes('read_firefox_cookies') &&
      text.includes('decode_safari_binary_cookies') &&
      text.includes('read_chromium_cookies') &&
      text.includes('decrypt_chromium_cookie') &&
      text.includes('lookup_linux_safe_storage') &&
      text.includes('decrypts_chromium_v10_with_linux_fallback_key') &&
      text.includes('DataProtectionScope]::CurrentUser') &&
      text.includes('decrypt_chromium_gcm') &&
      !text.includes('Native import for this browser is not migrated to Tauri yet.')
  },
  {
    name: 'Tauri browser exec maps advanced agent-browser commands to native runtime RPC',
    file: 'apps/desktop/src/tauri-browser-exec-rpc.ts',
    expect: (text) =>
      text.includes('browser.upload') &&
      text.includes('browser.download') &&
      text.includes('browser.find') &&
      text.includes('browser.wait') &&
      text.includes('browser.eval') &&
      text.includes('browser.setDevice') &&
      text.includes('browser.setHeaders') &&
      text.includes('browser.setMedia') &&
      text.includes("element: requiredAt(rest, 0, 'element ref')") &&
      text.includes("rest[0] === 'type'") &&
      text.includes("setting === 'viewport'") &&
      text.includes("=== 'reduced-motion'") &&
      text.includes('dispatchTab(rest, call)') &&
      text.includes('browser.tabSwitch') &&
      text.includes('browser.tabCreate') &&
      text.includes('browser.tabClose') &&
      text.includes('browser.inspect') &&
      text.includes('browser.pushState') &&
      text.includes('browser.cookie.clear') &&
      text.includes('cookieNamedArguments') &&
      text.includes('duration === undefined ? {} : { duration }') &&
      text.includes("selector: requiredAt(rest, 1, 'element selector')") &&
      text.includes("attribute: requiredAt(rest, 2, 'attribute name')") &&
      text.includes("values: [requiredAt(rest, 1, 'value', true), ...rest.slice(2)]") &&
      text.includes('parseFindArguments(rest)') &&
      text.includes("position: 'nth'") &&
      text.includes('parseSnapshotArguments(rest)') &&
      text.includes('includeUrls: true') &&
      text.includes('browser.clipboardCopy') &&
      text.includes('browser.clipboardPaste') &&
      text.includes('browser.captureSave') &&
      text.includes('captureToOptionalPath') &&
      text.includes('captureArguments(rest)') &&
      text.includes('errorsOnly: true') &&
      text.includes('dispatchNetwork(rest, call)') &&
      text.includes('browser.intercept.enable') &&
      text.includes('browser.intercept.disable') &&
      text.includes('browser.dialogAccept') &&
      text.includes('browser.dialogDismiss') &&
      text.includes('executeTauriBrowserDiff(target.page, rest, call)') &&
      text.includes('rememberTauriBrowserSnapshot(target.page, result)')
  },
  {
    name: 'Tauri browser diff uses bounded native baselines and renderer-native image comparison',
    file: 'apps/desktop/src/tauri-browser-diff.ts',
    expect: (text) =>
      text.includes('previousSnapshots = new Map<string, string>()') &&
      text.includes('browser.captureRead') &&
      text.includes('browser.captureSave') &&
      text.includes('compareBrowserImages') &&
      text.includes('createImageBitmap') &&
      text.includes('baseline.close()') &&
      text.includes('current.close()') &&
      text.includes('diffUrls') &&
      text.includes('MAX_SNAPSHOT_CHARS')
  },
  {
    name: 'Tauri Rust host bounds browser diff baseline reads',
    file: 'apps/desktop/src-tauri/src/commands/browser_capture_save.rs',
    expect: (text) =>
      text.includes('pub fn browser_capture_read') &&
      text.includes('MAX_SNAPSHOT_BYTES') &&
      text.includes('Browser capture baseline cannot be a symbolic link.') &&
      text.includes('"snapshot" => Ok(&["txt"])')
  },
  {
    name: 'Tauri browser DOM actions route bounded selectors through frames and open shadow roots',
    file: 'packages/product-core/renderer/src/components/browser-pane/tauri-browser-selector-routing.ts',
    expect: (text) =>
      text.includes('const resolveTarget=(target)=>') &&
      text.includes('target.split(/\\s*>>>\\s*/)') &&
      text.includes('element.shadowRoot') &&
      text.includes('frame.contentDocument') &&
      text.includes('cross-origin or unavailable frame') &&
      text.includes('route segment is ambiguous') &&
      text.includes('data-pebble-automation-ref') &&
      text.includes('frame.getBoundingClientRect()')
  },
  {
    name: 'Tauri browser captures save through a bounded atomic Rust writer',
    file: 'apps/desktop/src-tauri/src/commands/browser_capture_save.rs',
    expect: (text) =>
      text.includes('MAX_IMAGE_BASE64_CHARS') &&
      text.includes('MAX_PDF_BASE64_CHARS') &&
      text.includes('Relative browser capture paths cannot escape the workspace') &&
      text.includes('file_type().is_symlink()') &&
      text.includes('file.sync_all()') &&
      text.includes('fs::rename')
  },
  {
    name: 'Tauri native interception lists active patterns for exact route removal',
    file: 'apps/desktop/src-tauri/src/commands/browser_navigation_interception.rs',
    expect: (text) =>
      text.includes('pub struct BrowserNavigationInterceptionListResult') &&
      text.includes('patterns: Vec<String>') &&
      text.includes('routes: Vec<NativeBrowserInterceptRoute>') &&
      text.includes('.routes') &&
      text.includes('.map(|route| route_pattern(route).to_owned())')
  },
  {
    name: 'Tauri browser network routes preserve abort and bounded fulfill behavior',
    file: 'apps/desktop/src/tauri-browser-exec-rpc.ts',
    expect: (text) =>
      text.includes("action: 'fulfill'") &&
      text.includes("body: options.body ?? ''") &&
      text.includes('status: readHttpStatus(options.status)') &&
      text.includes("contentType: options['content-type']") &&
      text.includes('existing.filter((entry) => entry.pattern !== pattern)')
  },
  {
    name: 'Tauri browser network inspection supports official filters and request detail',
    file: 'apps/desktop/src/tauri-browser-exec-rpc.ts',
    expect: (text) =>
      text.includes("options.type.split(',').filter(Boolean)") &&
      text.includes('method: options.method') &&
      text.includes('status: options.status') &&
      text.includes("requestId: requiredAt(rest, 1, 'network request id')")
  },
  {
    name: 'Tauri child WebViews retain bounded request and response detail continuously',
    file: 'apps/desktop/src-tauri/src/commands/browser_child_webview.rs',
    expect: (text) =>
      text.includes('pushBounded(state.network, entry)') &&
      text.includes('response.clone().text()') &&
      text.includes('body.slice(0, 65536)') &&
      text.includes("resourceType: 'xhr'") &&
      text.includes('responseHeaders')
  },
  {
    name: 'Tauri browser CLI records and saves HAR through the native capture boundary',
    file: 'apps/desktop/src/tauri-browser-exec-rpc.ts',
    expect: (text) =>
      text.includes("operation === 'start'") &&
      text.includes("call('browser.harStop')") &&
      text.includes("call('browser.harSave'") &&
      text.includes('har: readObject(result).har')
  },
  {
    name: 'Tauri browser HAR projection emits standard 1.2 request and response entries',
    file: 'packages/product-core/renderer/src/components/browser-pane/tauri-browser-dom-automation.ts',
    expect: (text) =>
      text.includes("input.command==='harStart'||input.command==='harStop'") &&
      text.includes("version:'1.2'") &&
      text.includes("creator:{name:'Pebble',version:'1'}") &&
      text.includes('queryString:[]') &&
      text.includes('timings:{send:0,wait:0,receive:0}')
  },
  {
    name: 'Rust capture writer bounds and atomically persists HAR artifacts',
    file: 'apps/desktop/src-tauri/src/commands/browser_capture_save.rs',
    expect: (text) =>
      text.includes('MAX_HAR_BASE64_CHARS') &&
      text.includes('"har" => Ok(&["har"])') &&
      text.includes('file.sync_all()') &&
      text.includes('fs::rename')
  },
  {
    name: 'Tauri child WebViews fulfill fetch and XHR route mocks without blocking navigation',
    file: 'apps/desktop/src-tauri/src/commands/browser_child_webview.rs',
    expect: (text) =>
      text.includes('interceptRoutes: []') &&
      text.includes('matchingRoute') &&
      text.includes('new Response(route.body') &&
      text.includes("route?.action === 'fulfill'") &&
      text.includes('Object.defineProperties(this')
  },
  {
    name: 'Tauri browser picker exposes all natively importable browser families',
    file: 'apps/desktop/src/tauri-browser-runtime-profiles.ts',
    expect: (text) =>
      text.includes('native-chromium-cookie-import') &&
      text.includes('native-safari-cookie-import') &&
      !text.includes("browsers.filter((browser) => browser.family === 'firefox')")
  },
  {
    name: 'Tauri browser device emulation persists across child WebView navigation',
    file: 'packages/product-core/renderer/src/components/browser-pane/tauri-browser-page-webview.ts',
    expect: (text) =>
      text.includes('deviceEmulation: TauriBrowserDeviceEmulation | null') &&
      text.includes('nativeUserAgent: string | null') &&
      text.includes('setTauriBrowserPageDeviceEmulation') &&
      text.includes('applyTauriBrowserDeviceEmulation') &&
      text.includes("define(navigator, 'maxTouchPoints'") &&
      text.includes('await applyTauriBrowserDeviceEmulation(state)') &&
      text.includes('userAgent: state.nativeUserAgent') &&
      text.includes('before dom-ready observers inspect navigator/media state')
  },
  {
    name: 'Tauri browser provider reports document device emulation honestly',
    file: 'apps/desktop/src/tauri-browser-runtime-profiles.ts',
    expect: (text) =>
      text.includes("'document-device-emulation'") &&
      text.includes("'native-request-user-agent'") &&
      text.includes("'native-top-level-interception'")
  },
  {
    name: 'Tauri Rust child WebView validates and applies native request User-Agent',
    file: 'apps/desktop/src-tauri/src/commands/browser_child_webview.rs',
    expect: (text) =>
      text.includes('MAX_BROWSER_USER_AGENT_LENGTH') &&
      text.includes('validate_browser_user_agent') &&
      text.includes('builder = builder.user_agent(user_agent)')
  },
  {
    name: 'Tauri Rust blocks and records native top-level browser navigation',
    file: 'apps/desktop/src-tauri/src/commands/browser_navigation_interception.rs',
    expect: (text) =>
      text.includes('browser_navigation_interception_enable') &&
      text.includes('browser_navigation_interception_disable') &&
      text.includes('browser_navigation_interception_list') &&
      text.includes('pub fn should_block') &&
      text.includes('"native-top-level-and-windows-request-control"') &&
      text.includes('"native-top-level"') &&
      text.includes('pub fn decide_top_level_navigation') &&
      text.includes('NativeTopLevelNavigationDecision::Fulfill') &&
      text.includes('serve_top_level_fulfillment') &&
      text.includes('MAX_PENDING_FULFILLMENTS') &&
      text.includes('cfg!(target_os = "windows")') &&
      text.includes('MAX_INTERCEPTED')
  },
  {
    name: 'Tauri registers one-shot browser fulfillment protocol',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('register_uri_scheme_protocol') &&
      text.includes('FULFILLMENT_SCHEME') &&
      text.includes('serve_top_level_fulfillment')
  },
  {
    name: 'Tauri translates canonical Electron drag regions into native window dragging',
    file: 'apps/desktop/src/tauri-window-drag-regions.ts',
    expect: (text) =>
      text.includes("'-webkit-app-region'") &&
      text.includes('appWindow.startDragging()') &&
      text.includes('resolveTauriTitlebarPointerAction') &&
      text.includes('window.api.ui.requestClose()') &&
      text.includes('getCurrentWindow().toggleMaximize()') &&
      text.includes("region === 'no-drag'") &&
      text.includes("region === 'drag'") &&
      text.includes('DRAG_REGION_SELECTOR') &&
      text.includes('NO_DRAG_REGION_SELECTOR')
  },
  {
    name: 'Tauri owns the Windows tray and guarded minimize-to-tray lifecycle',
    files: [
      'apps/desktop/src-tauri/Cargo.toml',
      'apps/desktop/src-tauri/src/main.rs',
      'apps/desktop/src-tauri/src/windows_system_tray.rs',
      'apps/desktop/src/tauri-window-api.ts'
    ],
    expect: (text) =>
      text.includes('"tray-icon"') &&
      text.includes('windows_system_tray::install(app)') &&
      text.includes('TrayIconBuilder::with_id("pebble-main-tray")') &&
      text.includes('OPEN_MENU_ID') &&
      text.includes('QUIT_MENU_ID') &&
      text.includes('pebble://tray-quit') &&
      text.includes('minimizeToTrayOnClose') &&
      text.includes('await getCurrentWindow().hide()')
  },
  {
    name: 'Tauri feedback uses a bounded native host submission instead of the web fallback',
    file: 'apps/desktop/src-tauri/src/commands/feedback.rs',
    expect: (text) =>
      text.includes(
        'const FEEDBACK_API_URL: &str = "https://www.nebutra.com/pebble/v1/feedback"'
      ) &&
      text.includes('Duration::from_secs(10)') &&
      text.includes('fn sanitize_identity') &&
      text.includes('if anonymous') &&
      text.includes('app.package_info().version.to_string()') &&
      text.includes('client.post(FEEDBACK_API_URL).json(&body).send().await')
  },
  {
    name: 'Tauri preload replaces the web feedback API with the native command bridge',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes("import { createPebbleFeedbackApi } from './tauri-feedback-api'") &&
      text.includes('api.feedback = createPebbleFeedbackApi()')
  },
  {
    name: 'Tauri Markdown PDF export uses the existing cross-platform native WebView printer',
    file: 'apps/desktop/src-tauri/src/commands/export_pdf.rs',
    expect: (text) =>
      text.includes('WebviewWindowBuilder::new') &&
      text.includes('PageLoadEvent::Finished') &&
      text.includes('wait_for_ready_title') &&
      text.includes('capture_webview_pdf_bytes') &&
      text.includes('rfd::FileDialog::new()') &&
      text.includes('MAX_EXPORT_HTML_BYTES')
  },
  {
    name: 'Tauri preload replaces the web PDF export API with the native command bridge',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes("import { createPebbleExportApi } from './tauri-export-api'") &&
      text.includes('api.export = createPebbleExportApi()')
  },
  {
    name: 'Go provider checks retain native identifiers and bounded detail logs',
    file: 'runtime/go/internal/providercli/github.go',
    expect: (text) =>
      text.includes('WorkflowRunID: parseActionsRunID') &&
      text.includes('func GetGitHubPRCheckDetails') &&
      text.includes('func RerunGitHubPRChecks') &&
      text.includes('func readCommitCheckRuns') &&
      text.includes('check-runs/%d/rerequest') &&
      text.includes('attachFailedJobLogTails') &&
      text.includes('const maxTailBytes = 16 * 1024')
  },
  {
    name: 'Go runtime exposes GitHub check detail and rerun provider routes',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/providers/github/pulls/check-details"') &&
      text.includes('"/v1/providers/github/pulls/checks/rerun"')
  },
  {
    name: 'Tauri dispatcher maps GitHub check details and reruns to Go',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('case "github.prCheckDetails":') &&
      text.includes('fetchGitHubPRCheckDetails(getProviderJson, params)') &&
      text.includes('case "github.rerunPRChecks":') &&
      text.includes('rerunGitHubPRChecks(postProviderJson, params)')
  },
  {
    name: 'Go provider owns bounded self-hosted GitLab job trace and retry actions',
    file: 'runtime/go/internal/providercli/gitlab.go',
    expect: (text) =>
      text.includes('const maxGitLabJobTraceBytes = 16 * 1024 * 1024') &&
      text.includes('func GetGitLabJobTrace') &&
      text.includes('func RetryGitLabJob') &&
      text.includes('"--hostname", project.Host') &&
      text.includes('encodeGitLabProjectPath') &&
      text.includes('glab repo view output')
  },
  {
    name: 'Go runtime exposes GitLab job trace and retry provider routes',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/providers/gitlab/jobs/trace"') &&
      text.includes('"/v1/providers/gitlab/jobs/retry"')
  },
  {
    name: 'Tauri dispatcher maps GitLab pipeline job actions to Go',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('case "gitlab.jobTrace":') &&
      text.includes('fetchGitLabJobTrace(postProviderJson, params)') &&
      text.includes('case "gitlab.retryJob":') &&
      text.includes('retryGitLabJob(postProviderJson, params)')
  },
  {
    name: 'Go provider owns GitLab issue and combined work-item reads',
    file: 'runtime/go/internal/providercli/gitlab_issues.go',
    expect: (text) =>
      text.includes('func ListGitLabIssues') &&
      text.includes('func ListGitLabWorkItems') &&
      text.includes('fetchGitLabIssues') &&
      text.includes('resolveGitLabProjectRef') &&
      text.includes('sort.SliceStable') &&
      text.includes('scope') &&
      text.includes('assigned_to_me')
  },
  {
    name: 'Go runtime exposes GitLab issue and combined work-item routes',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/providers/gitlab/issues"') &&
      text.includes('"/v1/providers/gitlab/work-items"')
  },
  {
    name: 'Tauri maps direct and runtime GitLab issue reads to Go',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('case "gitlab.listIssues":') &&
      text.includes('fetchGitLabIssues(getProviderJson, params)') &&
      text.includes('case "gitlab.listWorkItems":') &&
      text.includes('fetchGitLabWorkItems(getProviderJson, params)')
  },
  {
    name: 'Go provider owns GitHub issue and combined work-item reads',
    file: 'runtime/go/internal/providercli/github_work_items.go',
    expect: (text) =>
      text.includes('func ListGitHubIssues') &&
      text.includes('func ListGitHubWorkItems') &&
      text.includes('func GetGitHubWorkItem') &&
      text.includes('fetchGitHubIssueRows') &&
      text.includes('fetchGitHubPRRows') &&
      text.includes('sort.SliceStable') &&
      text.includes('pull_request') &&
      text.includes('updated:<')
  },
  {
    name: 'Go runtime exposes GitHub issue and work-item routes',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/providers/github/issues"') &&
      text.includes('"/v1/providers/github/work-items"') &&
      text.includes('"/v1/providers/github/work-item"')
  },
  {
    name: 'Tauri maps direct and runtime GitHub work-item reads to Go',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('case "github.listIssues":') &&
      text.includes('case "github.listWorkItems":') &&
      text.includes('case "github.issue":') &&
      text.includes('case "github.workItem":') &&
      text.includes('case "github.workItemByOwnerRepo":') &&
      text.includes('fetchGitHubIssue(getProviderJson, params)') &&
      text.includes('fetchGitHubWorkItem(getProviderJson, params)')
  },
  {
    name: 'Go projects persist and validate GitHub issue source preference',
    file: 'runtime/go/internal/runtimecore/manager.go',
    expect: (text) =>
      text.includes('validateIssueSourcePreference') &&
      text.includes('case "", "auto":') &&
      text.includes('case "origin", "upstream":') &&
      text.includes('project.IssueSourcePreference = preference')
  },
  {
    name: 'Go provider resolves GitHub origin and upstream work-item sources',
    file: 'runtime/go/internal/providercli/github_work_items.go',
    expect: (text) =>
      text.includes('ResolveGitHubWorkItemSources') &&
      text.includes('resolveGitHubRemoteOwnerRepo(ctx, workdir, "origin")') &&
      text.includes('resolveGitHubRemoteOwnerRepo(ctx, workdir, "upstream")') &&
      text.includes('preference) == "upstream"') &&
      text.includes('UpstreamCandidate: upstream')
  },
  {
    name: 'Go provider owns GitHub issue creation count and metadata reads',
    file: 'runtime/go/internal/providercli/github_issue_metadata.go',
    expect: (text) =>
      text.includes('func CreateGitHubIssue') &&
      text.includes('func CountGitHubWorkItems') &&
      text.includes('func ListGitHubLabels') &&
      text.includes('func ListGitHubAssignableUsers') &&
      text.includes('githubWorkItemsQueryMaxBytes') &&
      text.includes('"--paginate"')
  },
  {
    name: 'Go runtime exposes GitHub issue creation count and metadata routes',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/providers/github/issues/create"') &&
      text.includes('"/v1/providers/github/work-items/count"') &&
      text.includes('"/v1/providers/github/labels"') &&
      text.includes('"/v1/providers/github/assignable-users"')
  },
  {
    name: 'Tauri maps GitHub issue creation count and metadata to Go',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('case "github.createIssue":') &&
      text.includes('case "github.countWorkItems":') &&
      text.includes('case "github.listLabels":') &&
      text.includes('case "github.listAssignableUsers":') &&
      text.includes('createGitHubIssue(postProviderJson, params)')
  },
  {
    name: 'Go provider owns core GitHub issue and PR work-item details',
    file: 'runtime/go/internal/providercli/github_work_item_details.go',
    expect: (text) =>
      text.includes('func GetGitHubWorkItemDetails') &&
      text.includes('getGitHubIssueDetails') &&
      text.includes('getGitHubPRDetails') &&
      text.includes('readGitHubComments') &&
      text.includes('readGitHubIssueTimeline') &&
      text.includes('readGitHubPRFiles') &&
      text.includes('GetGitHubPRChecks')
  },
  {
    name: 'Go runtime and Tauri expose GitHub work-item details',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('case "github.workItemDetails":') &&
      text.includes('fetchGitHubWorkItemDetails(getProviderJson, params)')
  },
  {
    name: 'Go provider owns GitHub issue updates and rich PR reads',
    file: 'runtime/go/internal/providercli/github_issue_mutation.go',
    expect: (text) =>
      text.includes('func UpdateGitHubIssue') &&
      text.includes('githubIssueStateArgs') &&
      text.includes('githubIssueEditArgs') &&
      text.includes('"--duplicate-of"')
  },
  {
    name: 'Tauri maps GitHub issue updates comments and file contents to Go',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('case "github.updateIssue":') &&
      text.includes('case "github.prComments":') &&
      text.includes('case "github.prFileContents":') &&
      text.includes('updateGitHubIssue(postProviderJson, params)') &&
      text.includes('fetchGitHubPRComments(getProviderJson, params)') &&
      text.includes('fetchGitHubPRFileContents(postProviderJson, params)')
  },
  {
    name: 'Go provider preserves GitHub review threads',
    file: 'runtime/go/internal/providercli/github_pr_comments.go',
    expect: (text) =>
      text.includes('githubReviewThreadsQuery') &&
      text.includes('ThreadID') &&
      text.includes('OriginalLine') &&
      text.includes('readGitHubPRReviewSummaries')
  },
  {
    name: 'Go provider owns bounded GitHub base and head file contents',
    file: 'runtime/go/internal/providercli/github_pr_file_contents.go',
    expect: (text) =>
      text.includes('func GetGitHubPRFileContents') &&
      text.includes('githubRawContentMaxBytes') &&
      text.includes('input.Status != "added"') &&
      text.includes('input.Status != "removed"') &&
      text.includes('bytes.IndexByte')
  },
  {
    name: 'Go provider owns GitHub ProjectV2 discovery resolution and views',
    file: 'runtime/go/internal/providercli/github_project_catalog.go',
    expect: (text) =>
      text.includes('func ListAccessibleGitHubProjects') &&
      text.includes('func ResolveGitHubProjectRef') &&
      text.includes('func ListGitHubProjectViews') &&
      text.includes('PartialFailures') &&
      text.includes('ViewNumber')
  },
  {
    name: 'Tauri maps GitHub ProjectV2 catalog RPCs to Go',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('case "github.project.listAccessible":') &&
      text.includes('case "github.project.resolveRef":') &&
      text.includes('case "github.project.listViews":') &&
      text.includes('fetchAccessibleGitHubProjects(getProviderJson)') &&
      text.includes('resolveGitHubProjectRef(getProviderJson, params)') &&
      text.includes('fetchGitHubProjectViews(getProviderJson, params)')
  },
  {
    name: 'Go provider owns bounded ProjectV2 table reads and parent fallback',
    file: 'runtime/go/internal/providercli/github_project_table.go',
    expect: (text) =>
      text.includes('func GetGitHubProjectViewTable') &&
      text.includes('githubProjectTableMaxItems = 500') &&
      text.includes('readGitHubProjectViewFields') &&
      text.includes('readGitHubProjectItemsWithParent') &&
      text.includes('Kind: "too_large"') &&
      text.includes('Kind: "schema_drift"')
  },
  {
    name: 'Tauri maps ProjectV2 table and branch PR lookup to native providers',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('case "github.project.viewTable":') &&
      text.includes('fetchGitHubProjectViewTable(postProviderJson, params)') &&
      text.includes('case "github.prForBranch":') &&
      text.includes('fetchGitHubPRForBranch(postProviderJson, params)')
  },
  {
    name: 'Go provider preserves linked branch and merged fallback PR semantics',
    file: 'runtime/go/internal/providercli/github_pr_for_branch.go',
    expect: (text) =>
      text.includes('func GetGitHubPRForBranch') &&
      text.includes('LinkedPRNumber') &&
      text.includes('FallbackPRNumber') &&
      text.includes('AcceptMergedFallbackPR') &&
      text.includes('CurrentHeadOID') &&
      text.includes('githubPRChecksStatus') &&
      text.includes('githubPRRepositoryCandidates') &&
      text.includes('readGitHubTrackedUpstream') &&
      text.includes('githubMergedPRContainsCommit') &&
      text.includes('readGitHubPRConflictSummary')
  },
  {
    name: 'Go provider hydrates visible GitHub participants in one bounded query',
    file: 'runtime/go/internal/providercli/github_participant_hydration.go',
    expect: (text) =>
      text.includes('githubParticipantHydrationLimit = 50') &&
      text.includes('func hydrateGitHubParticipants') &&
      text.includes('api", "graphql') &&
      text.includes('avatarUrl(size:48)') &&
      text.includes('return participants')
  },
  {
    name: 'Tauri preload replaces web PR refresh no-ops with a native coordinator',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes('createTauriGitHubPRRefreshCoordinator') &&
      text.includes('const githubPRRefresh =') &&
      text.includes('...githubPRRefresh')
  },
  {
    name: 'Tauri owns coalesced bounded GitHub PR refresh scheduling',
    file: 'apps/desktop/src/tauri-github-pr-refresh-coordinator.ts',
    expect: (text) =>
      text.includes('MAX_CONCURRENT_REFRESHES = 2') &&
      text.includes('POST_PUSH_DELAY_MS = 2_500') &&
      text.includes('ERROR_BACKOFF_MAX_MS') &&
      text.includes('visibleGeneration') &&
      text.includes('aliases.set(alias.cacheKey') &&
      text.includes('onPRRefreshEvent')
  },
  {
    name: 'Go provider owns GitHub ProjectV2 repository metadata and typed mutations',
    file: 'runtime/go/internal/providercli/github_project_field_mutations.go',
    expect: (text) =>
      text.includes('func UpdateGitHubProjectItemField') &&
      text.includes('func ClearGitHubProjectItemField') &&
      text.includes('func UpdateGitHubIssueTypeBySlug') &&
      text.includes('singleSelectOptionId') &&
      text.includes('iterationId')
  },
  {
    name: 'Tauri maps GitHub ProjectV2 slug reads and writes to Go',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('case "github.project.listLabelsBySlug":') &&
      text.includes('case "github.project.listAssignableUsersBySlug":') &&
      text.includes('case "github.project.listIssueTypesBySlug":') &&
      text.includes('case "github.project.workItemDetailsBySlug":') &&
      text.includes('case "github.project.updateIssueBySlug":') &&
      text.includes('case "github.project.updatePullRequestBySlug":') &&
      text.includes('case "github.project.updateItemField":') &&
      text.includes('case "github.project.clearItemField":') &&
      text.includes('case "github.project.updateIssueTypeBySlug":') &&
      text.includes('case "github.project.addIssueCommentBySlug":') &&
      text.includes('case "github.project.updateIssueCommentBySlug":') &&
      text.includes('case "github.project.deleteIssueCommentBySlug":')
  },
  {
    name: 'Go provider owns GitLab issue mutations and label discovery',
    file: 'runtime/go/internal/providercli/gitlab_issue_mutations.go',
    expect: (text) =>
      text.includes('func CreateGitLabIssue') &&
      text.includes('func UpdateGitLabIssue') &&
      text.includes('func AddGitLabIssueComment') &&
      text.includes('func ListGitLabLabels') &&
      text.includes('"description="') &&
      text.includes('gitLabHostnameArgs')
  },
  {
    name: 'Go runtime exposes GitLab issue mutation and label routes',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/providers/gitlab/labels"') &&
      text.includes('"/v1/providers/gitlab/issues/create"') &&
      text.includes('"/v1/providers/gitlab/issues/update"') &&
      text.includes('"/v1/providers/gitlab/issues/comment"')
  },
  {
    name: 'Tauri maps direct and runtime GitLab issue mutations to Go',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('case "gitlab.listLabels":') &&
      text.includes('case "gitlab.createIssue":') &&
      text.includes('case "gitlab.updateIssue":') &&
      text.includes('case "gitlab.addIssueComment":') &&
      text.includes('createGitLabIssue(postProviderJson, params)') &&
      text.includes('addGitLabIssueComment(postProviderJson, params)')
  },
  {
    name: 'Go provider owns GitLab todos and full work-item details',
    file: 'runtime/go/internal/providercli/gitlab_work_item_details.go',
    expect: (text) =>
      text.includes('func GetGitLabWorkItemDetails') &&
      text.includes('func GetGitLabWorkItemByPath') &&
      text.includes('fetchGitLabDiscussions') &&
      text.includes('fetchGitLabPipelineJobs') &&
      text.includes('fetchGitLabReviewers') &&
      text.includes('fetchGitLabApprovalState') &&
      text.includes('fetchGitLabMRFiles')
  },
  {
    name: 'Go runtime exposes GitLab todo and detail routes',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/providers/gitlab/todos"') &&
      text.includes('"/v1/providers/gitlab/work-item-details"') &&
      text.includes('"/v1/providers/gitlab/work-item-by-path"')
  },
  {
    name: 'Tauri dispatcher maps every canonical GitLab method',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('case "gitlab.todos":') &&
      text.includes('case "gitlab.workItemDetails":') &&
      text.includes('case "gitlab.workItemByPath":') &&
      text.includes('fetchGitLabWorkItemDetails(getProviderJson, params)') &&
      text.includes('fetchGitLabWorkItemByPath(getProviderJson, params)')
  },
  {
    name: 'Go provider owns formerly empty local GitLab metadata reads',
    file: 'runtime/go/internal/providercli/gitlab_local_metadata.go',
    expect: (text) =>
      text.includes('func GetGitLabProjectRef') &&
      text.includes('func GetGitLabMergeRequestForBranch') &&
      text.includes('func GetGitLabMergeRequest') &&
      text.includes('func GetGitLabIssue') &&
      text.includes('func ListGitLabAssignableUsers') &&
      text.includes('"--paginate"')
  },
  {
    name: 'Go runtime exposes local GitLab metadata routes',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/providers/gitlab/project-ref"') &&
      text.includes('"/v1/providers/gitlab/merge-request"') &&
      text.includes('"/v1/providers/gitlab/merge-request-for-branch"') &&
      text.includes('"/v1/providers/gitlab/issue"') &&
      text.includes('"/v1/providers/gitlab/assignable-users"')
  },
  {
    name: 'Tauri preload replaces all local GitLab Web fallbacks',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes('projectSlug: (args) => fetchGitLabProjectRef') &&
      text.includes('mrForBranch: (args) => fetchGitLabMergeRequestForBranch') &&
      text.includes('mr: (args) => fetchGitLabMergeRequest') &&
      text.includes('issue: (args) => fetchGitLabIssue') &&
      text.includes('listAssignableUsers: (args) => fetchGitLabAssignableUsers')
  },
  {
    name: 'Go provider preserves GitHub and self-hosted GitLab rate-limit semantics',
    file: 'runtime/go/internal/providercli/provider_rate_limit.go',
    expect: (text) =>
      text.includes('func GetGitHubRateLimit') &&
      text.includes('func GetGitLabRateLimit') &&
      text.includes('"gh", "", "api", "rate_limit"') &&
      text.includes('"api", "-i"') &&
      text.includes('providerRateLimitCacheTTL = 30 * time.Second') &&
      text.includes('gitLabRateLimitCacheMaxEntries = 64') &&
      text.includes('parseFinalHTTPHeaders')
  },
  {
    name: 'Go provider owns GitHub and GitLab viewer and auth diagnostics',
    file: 'runtime/go/internal/providercli/provider_identity.go',
    expect: (text) =>
      text.includes('func GetGitHubViewer') &&
      text.includes('func DiagnoseGitHubAuth') &&
      text.includes('parseGitHubAuthAccounts') &&
      text.includes('func GetGitLabViewer') &&
      text.includes('func DiagnoseGitLabAuth') &&
      text.includes('parseGitLabAuthHosts')
  },
  {
    name: 'Go runtime and Tauri expose provider rate limits without web fallbacks',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes('api.gh = {') &&
      text.includes('api.gl = {') &&
      text.includes('fetchGitHubRateLimit(readProviderJson, args)') &&
      text.includes('fetchGitLabRateLimit(readProviderJson, args)')
  },
  {
    name: 'Tauri preload replaces web-null provider identity and auth diagnostics',
    file: 'apps/desktop/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes('viewer: () => fetchGitHubViewer(readProviderJson)') &&
      text.includes('diagnoseAuth: () => fetchGitHubAuthDiagnostic(readProviderJson)') &&
      text.includes('viewer: () => fetchGitLabViewer(readProviderJson)') &&
      text.includes('diagnoseAuth: () => fetchGitLabAuthDiagnostic(readProviderJson)')
  },
  {
    name: 'Tauri runtime dispatcher maps provider rate-limit calls to Go',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('case "github.rateLimit":') &&
      text.includes('fetchGitHubRateLimit(getProviderJson') &&
      text.includes('case "gitlab.rateLimit":') &&
      text.includes('fetchGitLabRateLimit(getProviderJson')
  },
  {
    name: 'Tauri runtime dispatcher maps provider identity and auth diagnostics to Go',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('case "github.viewer":') &&
      text.includes('case "github.diagnoseAuth":') &&
      text.includes('case "gitlab.viewer":') &&
      text.includes('case "gitlab.diagnoseAuth":')
  },
  {
    name: 'Go runtime registers GitHub and GitLab rate-limit routes',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/providers/github/rate-limit"') &&
      text.includes('"/v1/providers/gitlab/rate-limit"')
  },
  {
    name: 'Go runtime registers provider identity and auth diagnostic routes',
    file: 'runtime/go/internal/runtimehttp/server.go',
    expect: (text) =>
      text.includes('"/v1/providers/github/viewer"') &&
      text.includes('"/v1/providers/github/auth-diagnostic"') &&
      text.includes('"/v1/providers/gitlab/viewer"') &&
      text.includes('"/v1/providers/gitlab/auth-diagnostic"')
  },
  {
    name: 'Tauri main windows authorize native titlebar dragging',
    file: 'apps/desktop/src-tauri/capabilities/main.json',
    expect: (text) =>
      text.includes('"core:window:allow-start-dragging"') &&
      text.includes('"core:window:allow-toggle-maximize"') &&
      text.includes('"main"') &&
      text.includes('"optimized"')
  },
  {
    name: 'Tauri Windows blocks or fulfills platform-owned browser subresources',
    file: 'apps/desktop/src-tauri/src/commands/browser_subresource_interception_windows.rs',
    expect: (text) =>
      text.includes('WebResourceRequestedEventHandler') &&
      text.includes('AddWebResourceRequestedFilter') &&
      text.includes('COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT') &&
      text.includes('intercept_resource') &&
      text.includes('NativeBrowserInterceptDecision::Fulfill') &&
      text.includes('CreateStreamOnHGlobal') &&
      text.includes('Content-Type: {content_type}') &&
      text.includes('CreateWebResourceResponse') &&
      text.includes('args.SetResponse') &&
      text.includes('"script"') &&
      text.includes('"image"') &&
      text.includes('"font"')
  },
  {
    name: 'Tauri browser RPC stays split into bounded domain modules',
    file: 'apps/desktop/src/tauri-browser-runtime-rpc.ts',
    expect: (text) =>
      text.includes("from './tauri-browser-capture-rpc'") &&
      text.includes("from './tauri-browser-page-control-rpc'") &&
      text.includes("from './tauri-browser-profile-tab-rpc'") &&
      !text.includes('async function saveBrowserCapture') &&
      !text.includes('async function listBrowserProfiles')
  },
  {
    name: 'Tauri Android provider executes native input rotation and bounded logs',
    file: 'apps/desktop/src-tauri/src/commands/emulator_android_provider.rs',
    expect: (text) =>
      text.includes('fn run_tap') &&
      text.includes('fn run_swipe') &&
      text.includes('fn run_press_key') &&
      text.includes('fn run_type') &&
      text.includes('fn run_rotate') &&
      text.includes('fn run_logs') &&
      text.includes('AdbCommand::LogcatSnapshot') &&
      !text.includes('run_gesture_gap') &&
      !text.includes('run_press_key_gap') &&
      !text.includes('run_type_gap') &&
      !text.includes('run_logs_gap')
  },
  {
    name: 'Tauri iOS provider owns bounded logs, input, and accessibility',
    file: 'apps/desktop/src-tauri/src/commands/emulator_ios_provider.rs',
    expect: (text) =>
      text.includes('fn run_logs') &&
      text.includes('SimctlCommand::LogsSnapshot') &&
      text.includes('"logsSnapshot".to_string()') &&
      text.includes('fn run_exec') &&
      text.includes('fn parse_exec_request') &&
      text.includes('fn run_native_exec') &&
      text.includes('ServeSimInputCommand::CoreAnimationDebug') &&
      text.includes('ServeSimInputCommand::MemoryWarning') &&
      text.includes('fn run_accessibility') &&
      text.includes('"accessibilityTree".to_string()') &&
      text.includes('const OUTPUT_LIMIT: u64 = 10 * 1024 * 1024') &&
      !text.includes('run_exec_gap') &&
      !text.includes('run_logs_gap') &&
      !text.includes('run_accessibility_gap')
  },
  {
    name: 'Tauri bundles the native iOS simulator helper',
    file: 'apps/desktop/src-tauri/tauri.conf.json',
    expect: (text) =>
      text.includes('node_modules/serve-sim/bin/serve-sim-bin') &&
      text.includes('serve-sim/serve-sim-bin')
  },
  {
    name: 'Tauri sends iOS input directly to the native helper',
    file: 'apps/desktop/src-tauri/src/commands/emulator_ios_input.rs',
    expect: (text) =>
      text.includes('connect_async') &&
      text.includes('TOUCH_OPCODE') &&
      text.includes('BUTTON_OPCODE') &&
      text.includes('KEYBOARD_OPCODE') &&
      text.includes('ROTATE_OPCODE') &&
      text.includes('CORE_ANIMATION_DEBUG_OPCODE') &&
      text.includes('MEMORY_WARNING_OPCODE') &&
      !text.includes('Command::new')
  },
  {
    name: 'native WSL provider rate-limit commands',
    file: 'apps/desktop/src-tauri/src/main.rs',
    expect: (text) =>
      text.includes('commands::rate_limits::rate_limits_fetch_claude_wsl') &&
      text.includes('commands::rate_limits::rate_limits_fetch_codex_wsl') &&
      text.includes('commands::rate_limits::rate_limits_consume_codex_reset_credit_wsl')
  },
  {
    name: 'renderer WSL provider rate-limit routing',
    file: 'apps/desktop/src/tauri-rate-limits-api.ts',
    expect: (text) =>
      text.includes('rate_limits_fetch_claude_wsl') &&
      text.includes('rate_limits_fetch_codex_wsl') &&
      text.includes('rate_limits_consume_codex_reset_credit_wsl') &&
      !text.includes('WSL rate-limit targets are not yet supported')
  },
  {
    name: 'Tauri reads Kimi usage natively without rotating CLI credentials',
    file: 'apps/desktop/src-tauri/src/commands/rate_limits.rs',
    expect: (text) =>
      text.includes('pub async fn rate_limits_fetch_kimi') &&
      text.includes('join(".kimi-code")') &&
      text.includes('join("kimi-code.json")') &&
      text.includes('map_kimi_usage_response') &&
      text.includes('KIMI_CODE_BASE_URL') &&
      text.includes('The Kimi CLI owns refresh-token rotation')
  },
  {
    name: 'renderer merges native Kimi usage into canonical rate-limit state',
    file: 'apps/desktop/src/tauri-rate-limits-api.ts',
    expect: (text) =>
      text.includes('rate_limits_fetch_kimi') &&
      text.includes('refreshes.push(fetchKimi())') &&
      text.includes('failedProvider("kimi", error)')
  },
  {
    name: 'Tauri owns bounded OpenCode Go auth and React Flight usage parsing',
    file: 'apps/desktop/src-tauri/src/commands/rate_limits_opencode.rs',
    expect: (text) =>
      text.includes('pub async fn rate_limits_fetch_opencode_go') &&
      text.includes('filter_auth_cookie') &&
      text.includes('parse_workspace_ids') &&
      text.includes('map_opencode_usage_page') &&
      text.includes('MAX_RESPONSE_BYTES') &&
      text.includes('monthlyUsage')
  },
  {
    name: 'renderer routes configured OpenCode Go usage through the native command',
    file: 'apps/desktop/src/tauri-rate-limits-api.ts',
    expect: (text) =>
      text.includes('rate_limits_fetch_opencode_go') &&
      text.includes('settings.opencodeSessionCookie') &&
      text.includes('settings.opencodeWorkspaceId') &&
      text.includes('limits.provider === "opencode-go" ? "opencodeGo"') &&
      !text.includes('gemini/minimax/opencodeGo: GAP')
  },
  {
    name: 'Tauri stores MiniMax credentials outside renderer persistence',
    file: 'apps/desktop/src-tauri/src/commands/minimax_credentials.rs',
    expect: (text) =>
      text.includes('KEYRING_SERVICE: &str = "nebutra.pebble.minimax"') &&
      text.includes('minimax_credentials_save_cookie') &&
      text.includes('minimax_credentials_clear_cookie') &&
      text.includes('pub fn read_cookie()')
  },
  {
    name: 'Tauri fetches MiniMax usage with native browser-compatible semantics',
    file: 'apps/desktop/src-tauri/src/commands/rate_limits_minimax.rs',
    expect: (text) =>
      text.includes('pub async fn rate_limits_fetch_minimax') &&
      text.includes('minimax_group_id_v2') &&
      text.includes('cookie_value(&cookie, "_token")') &&
      text.includes('browser_user_agent()') &&
      text.includes('map_minimax_usage') &&
      text.includes('window_minutes: 300')
  },
  {
    name: 'renderer exposes native MiniMax credential and refresh APIs',
    file: 'apps/desktop/src/tauri-rate-limits-api.ts',
    expect: (text) =>
      text.includes('rate_limits_fetch_minimax') &&
      text.includes('settings.minimaxGroupId') &&
      text.includes('settings.minimaxUsageModels') &&
      text.includes('refreshMiniMax: async') &&
      !text.includes('MiniMax usage needs the persisted session-cookie store')
  },
  {
    name: 'Tauri owns opt-in Gemini OAuth refresh and quota bucket mapping',
    file: 'apps/desktop/src-tauri/src/commands/rate_limits_gemini.rs',
    expect: (text) =>
      text.includes('pub async fn rate_limits_fetch_gemini') &&
      text.includes('extract_client_credentials') &&
      text.includes('refresh_access_token') &&
      text.includes('save_refreshed_credentials') &&
      text.includes('load_project_id') &&
      text.includes('map_quota_response') &&
      text.includes('Gemini CLI OAuth is disabled in settings')
  },
  {
    name: 'renderer includes native Gemini in canonical provider refresh',
    file: 'apps/desktop/src/tauri-rate-limits-api.ts',
    expect: (text) =>
      text.includes('refreshes.push(fetchGemini())') &&
      text.includes('rate_limits_fetch_gemini') &&
      text.includes('settings.geminiCliOAuthEnabled === true') &&
      !text.includes('gemini: GAP')
  },
  {
    name: 'Tauri advertises implemented browser binary streaming',
    file: 'apps/desktop/src/pebble-tauri-runtime-control-api.ts',
    expect: (text) =>
      text.includes('const TAURI_RUNTIME_CAPABILITIES = RUNTIME_CAPABILITIES') &&
      text.includes('capabilities: [...TAURI_RUNTIME_CAPABILITIES]')
  },
  {
    name: 'Tauri browser screencast uses raw Channel frames with ACK backpressure',
    file: 'apps/desktop/src-tauri/src/commands/browser_screencast.rs',
    expect: (text) =>
      text.includes('Channel<InvokeResponseBody>') &&
      text.includes('InvokeResponseBody::Raw(frame)') &&
      text.includes('acknowledged_seq') &&
      text.includes('last_image.as_deref() == Some(bytes.as_slice())') &&
      text.includes('control.dirty.swap(false, Ordering::AcqRel)') &&
      text.includes('DIRTY_POLL_INTERVAL') &&
      text.includes('SAFETY_CAPTURE_INTERVAL') &&
      text.includes('browser_screencast_mark_dirty') &&
      text.includes('browser_screencast_stop')
  },
  {
    name: 'browser WebViews mark screencasts dirty from document visual changes',
    file: 'apps/desktop/src-tauri/src/commands/browser_screencast_dirty.rs',
    expect: (text) =>
      text.includes('MutationObserver') &&
      text.includes("invoke('browser_screencast_mark_dirty')") &&
      text.includes('document.getAnimations') &&
      text.includes('timeupdate') &&
      text.includes('requestAnimationFrame')
  },
  {
    name: 'renderer forwards browser screencast without base64 serialization',
    file: 'apps/desktop/src/tauri-browser-screencast-channel.ts',
    expect: (text) =>
      text.includes('new Channel<ArrayBuffer>') &&
      text.includes('browser_screencast_forward_frame') &&
      text.includes('browser_screencast_ack') &&
      text.includes('rebindRuntimeScreencasts')
  },
  {
    name: 'Go browser screencast relay keeps only the newest pending frame',
    file: 'runtime/go/internal/runtimehttp/browser_screencast_frames.go',
    expect: (text) =>
      text.includes('frames: make(chan []byte, 1)') &&
      text.includes('case <-sink.frames:') &&
      text.includes('validBrowserScreencastFrame')
  },
  {
    name: 'Tauri browser video recording uses native codec and bounded chunk sinks',
    file: 'apps/desktop/src/tauri-browser-video-recording.ts',
    expect: (text) =>
      text.includes('new MediaRecorder') &&
      text.includes('startTauriBrowserScreencast') &&
      text.includes('browser_video_recording_append') &&
      text.includes('files.writeBase64Chunk') &&
      text.includes('files.commitUpload') &&
      text.includes('rebindRecording')
  },
  {
    name: 'Rust browser video writer publishes local output atomically',
    file: 'apps/desktop/src-tauri/src/commands/browser_video_recording.rs',
    expect: (text) =>
      text.includes('InvokeBody::Raw') &&
      text.includes('create_new(true)') &&
      text.includes('sync_all()') &&
      text.includes('fs::rename') &&
      text.includes('ReplaceFileW') &&
      text.includes('REPLACEFILE_WRITE_THROUGH')
  },
  {
    name: 'Go and SSH browser recording uploads atomically replace completed output',
    file: 'runtime/go/internal/runtimecore/files.go',
    expect: (text) =>
      text.includes('func (m *Manager) CommitUpload') &&
      text.includes('Operation: "commit-upload"') &&
      text.includes('replaceRemoteWorkspaceFile(source, destination)')
  },
  {
    name: 'Tauri file RPC uses the dedicated atomic upload commit route',
    file: 'apps/desktop/src/tauri-file-runtime-rpc.ts',
    expect: (text) => text.includes("'/v1/files/commit-upload'")
  },
  {
    name: 'agent-browser record CLI routes to Tauri recording actions',
    file: 'apps/desktop/src/tauri-browser-exec-rpc.ts',
    expect: (text) =>
      text.includes('runBrowserVideoRecording') &&
      text.includes('browser.recordingStart') &&
      text.includes('browser.recordingStop') &&
      text.includes('.webm or .mp4')
  },
  {
    name: 'Tauri deep-link listener is installed before renderer-ready drain',
    file: 'apps/desktop/src/tauri-deep-link-api.ts',
    expect: (text) => {
      const listenIndex = text.indexOf('await listen<string>(DEEP_LINK_EVENT')
      const drainIndex = text.indexOf("await invoke<string[]>('deep_link_initial_urls')")
      return listenIndex >= 0 && drainIndex > listenIndex
    }
  },
  {
    name: 'Tauri routes SSH agent trust to the paired runtime without local fallback',
    file: 'apps/desktop/src/tauri-agent-trust-api.ts',
    expect: (text) =>
      text.includes('agentTrust.markTrusted') &&
      text.includes('runtimeEnvironments.call') &&
      text.includes('if (!connectionId)') &&
      text.includes('agent_trust_mark_trusted')
  },
  {
    name: 'Go encrypted runtime owns remote agent trust artifacts',
    file: 'runtime/go/internal/runtimehttp/legacy_shared_control_agent_trust.go',
    expect: (text) =>
      text.includes('method != "agentTrust.markTrusted"') &&
      text.includes('MarkAgentWorkspaceTrusted') &&
      text.includes('map[string]bool{"trusted": true}')
  },
  {
    name: 'background agent trust preserves the SSH owner connection',
    file: 'packages/product-core/renderer/src/lib/launch-agent-background-session.ts',
    expect: (text) =>
      text.includes('repo?.connectionId') && text.includes('connectionId: repo.connectionId')
  },
  {
    name: 'Tauri queues pre-renderer deep links without lossy early emit',
    file: 'apps/desktop/src-tauri/src/commands/deep_link.rs',
    expect: (text) =>
      text.includes('queue.push_pending(urls)') &&
      text.includes('drain_and_mark_ready') &&
      text.includes('if !queue.renderer_ready') &&
      text.includes('drop(queue)')
  },
  {
    name: 'Tauri local runtime uses one authenticated process-lifetime boundary',
    file: 'apps/desktop/src/runtime-bridge.ts',
    expect: (text) =>
      text.includes("from './local-runtime-auth'") &&
      text.includes('bearerToken: input.bearerToken ?? LOCAL_RUNTIME_BEARER_TOKEN') &&
      text.includes('bearerToken: LOCAL_RUNTIME_BEARER_TOKEN')
  },
  {
    name: 'Tauri browser children cannot inherit parent renderer command capabilities',
    file: 'apps/desktop/src-tauri/capabilities/main.json',
    expect: (text) =>
      text.includes('"windows": ["main", "optimized"]') &&
      text.includes('"webviews": ["main", "optimized"]') &&
      !text.includes('browser-*')
  },
  {
    name: 'Tauri starts native emulator providers and maps the product control surface',
    file: 'apps/desktop/src/tauri-emulator-runtime-rpc.ts',
    expect: (text) =>
      text.includes("case 'emulator.attach':") &&
      text.includes("case 'emulator.shutdown':") &&
      text.includes("case 'emulator.tap':") &&
      text.includes("case 'emulator.exec':") &&
      text.includes('streamUrl: `scrcpy://${nativeId}`') &&
      text.includes("{ method: 'DELETE' }")
  }
]

const failures = []

for (const check of checks) {
  const files = check.files ?? [check.file]
  const text = (
    await Promise.all(files.map((file) => readFile(resolve(repoRoot, file), 'utf8')))
  ).join('\n')
  if (!matchesAcrossQuoteStyles(check, text)) {
    failures.push(`${check.name}: ${files.join(', ')}`)
  }
}

const sourceFiles = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: repoRoot, encoding: 'utf8' }
)
  .split('\0')
  .filter(Boolean)
const legacyBrandFiles = await scanLegacyBrandIdentifiers(repoRoot, sourceFiles)
if (legacyBrandFiles.length > 0) {
  failures.push(
    `Working source still contains legacy product identifiers: ${legacyBrandFiles.join(', ')}`
  )
}

const tauriRendererTsxFiles = await listFiles(resolve(repoRoot, 'apps/desktop/src')).then((files) =>
  files
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => file.replace(`${resolve(repoRoot)}/`, ''))
    .sort()
)
const allowedTauriRendererTsxFiles = [
  'apps/desktop/src/main.tsx',
  'apps/desktop/src/renderer-entry.tsx'
]
const localTauriUiFiles = tauriRendererTsxFiles.filter(
  (file) => !allowedTauriRendererTsxFiles.includes(file)
)
if (localTauriUiFiles.length > 0) {
  failures.push(
    `Tauri must mount the canonical renderer, not local mock UI. Unexpected TSX files: ${localTauriUiFiles.join(', ')}`
  )
}

const tauriSourceFiles = await listFiles(resolve(repoRoot, 'apps/desktop/src')).then((files) =>
  files.filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
)
const electronMainImports = []
const electronMainRoot = resolve(repoRoot, 'migration/electron-reference/src/main')
const shellIndependentConsumerFiles = [
  ...tauriSourceFiles,
  ...(await listFiles(resolve(repoRoot, 'packages/product-core/renderer/src')).then((files) =>
    files.filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
  ))
]
for (const file of shellIndependentConsumerFiles) {
  const text = await readFile(file, 'utf8')
  const importPattern = /(?:from\s*|import\s*)["']([^"']+)["']/g
  for (const match of text.matchAll(importPattern)) {
    const importedModule = match[1]
    const resolvedImport = importedModule.startsWith('.')
      ? resolve(file, '..', importedModule)
      : null
    const relativeToElectronMain = resolvedImport
      ? relative(electronMainRoot, resolvedImport)
      : null
    const resolvesInsideElectronMain =
      relativeToElectronMain !== null &&
      relativeToElectronMain !== '..' &&
      !relativeToElectronMain.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      !isAbsolute(relativeToElectronMain)
    if (
      importedModule.includes('migration/electron-reference/src/main') ||
      importedModule.startsWith('@main') ||
      resolvesInsideElectronMain
    ) {
      electronMainImports.push(`${file.replace(`${resolve(repoRoot)}/`, '')}: ${importedModule}`)
    }
  }
}
if (electronMainImports.length > 0) {
  failures.push(
    `Tauri and canonical renderer code must not import Electron main modules. Move shell-neutral logic to packages/product-core/shared: ${electronMainImports.join(', ')}`
  )
}

const rendererSourceFiles = await listFiles(
  resolve(repoRoot, 'packages/product-core/renderer/src')
).then((files) => files.filter((file) => file.endsWith('.ts') || file.endsWith('.tsx')))
const legacyPreloadContractImports = []
for (const file of [...tauriSourceFiles, ...rendererSourceFiles]) {
  const text = await readFile(file, 'utf8')
  if (text.includes('preload/api-types')) {
    legacyPreloadContractImports.push(file.replace(`${resolve(repoRoot)}/`, ''))
  }
}
if (legacyPreloadContractImports.length > 0) {
  failures.push(
    `Product consumers must import shell-neutral API contracts from packages/product-core/shared: ${legacyPreloadContractImports.join(', ')}`
  )
}

const tauriExternalImportSource = await readFile(
  resolve(repoRoot, 'apps/desktop/src/tauri-external-file-import-api.ts'),
  'utf8'
)
const tauriExternalImportRust = await readFile(
  resolve(
    repoRoot,
    'apps/desktop/src-tauri/src/commands/filesystem_external_import.rs'
  ),
  'utf8'
)
const runtimeFileClientSource = await readFile(
  resolve(repoRoot, 'packages/product-core/renderer/src/runtime/runtime-file-client.ts'),
  'utf8'
)
if (
  !tauriExternalImportSource.includes('fs_import_external_paths') ||
  !tauriExternalImportSource.includes('fs_stage_external_paths') ||
  !tauriExternalImportRust.includes('MAX_TOTAL_BYTES') ||
  !runtimeFileClientSource.includes('legacySshRuntime')
) {
  failures.push(
    'Tauri external file import must use bounded Rust staging and the Go relay runtime instead of web empty-result fallbacks'
  )
}

const runtimeControlSource = await readFile(
  resolve(repoRoot, 'apps/desktop/src/pebble-tauri-runtime-control-api.ts'),
  'utf8'
)
const runtimeControlMethods = new Set(
  [...runtimeControlSource.matchAll(/case\s+"([^"]+)"/g)].map((match) => match[1])
)
const sharedControlProductionFiles = (
  await listFiles(resolve(repoRoot, 'runtime/go/internal/runtimehttp'))
).filter((file) => file.endsWith('.go') && !file.endsWith('_test.go'))
const sharedControlProductionSource = (
  await Promise.all(sharedControlProductionFiles.map((file) => readFile(file, 'utf8')))
).join('\n')
const sharedControlMethods = new Set(
  [...sharedControlProductionSource.matchAll(/"([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+)"/g)].map(
    (match) => match[1]
  )
)
// Why: these methods mutate the controlling desktop's UI, OS permissions, or
// saved SSH targets; executing them on a paired runtime would target the wrong host.
const controllerOnlyRuntimeMethods = new Set([
  'computer.permissions',
  'computer.permissionsStatus',
  'preflight.detectRemoteAgents',
  'preflight.detectRemoteWindowsTerminalCapabilities',
  'worktree.activate'
])
const missingSharedControlMethods = [...runtimeControlMethods]
  .filter(
    (method) => !sharedControlMethods.has(method) && !controllerOnlyRuntimeMethods.has(method)
  )
  .sort()
if (missingSharedControlMethods.length > 0) {
  failures.push(
    `Paired runtime control is missing production handlers: ${missingSharedControlMethods.join(', ')}`
  )
}

const notebookBridge = await readFile(
  resolve(repoRoot, 'apps/desktop/src/tauri-notebook-api.ts'),
  'utf8'
)
const notebookSharedControl = await readFile(
  resolve(repoRoot, 'runtime/go/internal/runtimehttp/legacy_shared_control_notebook.go'),
  'utf8'
)
const sharedControlLoop = await readFile(
  resolve(repoRoot, 'runtime/go/internal/runtimehttp/legacy_shared_control.go'),
  'utf8'
)
if (
  !notebookBridge.includes('window.api.runtimeEnvironments.call') ||
  !notebookBridge.includes("method: 'notebook.runPythonCell'") ||
  !notebookBridge.includes('if (connectionId)')
) {
  failures.push('Notebook bridge must route connected workspaces through paired runtime RPC')
}
if (
  !notebookSharedControl.includes('request.ConnectionID = nil') ||
  !notebookSharedControl.includes('RunNotebookPythonCell(ctx, request)')
) {
  failures.push('Paired Notebook execution must stay on the owning workspace host')
}
if (
  !sharedControlLoop.includes('request.Method == "notebook.runPythonCell"') ||
  !sharedControlLoop.includes('go s.handleLegacySharedControlNotebook(ctx')
) {
  failures.push('Paired Notebook execution must be cancellable without blocking shared RPCs')
}

const workspaceCleanupBridge = await readFile(
  resolve(repoRoot, 'apps/desktop/src/tauri-workspace-cleanup-api.ts'),
  'utf8'
)
const workspaceCleanupSharedControl = await readFile(
  resolve(repoRoot, 'runtime/go/internal/runtimehttp/legacy_shared_control_workspace_cleanup.go'),
  'utf8'
)
if (
  !workspaceCleanupBridge.includes('resolveCleanupConnectionIds(args)') ||
  !workspaceCleanupBridge.includes('workspaceCleanup.scan') ||
  !workspaceCleanupBridge.includes('workspaceCleanup.processes') ||
  !workspaceCleanupBridge.includes('attachCleanupConnection')
) {
  failures.push('Workspace cleanup must aggregate scans and process checks on owning SSH runtimes')
}
if (
  !workspaceCleanupSharedControl.includes('case "workspaceCleanup.scan"') ||
  !workspaceCleanupSharedControl.includes('case "workspaceCleanup.processes"') ||
  !workspaceCleanupSharedControl.includes('request.ConnectionID = nil') ||
  !sharedControlLoop.includes('go s.handleLegacySharedControlWorkspaceCleanup(ctx')
) {
  failures.push('Paired workspace cleanup must execute and cancel on the workspace host')
}

const remoteWorkspaceBridge = await readFile(
  resolve(repoRoot, 'apps/desktop/src/tauri-remote-workspace-api.ts'),
  'utf8'
)
const remoteWorkspaceRelay = await readFile(
  resolve(repoRoot, 'runtime/go/cmd/pebble-relay-worker/main.go'),
  'utf8'
)
const remoteWorkspaceWatch = await readFile(
  resolve(repoRoot, 'runtime/go/internal/runtimehttp/remote_workspace_watch.go'),
  'utf8'
)
if (
  !remoteWorkspaceRelay.includes('workspace-watch-json') ||
  !remoteWorkspaceRelay.includes('streamRemoteWorkspaceChanges') ||
  !remoteWorkspaceWatch.includes('StreamSshRemoteWorkspace') ||
  !remoteWorkspaceWatch.includes('"workspace.changed"') ||
  !remoteWorkspaceWatch.includes('"workspace.watch-status"')
) {
  failures.push('Remote workspace changes must stream from the SSH relay into Go runtime events')
}
if (
  !remoteWorkspaceBridge.includes('subscribeRuntimeEventPush') ||
  !remoteWorkspaceBridge.includes('workspace.watch-status') ||
  !remoteWorkspaceBridge.includes('needsPolling') ||
  !remoteWorkspaceBridge.includes('releaseTargetWatch') ||
  !remoteWorkspaceBridge.includes('scheduleTargetWatchRetry')
) {
  failures.push('Tauri remote workspace sync must prefer push and bound polling to outages')
}

const localhostLabelRoute = await readFile(
  resolve(repoRoot, 'packages/product-core/renderer/src/lib/workspace-port-localhost-label.ts'),
  'utf8'
)
const localhostLabelProxy = await readFile(
  resolve(repoRoot, 'runtime/go/internal/runtimehttp/localhost_label_proxy.go'),
  'utf8'
)
const sshPortForwards = await readFile(
  resolve(repoRoot, 'runtime/go/internal/runtimecore/ssh_port_forwards.go'),
  'utf8'
)
if (
  !localhostLabelRoute.includes('connectionId: repo.connectionId') ||
  !localhostLabelRoute.includes('remoteHost: port.connectHost') ||
  !localhostLabelRoute.includes('remotePort: port.port') ||
  !localhostLabelProxy.includes('EnsureSshLocalhostLabelForward') ||
  !localhostLabelProxy.includes('upstreamHost')
) {
  failures.push('Remote localhost labels must retain SSH ownership and advertised Host semantics')
}
if (
  !sshPortForwards.includes('DetectSshPorts') ||
  !sshPortForwards.includes('sshLabelPortIsAdvertised') ||
  !sshPortForwards.includes('localhostLabelForwards') ||
  !sshPortForwards.includes('TerminateSshPortForwards')
) {
  failures.push('Remote localhost labels must use allowlisted transient SSH forwards')
}

const tauriConfig = JSON.parse(
  await readFile(resolve(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')
)
const mainCapability = JSON.parse(
  await readFile(resolve(repoRoot, 'apps/desktop/src-tauri/capabilities/main.json'), 'utf8')
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
for (const permission of [
  'core:webview:allow-set-webview-position',
  'core:webview:allow-set-webview-size',
  'core:webview:allow-webview-close',
  'core:webview:allow-webview-hide',
  'core:webview:allow-webview-show'
]) {
  if (!mainCapability.permissions?.includes(permission)) {
    failures.push(`Tauri browser child lifecycle requires ${permission}`)
  }
}

const runtimeEndpoint = await readFile(
  resolve(repoRoot, 'apps/desktop/src/local-runtime-endpoint.ts'),
  'utf8'
)
const runtimeProcess = await readFile(
  resolve(repoRoot, 'apps/desktop/src-tauri/src/commands/runtime_process.rs'),
  'utf8'
)
const runtimeMain = await readFile(
  resolve(repoRoot, 'runtime/go/cmd/pebble-runtime/main.go'),
  'utf8'
)
const runtimeWindowsParentMonitor = await readFile(
  resolve(repoRoot, 'runtime/go/cmd/pebble-runtime/parent_monitor_windows.go'),
  'utf8'
)
const terminationSignal = await readFile(
  resolve(repoRoot, 'apps/desktop/src-tauri/src/termination_signal.rs'),
  'utf8'
)
const realRuntimeGate = await readFile(
  resolve(repoRoot, 'config/scripts/run-tauri-real-runtime-gate.mjs'),
  'utf8'
)
const tauriPreload = await readFile(
  resolve(repoRoot, 'apps/desktop/src/pebble-tauri-preload-api.ts'),
  'utf8'
)
const tauriGitRuntime = await readFile(
  resolve(repoRoot, 'apps/desktop/src/tauri-git-runtime-rpc.ts'),
  'utf8'
)
const tauriNativeChat = await readFile(
  resolve(repoRoot, 'apps/desktop/src/tauri-native-chat-api.ts'),
  'utf8'
)
const nativeChatTranscript = await readFile(
  resolve(
    repoRoot,
    'apps/desktop/src-tauri/src/commands/native_chat_transcript.rs'
  ),
  'utf8'
)
const nativeSessionRecovery = await readFile(
  resolve(
    repoRoot,
    'apps/desktop/src-tauri/src/commands/native_session_recovery.rs'
  ),
  'utf8'
)
const tauriTelemetry = await readFile(
  resolve(repoRoot, 'apps/desktop/src-tauri/src/commands/telemetry.rs'),
  'utf8'
)
const tauriLinear = await readFile(
  resolve(repoRoot, 'apps/desktop/src-tauri/src/commands/linear.rs'),
  'utf8'
)
const tauriE2E = await readFile(resolve(repoRoot, 'apps/desktop/src/tauri-e2e-api.ts'), 'utf8')
if (
  !runtimeEndpoint.includes('VITE_PEBBLE_RUNTIME_URL') ||
  !runtimeEndpoint.includes('VITE_PEBBLE_RUNTIME_DATA_DIR') ||
  !runtimeEndpoint.includes('isLoopbackHost')
) {
  failures.push('Local runtime endpoint overrides must remain loopback-only and data-dir isolated')
}
if (
  !runtimeProcess.includes('PEBBLE_RUNTIME_PARENT_PID') ||
  !runtimeMain.includes('monitorDesktopParent') ||
  !runtimeWindowsParentMonitor.includes('windows.OpenProcess(windows.SYNCHRONIZE') ||
  !runtimeWindowsParentMonitor.includes('windows.WaitForSingleObject') ||
  !realRuntimeGate.includes('commandExecuted') ||
  !realRuntimeGate.includes('tauri:functional:shell')
) {
  failures.push('Tauri must retain parent-owned runtime cleanup and the real terminal gate')
}
if (
  !terminationSignal.includes('libc::SIGTERM') ||
  !terminationSignal.includes('TERMINATION_REQUESTED.store(true') ||
  !terminationSignal.includes('app.exit(0)')
) {
  failures.push('Tauri must route Unix termination signals through clean app shutdown')
}
if (
  !realRuntimeGate.includes('waitForCleanExit') ||
  !nativeSessionRecovery.includes('PEBBLE_FUNCTIONAL_GATE_EVIDENCE_PATH') ||
  !nativeSessionRecovery.includes('session_recovery_disabled')
) {
  failures.push(
    'Functional gates must exit cleanly without generating native crash recovery records'
  )
}
if (
  !tauriPreload.includes('createTauriGitRuntimeApi(api.git)') ||
  !tauriGitRuntime.includes('resolveRuntimeWorktreeId') ||
  !realRuntimeGate.includes('sourceControlProjected') ||
  !realRuntimeGate.includes('browserScreenshotBytes')
) {
  failures.push('Tauri must retain canonical Git path routing and real Browser/SCM gates')
}
if (
  !tauriPreload.includes('prChecks: (args) => fetchGitHubPRChecks(readProviderJson, args)') ||
  !tauriPreload.includes(
    'prForBranch: (args) => fetchGitHubPRForBranch(writeProviderJson, args)'
  ) ||
  !realRuntimeGate.includes('seedGitHubFixture') ||
  !realRuntimeGate.includes('checksProviderParsed') ||
  !realRuntimeGate.includes('checksPanelMounted') ||
  !realRuntimeGate.includes('hostedReviewNative') ||
  !realRuntimeGate.includes('nativeChatTranscriptRead') ||
  !tauriPreload.includes('api.hostedReview = {') ||
  !tauriPreload.includes("nativeGitHubRuntimeMethod('mergePR', 'github.mergePR')") ||
  !tauriPreload.includes("nativeGitHubRuntimeMethod('updateIssue', 'github.updateIssue')")
) {
  failures.push('Tauri must retain native GitHub PR APIs and the provider-backed Checks UI gate')
}
if (
  !tauriPreload.includes('api.nativeChat = createTauriNativeChatApi()') ||
  !tauriNativeChat.includes("invoke<NativeReadResult>('native_chat_read_session'") ||
  !tauriNativeChat.includes("listen<NativeAppendEvent>('native-chat-appended'") ||
  !nativeChatTranscript.includes('canonical_file_within_roots') ||
  !nativeChatTranscript.includes('RecommendedWatcher') ||
  !nativeChatTranscript.includes('app.path().app_data_dir()')
) {
  failures.push('Tauri native chat must retain secure native transcript reads and live watchers')
}
if (
  !tauriPreload.includes('api.linear = createPebbleLinearApi()') ||
  !tauriLinear.includes('keyring::Entry') ||
  !tauriLinear.includes('MAX_RESPONSE_BYTES') ||
  !tauriLinear.includes('REQUEST_TIMEOUT')
) {
  failures.push(
    'Tauri Linear must retain Keychain credentials and bounded native GraphQL transport'
  )
}
if (
  !tauriPreload.includes('api.telemetryTrack = telemetry.telemetryTrack') ||
  !tauriTelemetry.includes('DO_NOT_TRACK') ||
  !tauriTelemetry.includes('PEBBLE_TELEMETRY_DISABLED') ||
  !tauriTelemetry.includes('TRANSPORT_TIMEOUT')
) {
  failures.push('Tauri telemetry must retain native consent precedence and bounded transport')
}
if (
  !tauriPreload.includes('installTauriE2EApi(api, import.meta.env)') ||
  !tauriE2E.includes('delete (api as Partial<PreloadApi>).e2e')
) {
  failures.push('Tauri E2E controls must remain native in gates and absent from production')
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
import './verify-pebble-repository-layout.mjs'
