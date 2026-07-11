//! Native Android adapter: reconciles `adb devices -l` / `emulator
//! -list-avds` device state into the Go runtime's `/v1/emulator/devices`
//! store and drains the shared `emulator.*` action queue
//! (install/launch/screenshot), following the same claim/execute/complete
//! loop as `emulator_ios_provider.rs` and `computer_use_provider.rs`.
//! Gestures/rotate/logs are explicit gaps — see `run_gesture_gap`,
//! `run_rotate`, and `run_logs_gap` below.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

pub const EMULATOR_ANDROID_PROVIDER_ID: &str = "emulator:tauri-android-adb";
pub const EMULATOR_ANDROID_PROVIDER_NAME: &str = "android-adb-native";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorAndroidProviderStartCommand {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorAndroidProviderStartResult {
    pub supported: bool,
    pub platform: &'static str,
    pub provider_id: Option<&'static str>,
    /// Honest-gap detail when unsupported: why this host cannot run the provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_reason: Option<String>,
}

#[derive(Default)]
pub struct EmulatorAndroidProviderState {
    stop_flag: Mutex<Option<Arc<AtomicBool>>>,
}

/// Starts the background adb reconciliation + action-queue worker.
/// Idempotent while a worker is live. Runs on any host (Android SDK tools are
/// cross-platform, unlike iOS Simulator's macOS-only Xcode dependency), but
/// requires `adb` and `emulator` to actually be resolvable on PATH — when
/// they are not, this returns an explicit unsupported result instead of
/// registering a provider that would silently fail every action.
#[tauri::command]
pub async fn start_emulator_android_provider(
    app: AppHandle,
    state: State<'_, EmulatorAndroidProviderState>,
    input: EmulatorAndroidProviderStartCommand,
) -> Result<EmulatorAndroidProviderStartResult, String> {
    if let Some(reason) = adb_worker::missing_toolchain_reason() {
        return Ok(EmulatorAndroidProviderStartResult {
            supported: false,
            platform: std::env::consts::OS,
            provider_id: None,
            unsupported_reason: Some(reason),
        });
    }
    {
        let mut slot = state
            .stop_flag
            .lock()
            .map_err(|_| "emulator android provider state was poisoned".to_string())?;
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
pub fn stop_emulator_android_provider(app: AppHandle) {
    let state = app.state::<EmulatorAndroidProviderState>();
    let stop = state
        .stop_flag
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().cloned());
    if let Some(stop) = stop {
        stop.store(true, Ordering::SeqCst);
    }
}

fn supported_result() -> EmulatorAndroidProviderStartResult {
    EmulatorAndroidProviderStartResult {
        supported: true,
        platform: std::env::consts::OS,
        provider_id: Some(EMULATOR_ANDROID_PROVIDER_ID),
        unsupported_reason: None,
    }
}

fn default_runtime_url() -> String {
    pebble_rust_host::DEFAULT_RUNTIME_URL.to_string()
}

// Why: every step (adb/emulator subprocess, screenshot stdout capture, queue
// HTTP) blocks, so the whole loop runs on one blocking-pool thread instead of
// interleaving spawn_blocking hops; commands stay async per the Tauri
// main-thread rule.
fn spawn_worker(
    _app: AppHandle,
    input: EmulatorAndroidProviderStartCommand,
    stop: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn_blocking(move || {
        adb_worker::run_provider_loop(input, stop);
    });
}

mod adb_worker {
    use std::process::{Command, Stdio};
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

    use super::super::emulator_android_adb::{
        avd_only_status, build_avd_name_argv, is_emulator_serial, map_adb_state, parse_adb_devices,
        parse_avd_list, parse_avd_name_response, payload_str, AdbCommand, AdbDevice,
        EmulatorDeviceStatus,
    };
    use super::{
        EmulatorAndroidProviderStartCommand, EMULATOR_ANDROID_PROVIDER_ID,
        EMULATOR_ANDROID_PROVIDER_NAME,
    };

    const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(1_200);
    const DEVICE_RECONCILE_INTERVAL: Duration = Duration::from_secs(8);
    const RUNTIME_ERROR_BACKOFF: Duration = Duration::from_secs(5);
    const QUEUE_HTTP_TIMEOUT_MS: u64 = 10_000;
    // Screenshot completions carry base64 PNG bytes; give them a longer window.
    const UPDATE_HTTP_TIMEOUT_MS: u64 = 30_000;
    const ADB_SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(30);

    /// Checks whether `adb` and `emulator` resolve on PATH. Returns `Some`
    /// with an explanation when the Android SDK command-line tools are not
    /// installed, mirroring the iOS adapter's non-macOS gap: register no
    /// provider rather than one that would fail every queued action.
    pub fn missing_toolchain_reason() -> Option<String> {
        let adb_present = binary_resolves("adb");
        let emulator_present = binary_resolves("emulator");
        if adb_present && emulator_present {
            return None;
        }
        let mut missing = Vec::new();
        if !adb_present {
            missing.push("adb");
        }
        if !emulator_present {
            missing.push("emulator");
        }
        Some(format!(
            "the Android adapter requires the Android SDK command-line tools ({}) on PATH; \
             install Android Studio's SDK platform-tools and emulator packages, or add them to \
             PATH manually",
            missing.join(", ")
        ))
    }

    fn binary_resolves(binary: &str) -> bool {
        Command::new(binary)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
    }

    pub fn run_provider_loop(input: EmulatorAndroidProviderStartCommand, stop: Arc<AtomicBool>) {
        let runtime_url = input.runtime_url;
        let bearer_token = input.bearer_token;
        let mut registered = false;
        // serial -> Go-assigned emulator device id, so reconciliation PATCHes
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
        let serial = payload_str(&action.payload, "deviceId")
            .or_else(|| payload_str(&action.payload, "serial"))
            .map(str::to_string);
        let Some(serial) = serial else {
            return ActionCompletion::Failed {
                error_message: "invalid_target: emulator action payload is missing deviceId"
                    .to_string(),
            };
        };
        match verb {
            "screenshot" => run_screenshot(&serial),
            "install" => run_install(&serial, &action.payload),
            "launch" => run_launch(&serial, &action.payload),
            "rotate" => run_rotate(&action.payload),
            "logs" => run_logs_gap(),
            "tap" | "swipe" => run_gesture_gap(verb),
            "pressKey" => run_press_key_gap(),
            "type" => run_type_gap(),
            _ => ActionCompletion::Failed {
                error_message: format!("unsupported_action: unknown emulator command '{verb}'"),
            },
        }
    }

    // Why: this slice only wires install/launch/screenshot through plain adb
    // subprocess calls. Real tap/swipe/pressKey/type synthesis needs `adb
    // shell input tap|swipe|text|keyevent` (coordinate/text plumbing) or a
    // UIAutomator-based harness for anything beyond raw touch coordinates
    // (e.g. view-hierarchy-aware gestures); wiring that is a follow-up, not
    // part of this adapter slice, so report the honest gap instead of a
    // partial/fake implementation.
    fn run_gesture_gap(verb: &str) -> ActionCompletion {
        ActionCompletion::Failed {
            error_message: format!(
                "unsupported_gap: {verb} synthesis is not implemented by this adapter slice; \
                 it requires `adb shell input {verb}` coordinate plumbing or a UIAutomator-based \
                 automation harness, which is out of scope for the install/launch/screenshot \
                 slice landed here"
            ),
        }
    }

    fn run_press_key_gap() -> ActionCompletion {
        ActionCompletion::Failed {
            error_message: "unsupported_gap: hardware key synthesis needs `adb shell input \
                 keyevent`, which is out of scope for this adapter slice, same as tap/swipe"
                .to_string(),
        }
    }

    fn run_type_gap() -> ActionCompletion {
        ActionCompletion::Failed {
            error_message: "unsupported_gap: text input synthesis needs `adb shell input text`, \
                 which is out of scope for this adapter slice, same as tap/swipe"
                .to_string(),
        }
    }

    fn run_logs_gap() -> ActionCompletion {
        // `adb logcat` is a genuinely long-lived tail, not a bounded
        // claim/complete cycle the shared action queue models; a real
        // implementation needs a dedicated streaming transport (e.g. the
        // same relay-event channel the mobile subsystem uses), matching the
        // iOS adapter's `xcrun simctl spawn <udid> log stream` gap.
        ActionCompletion::Failed {
            error_message: "unsupported_gap: log tailing needs a streaming transport \
                 (`adb logcat` is long-lived); the bounded action-queue claim/complete cycle \
                 cannot carry a continuous tail yet"
                .to_string(),
        }
    }

    // adb has no device-rotation verb (it can only report/react to sensor
    // state changes triggered elsewhere); scripting a rotation needs either
    // `adb emu rotate` on emulator consoles specifically (undocumented,
    // emulator-only, absent on physical hardware) or a UIAutomator-driven
    // orientation change. Report the honest gap rather than silently
    // succeeding or half-supporting emulator-only devices.
    fn run_rotate(payload: &Value) -> ActionCompletion {
        let orientation = payload_str(payload, "orientation").unwrap_or("unknown");
        ActionCompletion::Failed {
            error_message: format!(
                "unsupported_gap: `adb` has no cross-device rotation command \
                 (requested orientation: {orientation}); rotation needs a UIAutomator-based \
                 automation harness or an emulator-console-only workaround that does not work \
                 on physical hardware"
            ),
        }
    }

    fn run_screenshot(serial: &str) -> ActionCompletion {
        let command = AdbCommand::Screenshot {
            serial: serial.to_string(),
        };
        match run_adb_raw_stdout(&command) {
            Ok(bytes) => {
                let encoded = BASE64_STANDARD.encode(bytes);
                ActionCompletion::Completed {
                    result_json: serde_json::json!({ "imageBase64": encoded, "mimeType": "image/png" })
                        .to_string(),
                }
            }
            Err(error) => ActionCompletion::Failed {
                error_message: format!("emulator_error: {error}"),
            },
        }
    }

    fn run_install(serial: &str, payload: &Value) -> ActionCompletion {
        let Some(apk_path) =
            payload_str(payload, "appPath").or_else(|| payload_str(payload, "path"))
        else {
            return ActionCompletion::Failed {
                error_message: "invalid_target: install action payload is missing appPath"
                    .to_string(),
            };
        };
        let command = AdbCommand::Install {
            serial: serial.to_string(),
            apk_path: apk_path.to_string(),
        };
        match run_command(&command) {
            Ok(_) => ActionCompletion::Completed {
                result_json: serde_json::json!({ "installed": true }).to_string(),
            },
            Err(error) => ActionCompletion::Failed {
                error_message: format!("emulator_error: {error}"),
            },
        }
    }

    fn run_launch(serial: &str, payload: &Value) -> ActionCompletion {
        let Some(package) =
            payload_str(payload, "packageName").or_else(|| payload_str(payload, "bundleId"))
        else {
            return ActionCompletion::Failed {
                error_message: "invalid_target: launch action payload is missing packageName"
                    .to_string(),
            };
        };
        let command = AdbCommand::Launch {
            serial: serial.to_string(),
            package: package.to_string(),
        };
        match run_command(&command) {
            Ok(_) => ActionCompletion::Completed {
                result_json: serde_json::json!({ "launched": true }).to_string(),
            },
            Err(error) => ActionCompletion::Failed {
                error_message: format!("emulator_error: {error}"),
            },
        }
    }

    /// Runs a text-output adb/emulator command and returns stdout as a
    /// UTF-8-lossy string.
    fn run_command(command: &AdbCommand) -> Result<String, String> {
        let bytes = run_command_raw(command)?;
        Ok(String::from_utf8_lossy(&bytes).to_string())
    }

    /// Runs the screenshot command, which streams raw PNG bytes on stdout
    /// (`adb exec-out` skips CRLF translation, unlike `adb shell`), so this
    /// path must not be treated as text.
    fn run_adb_raw_stdout(command: &AdbCommand) -> Result<Vec<u8>, String> {
        run_command_raw(command)
    }

    fn run_command_raw(command: &AdbCommand) -> Result<Vec<u8>, String> {
        let argv = command.to_argv();
        let binary = command.binary_name();
        let mut child = Command::new(binary)
            .args(&argv)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("failed to spawn {binary}: {error}"))?;
        // Why: a wedged adb server (or a device that dropped mid-command) can
        // hang the subprocess forever; without a watchdog one stuck action
        // queue claim would block every later action this worker thread ever
        // processes.
        let deadline = Instant::now() + ADB_SUBPROCESS_TIMEOUT;
        let output = loop {
            match child.try_wait() {
                Ok(Some(_)) => break child.wait_with_output(),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        return Err(format!(
                            "{binary} {argv:?} timed out after {ADB_SUBPROCESS_TIMEOUT:?}"
                        ));
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                Err(error) => return Err(format!("failed to wait on {binary}: {error}")),
            }
        }
        .map_err(|error| format!("failed to read {binary} output: {error}"))?;
        if output.status.success() {
            return Ok(output.stdout);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(format!("{stdout}\n{stderr}").trim().to_string())
    }

    fn list_adb_devices() -> Result<Vec<AdbDevice>, String> {
        let stdout = run_command(&AdbCommand::ListDevices)?;
        Ok(parse_adb_devices(&stdout))
    }

    fn list_avd_names() -> Result<Vec<String>, String> {
        let stdout = run_command(&AdbCommand::ListAvds)?;
        Ok(parse_avd_list(&stdout))
    }

    /// Resolves the AVD name for a running `emulator-*` serial via `adb -s
    /// <serial> emu avd name`. Physical devices are never AVD-backed so this
    /// is only attempted for emulator serials.
    fn resolve_avd_name(serial: &str) -> Option<String> {
        if !is_emulator_serial(serial) {
            return None;
        }
        let argv = build_avd_name_argv(serial);
        let child = Command::new("adb")
            .args(&argv)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let output = child.wait_with_output().ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        parse_avd_name_response(&stdout)
    }

    fn reconcile_devices(
        runtime_url: &str,
        bearer_token: &Option<String>,
        known_devices: &mut std::collections::HashMap<String, String>,
    ) {
        let devices = match list_adb_devices() {
            Ok(devices) => devices,
            Err(_) => return,
        };
        let known_avds = list_avd_names().unwrap_or_default();
        let existing = fetch_existing_emulator_devices(runtime_url, bearer_token);

        // Connected devices/emulators from `adb devices -l`.
        for device in &devices {
            let avd_name = resolve_avd_name(&device.serial);
            let status = map_adb_state(&device.state);
            let display_name = avd_name.clone().or_else(|| device.model.clone()).unwrap_or_else(|| device.serial.clone());
            reconcile_one(
                runtime_url,
                bearer_token,
                known_devices,
                &existing,
                &device.serial,
                &display_name,
                status,
            );
        }

        // AVDs that `emulator -list-avds` knows about but that have no
        // connected `adb devices` entry — surfaced as `available` (defined,
        // not booted), matching a stopped-simulator entry on the iOS side.
        let connected_avd_names: std::collections::HashSet<&str> = devices
            .iter()
            .filter_map(|d| d.avd_name.as_deref())
            .collect();
        for avd_name in &known_avds {
            if connected_avd_names.contains(avd_name.as_str()) {
                continue;
            }
            // AVD-only entries key by name (no adb serial exists yet).
            reconcile_one(
                runtime_url,
                bearer_token,
                known_devices,
                &existing,
                avd_name,
                avd_name,
                avd_only_status(),
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn reconcile_one(
        runtime_url: &str,
        bearer_token: &Option<String>,
        known_devices: &mut std::collections::HashMap<String, String>,
        existing: &[ExistingEmulatorDevice],
        key: &str,
        display_name: &str,
        status: EmulatorDeviceStatus,
    ) {
        if let Some(emu_id) = known_devices.get(key).cloned().or_else(|| {
            existing
                .iter()
                .find(|entry| entry.name == display_name && entry.platform == "android")
                .map(|entry| entry.id.clone())
        }) {
            known_devices.insert(key.to_string(), emu_id.clone());
            update_emulator_device(runtime_url, bearer_token, &emu_id, display_name, status);
        } else if let Some(emu_id) =
            register_emulator_device(runtime_url, bearer_token, display_name, status)
        {
            known_devices.insert(key.to_string(), emu_id);
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
        name: &str,
        status: EmulatorDeviceStatus,
    ) -> Option<String> {
        let body = serde_json::json!({
            "name": name,
            "platform": "android",
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
        name: &str,
        status: EmulatorDeviceStatus,
    ) {
        let body = serde_json::json!({
            "name": name,
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
            id: Some(EMULATOR_ANDROID_PROVIDER_ID.to_string()),
            subsystem: "emulator".to_string(),
            name: EMULATOR_ANDROID_PROVIDER_NAME.to_string(),
            status: Some("ready".to_string()),
            capabilities: vec![
                "listDevices".to_string(),
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
            eprintln!(
                "emulator android provider: failed to post completion for {action_id}: {error}"
            );
        }
    }

    fn sleep_unless_stopped(stop: &Arc<AtomicBool>, duration: Duration) {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(100));
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn gesture_gap_is_typed_and_explains_input_command() {
            let completion = run_gesture_gap("tap");
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("unsupported_gap:"));
            assert!(error_message.contains("adb shell input tap"));
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
            let payload = serde_json::json!({ "orientation": "landscape" });
            let completion = run_rotate(&payload);
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.contains("landscape"));
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
                payload: serde_json::json!({ "deviceId": "emulator-5554" }),
            };
            let completion = run_action(&action);
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("unsupported_action:"));
        }

        #[test]
        fn install_rejects_missing_app_path() {
            let completion = run_install("emulator-5554", &serde_json::json!({}));
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.contains("appPath"));
        }

        #[test]
        fn launch_rejects_missing_package_name() {
            let completion = run_launch("emulator-5554", &serde_json::json!({}));
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.contains("packageName"));
        }

        #[test]
        fn press_key_gap_is_typed() {
            let completion = run_press_key_gap();
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("unsupported_gap:"));
        }

        #[test]
        fn type_gap_is_typed() {
            let completion = run_type_gap();
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("unsupported_gap:"));
        }
    }
}
