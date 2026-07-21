//! Native Android adapter: reconciles `adb devices -l` / `emulator
//! -list-avds` device state into the Go runtime's `/v1/emulator/devices`
//! store and drains the shared `emulator.*` action queue
//! (install/launch/screenshot), following the same claim/execute/complete
//! loop as `emulator_ios_provider.rs` and `computer_use_provider.rs`, including
//! bounded adb input, rotation, screenshot, and logcat snapshot actions.

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

    use super::super::emulator_android_accessibility::parse_uiautomator_tree;
    use super::super::emulator_android_adb::{
        avd_only_status, build_avd_name_argv, is_emulator_serial, is_valid_android_package_name,
        map_adb_state, parse_adb_devices, parse_avd_list, parse_avd_name_response, payload_str,
        AdbCommand, AdbDevice, EmulatorDeviceStatus,
    };
    use super::super::emulator_android_exec::{
        parse_android_exec_request, run_android_exec, AndroidExecResult,
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
    const AVD_BOOT_TIMEOUT: Duration = Duration::from_secs(180);
    const EXEC_CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(250);
    const EXEC_CANCEL_HTTP_TIMEOUT: Duration = Duration::from_millis(500);
    const UIAUTOMATOR_DUMP_PATH: &str = "/sdcard/window_dump.xml";

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
                boot_active_sessions(&runtime_url, &bearer_token, &known_devices, &stop);
                last_reconcile = Instant::now();
            }

            let claimed = claim_emulator_actions(&runtime_url, &bearer_token);
            if claimed.is_empty() {
                sleep_unless_stopped(&stop, IDLE_POLL_INTERVAL);
                continue;
            }
            for action in claimed {
                let completion =
                    run_action(&action, &known_devices, &runtime_url, &bearer_token, &stop);
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

    fn run_action(
        action: &ClaimedEmulatorAction,
        known_devices: &std::collections::HashMap<String, String>,
        runtime_url: &str,
        bearer_token: &Option<String>,
        stop: &AtomicBool,
    ) -> ActionCompletion {
        let verb = action
            .kind
            .strip_prefix("emulator.")
            .unwrap_or(action.kind.as_str());
        let serial = match resolve_native_device_id(&action.payload, "serial", known_devices) {
            Ok(serial) => serial,
            Err(error_message) => return ActionCompletion::Failed { error_message },
        };
        match verb {
            "screenshot" => run_screenshot(&serial),
            "install" => run_install(&serial, &action.payload),
            "launch" => run_launch(&serial, &action.payload),
            "rotate" => run_rotate(&serial, &action.payload),
            "logs" => run_logs(&serial, &action.payload),
            "tap" => run_tap(&serial, &action.payload),
            "swipe" | "gesture" => run_swipe(&serial, &action.payload),
            "pressKey" | "button" => run_press_key(&serial, &action.payload),
            "type" => run_type(&serial, &action.payload),
            "ax" => run_accessibility_tree(&serial),
            "exec" => run_exec(
                &serial,
                &action.id,
                &action.payload,
                runtime_url,
                bearer_token,
                stop,
            ),
            "shutdown" => complete_adb(
                AdbCommand::Shutdown {
                    serial: serial.clone(),
                },
                serde_json::json!({ "deviceUdid": serial }),
            ),
            _ => ActionCompletion::Failed {
                error_message: format!("unsupported_action: unknown emulator command '{verb}'"),
            },
        }
    }

    fn run_exec(
        serial: &str,
        action_id: &str,
        payload: &Value,
        runtime_url: &str,
        bearer_token: &Option<String>,
        stop: &AtomicBool,
    ) -> ActionCompletion {
        let request = match parse_android_exec_request(payload) {
            Ok(request) => request,
            Err(error) => return invalid(&error),
        };
        let mut cancellation = ActionCancellationProbe::new(
            runtime_url.to_string(),
            bearer_token.clone(),
            action_id.to_string(),
        );
        match run_android_exec(serial, &request, stop, || cancellation.is_cancelled()) {
            Ok(result) if result.exit_code == Some(0) => ActionCompletion::Completed {
                result_json: exec_result_json(&result).to_string(),
            },
            Ok(result) => emulator_failure(format!(
                "adb shell exited with status {:?}: {}",
                result.exit_code,
                exec_error_output(&result)
            )),
            Err(error) => emulator_failure(error),
        }
    }

    fn exec_result_json(result: &AndroidExecResult) -> Value {
        serde_json::json!({
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exitCode": result.exit_code,
            "truncated": result.truncated,
        })
    }

    fn exec_error_output(result: &AndroidExecResult) -> String {
        let output = format!("{}\n{}", result.stdout, result.stderr);
        let output = output.trim();
        if output.is_empty() {
            "no output".to_string()
        } else if result.truncated {
            format!("{output} [output truncated]")
        } else {
            output.to_string()
        }
    }

    struct ActionCancellationProbe {
        runtime_url: String,
        bearer_token: Option<String>,
        action_id: String,
        last_poll: Option<Instant>,
    }

    impl ActionCancellationProbe {
        fn new(runtime_url: String, bearer_token: Option<String>, action_id: String) -> Self {
            Self {
                runtime_url,
                bearer_token,
                action_id,
                last_poll: None,
            }
        }

        fn is_cancelled(&mut self) -> bool {
            if self
                .last_poll
                .is_some_and(|last_poll| last_poll.elapsed() < EXEC_CANCEL_POLL_INTERVAL)
            {
                return false;
            }
            self.last_poll = Some(Instant::now());
            let result = get_runtime_resource(RuntimeResourceGetRequest::new(
                self.runtime_url.clone(),
                "/v1/computer/actions?status=failed&kindPrefix=emulator.exec",
                self.bearer_token.clone(),
                EXEC_CANCEL_HTTP_TIMEOUT,
            ));
            let Some(body) = result.body else {
                return false;
            };
            action_status_is_failed(&body, &self.action_id)
        }
    }

    fn action_status_is_failed(body: &str, action_id: &str) -> bool {
        let Ok(Value::Array(actions)) = serde_json::from_str::<Value>(body) else {
            return false;
        };
        actions.iter().any(|action| {
            action.get("id").and_then(Value::as_str) == Some(action_id)
                && action.get("status").and_then(Value::as_str) == Some("failed")
        })
    }

    fn resolve_native_device_id(
        payload: &Value,
        native_key: &str,
        known_devices: &std::collections::HashMap<String, String>,
    ) -> Result<String, String> {
        if let Some(runtime_id) = payload_str(payload, "deviceId") {
            if let Some((native_id, _)) = known_devices
                .iter()
                .find(|(_, registered_id)| registered_id.as_str() == runtime_id)
            {
                return Ok(native_id.clone());
            }
            // Older direct queue producers used native ids in deviceId; retain
            // that compatibility while refusing unresolved Go record ids.
            if !runtime_id.starts_with("emu_") {
                return Ok(runtime_id.to_string());
            }
            return Err(format!(
                "invalid_target: no adb serial is registered for emulator device {runtime_id}"
            ));
        }
        payload_str(payload, native_key)
            .map(str::to_string)
            .ok_or_else(|| {
                "invalid_target: emulator action payload is missing deviceId".to_string()
            })
    }

    fn run_tap(serial: &str, payload: &Value) -> ActionCompletion {
        let Some((width, height)) = read_device_size(serial) else {
            return invalid("could not resolve device screen size");
        };
        let Some((x, y)) = normalized_point(payload, "x", "y", width, height) else {
            return invalid("tap requires normalized x/y coordinates");
        };
        complete_adb(
            AdbCommand::Tap {
                serial: serial.to_string(),
                x,
                y,
            },
            serde_json::json!({ "tapped": true }),
        )
    }

    fn run_swipe(serial: &str, payload: &Value) -> ActionCompletion {
        let Some((width, height)) = read_device_size(serial) else {
            return invalid("could not resolve device screen size");
        };
        let points = payload.get("points").and_then(Value::as_array);
        let (start, end) = if let Some(points) = points {
            (points.first(), points.last())
        } else {
            (Some(payload), Some(payload))
        };
        let Some(from) = start.and_then(|value| normalized_point(value, "x", "y", width, height))
        else {
            return invalid("swipe requires a start point");
        };
        let Some(to) = end.and_then(|value| {
            normalized_point(value, "toX", "toY", width, height)
                .or_else(|| normalized_point(value, "x", "y", width, height))
        }) else {
            return invalid("swipe requires an end point");
        };
        complete_adb(
            AdbCommand::Swipe {
                serial: serial.to_string(),
                from_x: from.0,
                from_y: from.1,
                to_x: to.0,
                to_y: to.1,
                duration_ms: 300,
            },
            serde_json::json!({ "swiped": true }),
        )
    }

    fn run_press_key(serial: &str, payload: &Value) -> ActionCompletion {
        let name = payload_str(payload, "name")
            .or_else(|| payload_str(payload, "key"))
            .unwrap_or_default();
        let Some(keycode) = android_keycode(name) else {
            return invalid("unknown Android hardware button");
        };
        complete_adb(
            AdbCommand::KeyEvent {
                serial: serial.to_string(),
                keycode,
            },
            serde_json::json!({ "pressed": name }),
        )
    }

    fn run_type(serial: &str, payload: &Value) -> ActionCompletion {
        let text = payload_str(payload, "text").unwrap_or_default();
        if text.len() > 16_384 || text.contains(['\n', '\r', '\0']) {
            return invalid("text contains unsupported control characters or is too large");
        }
        complete_adb(
            AdbCommand::TypeText {
                serial: serial.to_string(),
                encoded_text: text.replace(' ', "%s"),
            },
            serde_json::json!({ "typed": true }),
        )
    }

    fn run_logs(serial: &str, payload: &Value) -> ActionCompletion {
        let lines = payload
            .get("lines")
            .and_then(Value::as_u64)
            .unwrap_or(500)
            .clamp(1, 2_000) as u16;
        match run_command(&AdbCommand::LogcatSnapshot {
            serial: serial.to_string(),
            lines,
        }) {
            Ok(logs) => ActionCompletion::Completed {
                result_json: serde_json::json!({ "logs": logs, "truncated": lines == 2_000 })
                    .to_string(),
            },
            Err(error) => emulator_failure(error),
        }
    }

    fn run_accessibility_tree(serial: &str) -> ActionCompletion {
        if let Err(error) = run_command(&AdbCommand::AccessibilityDump {
            serial: serial.to_string(),
            remote_path: UIAUTOMATOR_DUMP_PATH.to_string(),
        }) {
            return emulator_failure(error);
        }
        let xml = match run_command(&AdbCommand::ReadRemoteFile {
            serial: serial.to_string(),
            remote_path: UIAUTOMATOR_DUMP_PATH.to_string(),
        }) {
            Ok(xml) => xml,
            Err(error) => return emulator_failure(error),
        };
        // Why: only a successful fresh dump may be returned; otherwise a stale
        // window_dump.xml from a previous foreground app would mislead automation.
        match parse_uiautomator_tree(&xml) {
            Ok(tree) => match serde_json::to_string(&tree) {
                Ok(result_json) => ActionCompletion::Completed { result_json },
                Err(error) => emulator_failure(format!(
                    "could not encode the uiautomator accessibility tree: {error}"
                )),
            },
            Err(error) => emulator_failure(error),
        }
    }

    fn run_rotate(serial: &str, payload: &Value) -> ActionCompletion {
        let orientation = payload_str(payload, "orientation").unwrap_or("portrait");
        let rotation = match orientation {
            "portrait" => 0,
            "landscape_left" => 1,
            "portrait_upside_down" => 2,
            "landscape_right" => 3,
            _ => return invalid("unknown Android orientation"),
        };
        if let Err(error) = run_command(&AdbCommand::RotationSetting {
            serial: serial.to_string(),
            setting: "accelerometer_rotation",
            value: 0,
        }) {
            return emulator_failure(error);
        }
        complete_adb(
            AdbCommand::RotationSetting {
                serial: serial.to_string(),
                setting: "user_rotation",
                value: rotation,
            },
            serde_json::json!({ "orientation": orientation }),
        )
    }

    fn complete_adb(command: AdbCommand, result: Value) -> ActionCompletion {
        match run_command(&command) {
            Ok(_) => ActionCompletion::Completed {
                result_json: result.to_string(),
            },
            Err(error) => emulator_failure(error),
        }
    }

    fn invalid(message: &str) -> ActionCompletion {
        ActionCompletion::Failed {
            error_message: format!("invalid_target: {message}"),
        }
    }

    fn emulator_failure(error: String) -> ActionCompletion {
        ActionCompletion::Failed {
            error_message: format!("emulator_error: {error}"),
        }
    }

    fn read_device_size(serial: &str) -> Option<(u32, u32)> {
        let output = run_command(&AdbCommand::ScreenSize {
            serial: serial.to_string(),
        })
        .ok()?;
        output.lines().rev().find_map(|line| {
            let dimensions = line.split_whitespace().last()?;
            let (width, height) = dimensions.split_once('x')?;
            let width = width.parse::<u32>().ok()?;
            let height = height.parse::<u32>().ok()?;
            (width > 0 && height > 0).then_some((width, height))
        })
    }

    fn normalized_point(
        payload: &Value,
        x_key: &str,
        y_key: &str,
        width: u32,
        height: u32,
    ) -> Option<(u32, u32)> {
        let x = payload.get(x_key)?.as_f64()?;
        let y = payload.get(y_key)?.as_f64()?;
        if !x.is_finite()
            || !y.is_finite()
            || !(0.0..=1.0).contains(&x)
            || !(0.0..=1.0).contains(&y)
        {
            return None;
        }
        Some((
            (x * width as f64)
                .round()
                .clamp(0.0, width.saturating_sub(1) as f64) as u32,
            (y * height as f64)
                .round()
                .clamp(0.0, height.saturating_sub(1) as f64) as u32,
        ))
    }

    fn android_keycode(name: &str) -> Option<u16> {
        match name {
            "home" => Some(3),
            "back" => Some(4),
            "recents" | "recent" | "overview" | "app_switch" => Some(187),
            "power" | "lock" => Some(26),
            "volume_up" | "volup" => Some(24),
            "volume_down" | "voldown" => Some(25),
            _ => None,
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
                    result_json:
                        serde_json::json!({ "imageBase64": encoded, "mimeType": "image/png" })
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
        // Why: `adb shell` joins its trailing argv into one string for the
        // device's own shell to interpret, so an unvalidated package name
        // could carry shell metacharacters executed on the attached device.
        if !is_valid_android_package_name(package) {
            return ActionCompletion::Failed {
                error_message: "invalid_target: packageName is not a valid Android application ID"
                    .to_string(),
            };
        }
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

        // Connected devices/emulators from `adb devices -l`. AdbDevice.avd_name
        // is never populated by parse_adb_devices (adb's own listing doesn't
        // carry it) — track resolved names here instead of reading it back off
        // `device`, or every running AVD would also match the AVD-only branch
        // below and flap between running/available on every reconcile pass.
        let mut connected_avd_names: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for device in &devices {
            let avd_name = resolve_avd_name(&device.serial);
            if let Some(name) = &avd_name {
                connected_avd_names.insert(name.clone());
            }
            let status = map_adb_state(&device.state);
            let display_name = avd_name
                .clone()
                .or_else(|| device.model.clone())
                .unwrap_or_else(|| device.serial.clone());
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
            update_emulator_device(
                runtime_url,
                bearer_token,
                &emu_id,
                key,
                display_name,
                status,
            );
        } else if let Some(emu_id) =
            register_emulator_device(runtime_url, bearer_token, key, display_name, status)
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

    fn boot_active_sessions(
        runtime_url: &str,
        bearer_token: &Option<String>,
        known_devices: &std::collections::HashMap<String, String>,
        stop: &AtomicBool,
    ) {
        let result = get_runtime_resource(RuntimeResourceGetRequest::new(
            runtime_url.to_string(),
            "/v1/emulator/sessions",
            bearer_token.clone(),
            Duration::from_millis(QUEUE_HTTP_TIMEOUT_MS),
        ));
        let Some(body) = result.body else {
            return;
        };
        let active_device_ids = active_session_device_ids(&body);
        for (native_id, runtime_id) in known_devices {
            if !is_emulator_serial(native_id) && active_device_ids.contains(runtime_id) {
                // AVD-only inventory rows have no adb serial until startup; the
                // provider owns that transition for Electron-compatible attach.
                if let Err(error) = ensure_avd_booted(native_id, stop) {
                    eprintln!(
                        "emulator android provider: failed to boot active AVD {native_id}: {error}"
                    );
                }
            }
        }
    }

    fn active_session_device_ids(body: &str) -> std::collections::HashSet<String> {
        let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(body) else {
            return std::collections::HashSet::new();
        };
        entries
            .into_iter()
            .filter(|entry| entry.get("active").and_then(Value::as_bool) == Some(true))
            .filter_map(|entry| entry.get("deviceId")?.as_str().map(str::to_string))
            .collect()
    }

    fn ensure_avd_booted(avd_name: &str, stop: &AtomicBool) -> Result<(), String> {
        if running_avd_serial(avd_name).is_some_and(|serial| adb_boot_completed(&serial)) {
            return Ok(());
        }
        let mut child = Command::new("emulator")
            .args(["-avd", avd_name])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("failed to start emulator -avd: {error}"))?;
        let deadline = Instant::now() + AVD_BOOT_TIMEOUT;
        while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
            if let Some(status) = child
                .try_wait()
                .map_err(|error| format!("failed to inspect emulator process: {error}"))?
            {
                return Err(format!("emulator process exited before boot with {status}"));
            }
            if running_avd_serial(avd_name).is_some_and(|serial| adb_boot_completed(&serial)) {
                return Ok(());
            }
            thread::sleep(Duration::from_secs(2));
        }
        Err(format!("AVD {avd_name} did not reach running state"))
    }

    fn running_avd_serial(avd_name: &str) -> Option<String> {
        list_adb_devices().ok()?.into_iter().find_map(|device| {
            (map_adb_state(&device.state) == EmulatorDeviceStatus::Running
                && resolve_avd_name(&device.serial).as_deref() == Some(avd_name))
            .then_some(device.serial)
        })
    }

    fn adb_boot_completed(serial: &str) -> bool {
        Command::new("adb")
            .args(["-s", serial, "shell", "getprop", "sys.boot_completed"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .is_ok_and(|output| output.status.success() && output.stdout.trim_ascii() == b"1")
    }

    fn register_emulator_device(
        runtime_url: &str,
        bearer_token: &Option<String>,
        native_id: &str,
        name: &str,
        status: EmulatorDeviceStatus,
    ) -> Option<String> {
        let body = serde_json::json!({
            "nativeId": native_id,
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
        native_id: &str,
        name: &str,
        status: EmulatorDeviceStatus,
    ) {
        let body = serde_json::json!({
            "nativeId": native_id,
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
                "boot".to_string(),
                "install".to_string(),
                "launch".to_string(),
                "screenshot".to_string(),
                "tap".to_string(),
                "swipe".to_string(),
                "type".to_string(),
                "pressKey".to_string(),
                "rotate".to_string(),
                "logsSnapshot".to_string(),
                "accessibilityTree".to_string(),
                "exec".to_string(),
                "shutdown".to_string(),
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
        fn normalized_points_map_to_bounded_device_pixels() {
            assert_eq!(
                normalized_point(
                    &serde_json::json!({ "x": 1.0, "y": 0.5 }),
                    "x",
                    "y",
                    1080,
                    2400
                ),
                Some((1079, 1200))
            );
            assert_eq!(
                normalized_point(
                    &serde_json::json!({ "x": -0.1, "y": 0.5 }),
                    "x",
                    "y",
                    1080,
                    2400
                ),
                None
            );
        }

        #[test]
        fn android_button_aliases_map_to_platform_keycodes() {
            assert_eq!(android_keycode("home"), Some(3));
            assert_eq!(android_keycode("overview"), Some(187));
            assert_eq!(android_keycode("unknown"), None);
        }

        #[test]
        fn rotate_rejects_unknown_orientation_before_adb() {
            let payload = serde_json::json!({ "orientation": "diagonal" });
            let completion = run_rotate("emulator-5554", &payload);
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("invalid_target:"));
        }

        #[test]
        fn run_action_rejects_missing_device_id() {
            let action = ClaimedEmulatorAction {
                id: "eact_1".to_string(),
                kind: "emulator.screenshot".to_string(),
                payload: serde_json::json!({}),
            };
            let completion = run_action(
                &action,
                &std::collections::HashMap::new(),
                "http://127.0.0.1:17778",
                &None,
                &AtomicBool::new(false),
            );
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
            let completion = run_action(
                &action,
                &std::collections::HashMap::new(),
                "http://127.0.0.1:17778",
                &None,
                &AtomicBool::new(false),
            );
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
        fn launch_rejects_shell_metacharacters_in_package_name() {
            let completion = run_launch(
                "emulator-5554",
                &serde_json::json!({ "packageName": "com.example;reboot" }),
            );
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion, package name should never reach adb argv");
            };
            assert!(error_message.contains("valid Android application ID"));
        }

        #[test]
        fn press_key_rejects_unknown_name_before_adb() {
            let completion = run_press_key(
                "emulator-5554",
                &serde_json::json!({ "name": "launch_missiles" }),
            );
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("invalid_target:"));
        }

        #[test]
        fn type_rejects_newlines_before_adb() {
            let completion = run_type("emulator-5554", &serde_json::json!({ "text": "a\nb" }));
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("invalid_target:"));
        }

        #[test]
        fn resolves_runtime_device_id_to_adb_serial() {
            let known = std::collections::HashMap::from([(
                "emulator-5554".to_string(),
                "emu_runtime".to_string(),
            )]);
            let serial = resolve_native_device_id(
                &serde_json::json!({ "deviceId": "emu_runtime" }),
                "serial",
                &known,
            )
            .unwrap();
            assert_eq!(serial, "emulator-5554");
            let serial = resolve_native_device_id(
                &serde_json::json!({
                    "deviceId": "emu_runtime",
                    "serial": "emulator-attacker"
                }),
                "serial",
                &known,
            )
            .unwrap();
            assert_eq!(serial, "emulator-5554");
            assert!(resolve_native_device_id(
                &serde_json::json!({ "deviceId": "emu_missing" }),
                "serial",
                &known,
            )
            .unwrap_err()
            .starts_with("invalid_target:"));
        }

        #[test]
        fn exec_rejects_command_strings_before_adb() {
            let completion = run_exec(
                "emulator-5554",
                "cact_1",
                &serde_json::json!({ "command": "id" }),
                "http://127.0.0.1:17778",
                &None,
                &AtomicBool::new(false),
            );
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("invalid_target:"));
            assert!(error_message.contains("argv array"));
        }

        #[test]
        fn cancellation_probe_reads_failed_action_status() {
            assert!(action_status_is_failed(
                r#"[{"id":"cact_1","status":"failed"}]"#,
                "cact_1"
            ));
            assert!(!action_status_is_failed(
                r#"[{"id":"cact_1","status":"running"}]"#,
                "cact_1"
            ));
        }

        #[test]
        fn active_session_parser_ignores_inactive_and_malformed_rows() {
            let ids = active_session_device_ids(
                r#"[
                    {"deviceId":"emu_active","active":true},
                    {"deviceId":"emu_inactive","active":false},
                    {"active":true},
                    null
                ]"#,
            );
            assert_eq!(
                ids,
                std::collections::HashSet::from(["emu_active".to_string()])
            );
            assert!(active_session_device_ids("not-json").is_empty());
        }
    }
}
