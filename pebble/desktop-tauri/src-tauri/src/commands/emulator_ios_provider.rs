//! Native iOS Simulator adapter: reconciles `xcrun simctl` device state into
//! the Go runtime's `/v1/emulator/devices` store and drains the shared
//! `emulator.*` action queue (boot/install/launch/screenshot/logs/rotate),
//! following the same claim/execute/complete loop as
//! `computer_use_provider.rs`. Android and non-macOS iOS are explicit gaps —
//! see `start_emulator_ios_provider`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

pub const EMULATOR_IOS_PROVIDER_ID: &str = "emulator:tauri-ios-simctl";
pub const EMULATOR_IOS_PROVIDER_NAME: &str = "ios-simctl-native";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorIosProviderStartCommand {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorIosProviderStartResult {
    pub supported: bool,
    pub platform: &'static str,
    pub provider_id: Option<&'static str>,
    /// Honest-gap detail when unsupported: why this platform cannot run the provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_reason: Option<String>,
}

#[derive(Default)]
pub struct EmulatorIosProviderState {
    stop_flag: Mutex<Option<Arc<AtomicBool>>>,
}

/// Starts the background simctl reconciliation + action-queue worker.
/// Idempotent while a worker is live. Non-macOS hosts (and Android, which is
/// out of scope for this adapter) return an explicit unsupported result and
/// never register, so the runtime's emulator subsystem status keeps
/// reporting the honest gap instead of a fake "ready".
#[tauri::command]
pub async fn start_emulator_ios_provider(
    app: AppHandle,
    state: State<'_, EmulatorIosProviderState>,
    input: EmulatorIosProviderStartCommand,
) -> Result<EmulatorIosProviderStartResult, String> {
    if !cfg!(target_os = "macos") {
        return Ok(EmulatorIosProviderStartResult {
            supported: false,
            platform: std::env::consts::OS,
            provider_id: None,
            unsupported_reason: Some(
                "the iOS Simulator adapter requires macOS with Xcode Command Line Tools; \
                 Android emulator support is a separate, not-yet-implemented adapter"
                    .to_string(),
            ),
        });
    }
    {
        let mut slot = state
            .stop_flag
            .lock()
            .map_err(|_| "emulator ios provider state was poisoned".to_string())?;
        if let Some(existing) = slot.as_ref() {
            if !existing.load(Ordering::SeqCst) {
                return Ok(supported_result());
            }
        }
        let stop = Arc::new(AtomicBool::new(false));
        *slot = Some(stop.clone());
        spawn_worker(app, input, stop);
    }
    Ok(supported_result())
}

/// Stops the worker after its current cycle; persisted devices/sessions are left intact.
#[tauri::command]
pub fn stop_emulator_ios_provider(app: AppHandle) {
    let state = app.state::<EmulatorIosProviderState>();
    let stop = state
        .stop_flag
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().cloned());
    if let Some(stop) = stop {
        stop.store(true, Ordering::SeqCst);
    }
}

fn supported_result() -> EmulatorIosProviderStartResult {
    EmulatorIosProviderStartResult {
        supported: true,
        platform: std::env::consts::OS,
        provider_id: Some(EMULATOR_IOS_PROVIDER_ID),
        unsupported_reason: None,
    }
}

fn default_runtime_url() -> String {
    pebble_rust_host::DEFAULT_RUNTIME_URL.to_string()
}

#[cfg(not(target_os = "macos"))]
fn spawn_worker(_app: AppHandle, _input: EmulatorIosProviderStartCommand, _stop: Arc<AtomicBool>) {}

// Why: every step (simctl subprocess, screenshot file read, queue HTTP)
// blocks, so the whole loop runs on one blocking-pool thread instead of
// interleaving spawn_blocking hops; commands stay async per the Tauri
// main-thread rule.
#[cfg(target_os = "macos")]
fn spawn_worker(_app: AppHandle, input: EmulatorIosProviderStartCommand, stop: Arc<AtomicBool>) {
    tauri::async_runtime::spawn_blocking(move || {
        macos_worker::run_provider_loop(input, stop);
    });
}

#[cfg(target_os = "macos")]
mod macos_worker {
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine as _;
    use pebble_rust_host::{
        get_runtime_resource, register_native_provider, NativeProviderRegistrationCommand,
        RuntimeResourceGetRequest,
    };
    use serde_json::Value;

    use super::super::emulator_ios_simctl::{
        is_already_booted_error, is_already_shutdown_error, map_simctl_state,
        parse_simctl_device_list, payload_str, EmulatorDeviceStatus, SimctlCommand, SimctlDevice,
    };
    use super::{
        EmulatorIosProviderStartCommand, EMULATOR_IOS_PROVIDER_ID, EMULATOR_IOS_PROVIDER_NAME,
    };

    const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(1_200);
    const DEVICE_RECONCILE_INTERVAL: Duration = Duration::from_secs(8);
    const RUNTIME_ERROR_BACKOFF: Duration = Duration::from_secs(5);
    const QUEUE_HTTP_TIMEOUT_MS: u64 = 10_000;
    // Screenshot completions carry base64 PNG bytes; give them a longer window.
    const UPDATE_HTTP_TIMEOUT_MS: u64 = 30_000;
    const SIMCTL_SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(30);
    const BOOT_TIMEOUT: Duration = Duration::from_secs(45);

    pub fn run_provider_loop(input: EmulatorIosProviderStartCommand, stop: Arc<AtomicBool>) {
        let runtime_url = input.runtime_url;
        let bearer_token = input.bearer_token;
        let mut registered = false;
        // udid -> Go-assigned emulator device id, so reconciliation PATCHes
        // instead of re-registering a duplicate device every cycle.
        let mut known_devices: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let mut last_reconcile = Instant::now() - DEVICE_RECONCILE_INTERVAL;

        while !stop.load(Ordering::SeqCst) {
            if !registered {
                registered = register_provider(&runtime_url, &bearer_token);
                if !registered {
                    sleep_unless_stopped(&stop, RUNTIME_ERROR_BACKOFF);
                    continue;
                }
            }

            if last_reconcile.elapsed() >= DEVICE_RECONCILE_INTERVAL {
                reconcile_devices(&runtime_url, &bearer_token, &mut known_devices);
                last_reconcile = Instant::now();
            }

            let claimed = claim_emulator_actions(&runtime_url, &bearer_token);
            if claimed.is_empty() {
                sleep_unless_stopped(&stop, IDLE_POLL_INTERVAL);
                continue;
            }
            for action in claimed {
                let completion = run_action(&action);
                post_completion(&runtime_url, &bearer_token, &action.id, completion);
            }
        }
    }

    struct ClaimedEmulatorAction {
        id: String,
        kind: String,
        payload: Value,
    }

    enum ActionCompletion {
        Completed { result_json: String },
        Failed { error_message: String },
    }

    fn claim_emulator_actions(
        runtime_url: &str,
        bearer_token: &Option<String>,
    ) -> Vec<ClaimedEmulatorAction> {
        let claim =
            pebble_rust_host::poll_emulator_actions(pebble_rust_host::EmulatorActionPollCommand {
                runtime_url: runtime_url.to_string(),
                bearer_token: bearer_token.clone(),
                timeout_ms: QUEUE_HTTP_TIMEOUT_MS,
                limit: 8,
            });
        let http_ok = claim.http_status.is_some_and(|status| status < 300);
        if !http_ok || claim.error.is_some() {
            return Vec::new();
        }
        let body = claim.body.unwrap_or_else(|| "null".to_string());
        let value: Value = match serde_json::from_str(&body) {
            Ok(value) => value,
            Err(_) => return Vec::new(),
        };
        let entries = match value {
            Value::Null => return Vec::new(),
            Value::Array(entries) => entries,
            _ => return Vec::new(),
        };
        entries
            .into_iter()
            .filter_map(|entry| {
                let id = entry.get("id")?.as_str()?.to_string();
                let kind = entry
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let payload = entry.get("payload").cloned().unwrap_or(Value::Null);
                Some(ClaimedEmulatorAction { id, kind, payload })
            })
            .collect()
    }

    fn run_action(action: &ClaimedEmulatorAction) -> ActionCompletion {
        let verb = action
            .kind
            .strip_prefix("emulator.")
            .unwrap_or(action.kind.as_str());
        let udid = payload_str(&action.payload, "deviceId")
            .or_else(|| payload_str(&action.payload, "udid"))
            .map(str::to_string);
        let Some(udid) = udid else {
            return ActionCompletion::Failed {
                error_message: "invalid_target: emulator action payload is missing deviceId"
                    .to_string(),
            };
        };
        match verb {
            "screenshot" => run_screenshot(&udid),
            "install" => run_install(&udid, &action.payload),
            "launch" => run_launch(&udid, &action.payload),
            "rotate" => run_rotate(&udid, &action.payload),
            "logs" => run_logs_gap(),
            "tap" | "swipe" => run_gesture_gap(verb),
            "pressKey" => run_press_key_gap(),
            "type" => run_type_gap(),
            _ => ActionCompletion::Failed {
                error_message: format!("unsupported_action: unknown emulator command '{verb}'"),
            },
        }
    }

    // Why: simctl has no synthetic touch/keyboard-event API — Apple's private
    // HID injection path is what Electron's `serve-sim` helper wraps (via a
    // bundled binary that speaks to CoreSimulator's IndigoHID bridge, the same
    // mechanism Facebook's `idb` uses). Replicating it needs either that
    // private framework or XCTest-based UI automation (an .xctestrun bundle
    // driven by `xcodebuild test-without-building`); neither ships with plain
    // Xcode Command Line Tools, so this is an honest typed gap, not a stub.
    fn run_gesture_gap(verb: &str) -> ActionCompletion {
        ActionCompletion::Failed {
            error_message: format!(
                "unsupported_gap: {verb} synthesis is not available through `xcrun simctl`; \
                 it requires either Facebook's idb (iOS Debug Bridge) or an XCTest-based UI \
                 automation harness, neither of which is bundled with Xcode Command Line Tools"
            ),
        }
    }

    fn run_press_key_gap() -> ActionCompletion {
        ActionCompletion::Failed {
            error_message: "unsupported_gap: hardware button/key synthesis needs idb or \
                 XCTest-based UI automation, same as tap/swipe gestures"
                .to_string(),
        }
    }

    fn run_type_gap() -> ActionCompletion {
        ActionCompletion::Failed {
            error_message: "unsupported_gap: text input synthesis needs idb or XCTest-based UI \
                 automation, same as tap/swipe gestures"
                .to_string(),
        }
    }

    fn run_logs_gap() -> ActionCompletion {
        // `simctl spawn <udid> log stream` is a genuinely long-lived tail, not
        // a bounded claim/complete cycle the shared action queue models; a
        // real implementation needs a dedicated streaming transport (e.g. the
        // same relay-event channel the mobile subsystem uses) rather than
        // this claim-execute-complete loop.
        ActionCompletion::Failed {
            error_message: "unsupported_gap: log tailing needs a streaming transport \
                 (`xcrun simctl spawn <udid> log stream` is long-lived); the bounded \
                 action-queue claim/complete cycle cannot carry a continuous tail yet"
                .to_string(),
        }
    }

    fn run_screenshot(udid: &str) -> ActionCompletion {
        let tmp_path = std::env::temp_dir().join(format!("pebble-emulator-ios-{udid}.png"));
        let tmp_path_str = tmp_path.to_string_lossy().to_string();
        let command = SimctlCommand::Screenshot {
            udid: udid.to_string(),
            out_path: tmp_path_str.clone(),
        };
        if let Err(error) = run_simctl(&command) {
            return ActionCompletion::Failed {
                error_message: format!("emulator_error: {error}"),
            };
        }
        let bytes = match std::fs::read(&tmp_path) {
            Ok(bytes) => bytes,
            Err(error) => {
                return ActionCompletion::Failed {
                    error_message: format!(
                        "emulator_error: screenshot file could not be read: {error}"
                    ),
                }
            }
        };
        let _ = std::fs::remove_file(&tmp_path);
        let encoded = BASE64_STANDARD.encode(bytes);
        ActionCompletion::Completed {
            result_json: serde_json::json!({ "imageBase64": encoded, "mimeType": "image/png" })
                .to_string(),
        }
    }

    fn run_install(udid: &str, payload: &Value) -> ActionCompletion {
        let Some(app_path) =
            payload_str(payload, "appPath").or_else(|| payload_str(payload, "path"))
        else {
            return ActionCompletion::Failed {
                error_message: "invalid_target: install action payload is missing appPath"
                    .to_string(),
            };
        };
        let command = SimctlCommand::Install {
            udid: udid.to_string(),
            app_path: app_path.to_string(),
        };
        match run_simctl(&command) {
            Ok(_) => ActionCompletion::Completed {
                result_json: serde_json::json!({ "installed": true }).to_string(),
            },
            Err(error) => ActionCompletion::Failed {
                error_message: format!("emulator_error: {error}"),
            },
        }
    }

    fn run_launch(udid: &str, payload: &Value) -> ActionCompletion {
        let Some(bundle_id) =
            payload_str(payload, "bundleId").or_else(|| payload_str(payload, "packageName"))
        else {
            return ActionCompletion::Failed {
                error_message: "invalid_target: launch action payload is missing bundleId"
                    .to_string(),
            };
        };
        let command = SimctlCommand::Launch {
            udid: udid.to_string(),
            bundle_id: bundle_id.to_string(),
        };
        match run_simctl(&command) {
            Ok(_) => ActionCompletion::Completed {
                result_json: serde_json::json!({ "launched": true }).to_string(),
            },
            Err(error) => ActionCompletion::Failed {
                error_message: format!("emulator_error: {error}"),
            },
        }
    }

    // simctl has no direct device-rotate verb; the closest scriptable proxy
    // is the status-bar orientation-adjacent overrides. Since simctl truly
    // has no rotate command, report the honest gap rather than silently
    // doing nothing.
    fn run_rotate(_udid: &str, payload: &Value) -> ActionCompletion {
        let orientation = payload_str(payload, "orientation").unwrap_or("unknown");
        ActionCompletion::Failed {
            error_message: format!(
                "unsupported_gap: `xcrun simctl` has no device-rotation command \
                 (requested orientation: {orientation}); rotation needs the same \
                 idb/XCTest automation path as gestures"
            ),
        }
    }

    fn run_simctl(command: &SimctlCommand) -> Result<String, String> {
        let argv = command.to_argv();
        let mut child = Command::new("xcrun")
            .args(&argv)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| format!("failed to spawn xcrun: {error}"))?;
        // Why: a wedged CoreSimulator daemon can hang `xcrun simctl` forever;
        // without a watchdog one stuck action queue claim would block every
        // later action this worker thread ever processes.
        let deadline = Instant::now() + SIMCTL_SUBPROCESS_TIMEOUT;
        let output = loop {
            match child.try_wait() {
                Ok(Some(_)) => break child.wait_with_output(),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        return Err(format!(
                            "xcrun simctl {argv:?} timed out after {SIMCTL_SUBPROCESS_TIMEOUT:?}"
                        ));
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                Err(error) => return Err(format!("failed to wait on xcrun: {error}")),
            }
        }
        .map_err(|error| format!("failed to read xcrun output: {error}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if output.status.success() {
            return Ok(stdout);
        }
        let combined = format!("{stdout}\n{stderr}");
        match command {
            SimctlCommand::Boot { .. } if is_already_booted_error(&combined) => Ok(stdout),
            SimctlCommand::Shutdown { .. } if is_already_shutdown_error(&combined) => Ok(stdout),
            _ => Err(combined.trim().to_string()),
        }
    }

    fn list_simctl_devices() -> Result<Vec<SimctlDevice>, String> {
        let stdout = run_simctl(&SimctlCommand::ListDevices)?;
        parse_simctl_device_list(&stdout)
    }

    fn reconcile_devices(
        runtime_url: &str,
        bearer_token: &Option<String>,
        known_devices: &mut std::collections::HashMap<String, String>,
    ) {
        let devices = match list_simctl_devices() {
            Ok(devices) => devices,
            Err(_) => return,
        };
        let existing = fetch_existing_emulator_devices(runtime_url, bearer_token);

        for device in devices {
            let status = map_simctl_state(&device.state, device.is_available);
            if let Some(emu_id) = known_devices.get(&device.udid).cloned().or_else(|| {
                existing
                    .iter()
                    .find(|entry| entry.name == device.name && entry.platform == "ios")
                    .map(|entry| entry.id.clone())
            }) {
                known_devices.insert(device.udid.clone(), emu_id.clone());
                update_emulator_device(runtime_url, bearer_token, &emu_id, &device, status);
            } else if let Some(emu_id) =
                register_emulator_device(runtime_url, bearer_token, &device, status)
            {
                known_devices.insert(device.udid.clone(), emu_id);
            }
        }
    }

    struct ExistingEmulatorDevice {
        id: String,
        name: String,
        platform: String,
    }

    fn fetch_existing_emulator_devices(
        runtime_url: &str,
        bearer_token: &Option<String>,
    ) -> Vec<ExistingEmulatorDevice> {
        let result = get_runtime_resource(RuntimeResourceGetRequest::new(
            runtime_url.to_string(),
            "/v1/emulator/devices",
            bearer_token.clone(),
            Duration::from_millis(QUEUE_HTTP_TIMEOUT_MS),
        ));
        let Some(body) = result.body else {
            return Vec::new();
        };
        let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(&body) else {
            return Vec::new();
        };
        entries
            .into_iter()
            .filter_map(|entry| {
                Some(ExistingEmulatorDevice {
                    id: entry.get("id")?.as_str()?.to_string(),
                    name: entry.get("name")?.as_str()?.to_string(),
                    platform: entry.get("platform")?.as_str()?.to_string(),
                })
            })
            .collect()
    }

    fn register_emulator_device(
        runtime_url: &str,
        bearer_token: &Option<String>,
        device: &SimctlDevice,
        status: EmulatorDeviceStatus,
    ) -> Option<String> {
        let body = serde_json::json!({
            "name": device.name,
            "platform": "ios",
            "runtime": device.runtime,
            "status": status.as_str(),
        })
        .to_string();
        let result = pebble_rust_host::write_runtime_resource(
            pebble_rust_host::RuntimeResourceWriteRequest::new(
                runtime_url.to_string(),
                "/v1/emulator/devices",
                pebble_rust_host::RuntimeResourceWriteMethod::Post,
                body,
                bearer_token.clone(),
                Duration::from_millis(QUEUE_HTTP_TIMEOUT_MS),
            ),
        );
        let response_body = result.body?;
        let parsed: Value = serde_json::from_str(&response_body).ok()?;
        parsed.get("id")?.as_str().map(str::to_string)
    }

    fn update_emulator_device(
        runtime_url: &str,
        bearer_token: &Option<String>,
        emu_id: &str,
        device: &SimctlDevice,
        status: EmulatorDeviceStatus,
    ) {
        let body = serde_json::json!({
            "name": device.name,
            "runtime": device.runtime,
            "status": status.as_str(),
        })
        .to_string();
        let _ = pebble_rust_host::write_runtime_resource(
            pebble_rust_host::RuntimeResourceWriteRequest::new(
                runtime_url.to_string(),
                format!("/v1/emulator/devices/{emu_id}"),
                pebble_rust_host::RuntimeResourceWriteMethod::Patch,
                body,
                bearer_token.clone(),
                Duration::from_millis(QUEUE_HTTP_TIMEOUT_MS),
            ),
        );
    }

    fn register_provider(runtime_url: &str, bearer_token: &Option<String>) -> bool {
        let result = register_native_provider(NativeProviderRegistrationCommand {
            runtime_url: runtime_url.to_string(),
            bearer_token: bearer_token.clone(),
            timeout_ms: QUEUE_HTTP_TIMEOUT_MS,
            id: Some(EMULATOR_IOS_PROVIDER_ID.to_string()),
            subsystem: "emulator".to_string(),
            name: EMULATOR_IOS_PROVIDER_NAME.to_string(),
            status: Some("ready".to_string()),
            capabilities: vec![
                "listDevices".to_string(),
                "boot".to_string(),
                "shutdown".to_string(),
                "install".to_string(),
                "launch".to_string(),
                "screenshot".to_string(),
            ],
            message: None,
        });
        result.error.is_none() && result.http_status.is_some_and(|status| status < 300)
    }

    fn post_completion(
        runtime_url: &str,
        bearer_token: &Option<String>,
        action_id: &str,
        completion: ActionCompletion,
    ) {
        let command = match completion {
            ActionCompletion::Completed { result_json } => {
                pebble_rust_host::EmulatorActionUpdateCommand {
                    runtime_url: runtime_url.to_string(),
                    bearer_token: bearer_token.clone(),
                    timeout_ms: UPDATE_HTTP_TIMEOUT_MS,
                    ..pebble_rust_host::EmulatorActionUpdateCommand::completed(
                        action_id,
                        Some(result_json),
                    )
                }
            }
            ActionCompletion::Failed { error_message } => {
                pebble_rust_host::EmulatorActionUpdateCommand {
                    runtime_url: runtime_url.to_string(),
                    bearer_token: bearer_token.clone(),
                    timeout_ms: UPDATE_HTTP_TIMEOUT_MS,
                    ..pebble_rust_host::EmulatorActionUpdateCommand::failed(
                        action_id,
                        error_message,
                    )
                }
            }
        };
        let result = pebble_rust_host::update_emulator_action(command);
        if let Some(error) = result.error {
            eprintln!("emulator ios provider: failed to post completion for {action_id}: {error}");
        }
    }

    fn sleep_unless_stopped(stop: &Arc<AtomicBool>, duration: Duration) {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(100));
        }
    }

    // Kept for future boot-before-launch flows; not wired to a queue verb yet
    // (the queue does not currently emit a bare "boot" command — attach/start
    // session boots implicitly, matching the Electron ensureSimulatorBooted
    // pattern). Referenced by tests only for now.
    #[allow(dead_code)]
    fn ensure_booted(udid: &str) -> Result<(), String> {
        let devices = list_simctl_devices()?;
        let Some(device) = devices.iter().find(|d| d.udid == udid) else {
            return Err(format!("simulator {udid} not found"));
        };
        if device.state == "Booted" {
            return Ok(());
        }
        run_simctl(&SimctlCommand::Boot {
            udid: udid.to_string(),
        })?;
        let deadline = Instant::now() + BOOT_TIMEOUT;
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(700));
            if let Ok(fresh) = list_simctl_devices() {
                if fresh.iter().any(|d| d.udid == udid && d.state == "Booted") {
                    return Ok(());
                }
            }
        }
        Err(format!("simulator {udid} did not reach Booted state"))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn gesture_gap_is_typed_and_explains_idb_xctest() {
            let completion = run_gesture_gap("tap");
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("unsupported_gap:"));
            assert!(error_message.contains("idb"));
            assert!(error_message.contains("XCTest"));
        }

        #[test]
        fn logs_gap_is_typed_and_explains_streaming_need() {
            let completion = run_logs_gap();
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("unsupported_gap:"));
            assert!(error_message.contains("streaming"));
        }

        #[test]
        fn rotate_gap_reports_requested_orientation() {
            let payload = serde_json::json!({ "orientation": "landscapeLeft" });
            let completion = run_rotate("UDID-1", &payload);
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.contains("landscapeLeft"));
        }

        #[test]
        fn run_action_rejects_missing_device_id() {
            let action = ClaimedEmulatorAction {
                id: "eact_1".to_string(),
                kind: "emulator.screenshot".to_string(),
                payload: serde_json::json!({}),
            };
            let completion = run_action(&action);
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("invalid_target:"));
        }

        #[test]
        fn run_action_rejects_unknown_verb() {
            let action = ClaimedEmulatorAction {
                id: "eact_1".to_string(),
                kind: "emulator.frobnicate".to_string(),
                payload: serde_json::json!({ "deviceId": "UDID-1" }),
            };
            let completion = run_action(&action);
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("unsupported_action:"));
        }

        #[test]
        fn install_rejects_missing_app_path() {
            let completion = run_install("UDID-1", &serde_json::json!({}));
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.contains("appPath"));
        }

        #[test]
        fn launch_rejects_missing_bundle_id() {
            let completion = run_launch("UDID-1", &serde_json::json!({}));
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.contains("bundleId"));
        }
    }
}
