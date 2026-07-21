//! Native iOS Simulator adapter: reconciles `xcrun simctl` device state into
//! the Go runtime's `/v1/emulator/devices` store and drains the shared
//! `emulator.*` action queue (boot/install/launch/screenshot/logs/input/exec),
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
    use std::path::{Path, PathBuf};
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
        parse_simctl_device_list, payload_f64, payload_str, EmulatorDeviceStatus,
        ServeSimInputCommand, SimctlCommand, SimctlDevice,
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
                boot_active_sessions(&runtime_url, &bearer_token, &known_devices);
                last_reconcile = Instant::now();
            }

            let claimed = claim_emulator_actions(&runtime_url, &bearer_token);
            if claimed.is_empty() {
                sleep_unless_stopped(&stop, IDLE_POLL_INTERVAL);
                continue;
            }
            for action in claimed {
                let completion = run_action(&action, &known_devices);
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
    ) -> ActionCompletion {
        let verb = action
            .kind
            .strip_prefix("emulator.")
            .unwrap_or(action.kind.as_str());
        let udid = match resolve_native_device_id(&action.payload, known_devices) {
            Ok(udid) => udid,
            Err(error_message) => return ActionCompletion::Failed { error_message },
        };
        match verb {
            "screenshot" => run_screenshot(&udid),
            "install" => run_install(&udid, &action.payload),
            "launch" => run_launch(&udid, &action.payload),
            "rotate" => run_rotate(&udid, &action.payload),
            "logs" => run_logs(&udid, &action.payload),
            "tap" => run_tap(&udid, &action.payload),
            "gesture" | "swipe" => run_gesture(&udid, &action.payload),
            "button" | "pressKey" => run_button(&udid, &action.payload),
            "type" => run_type(&udid, &action.payload),
            "ax" => run_accessibility(&udid),
            "exec" => run_exec(&udid, &action.payload),
            "shutdown" => match run_simctl(&SimctlCommand::Shutdown { udid: udid.clone() }) {
                Ok(_) => ActionCompletion::Completed {
                    result_json: serde_json::json!({ "deviceUdid": udid }).to_string(),
                },
                Err(error) => ActionCompletion::Failed {
                    error_message: format!("emulator_error: {error}"),
                },
            },
            _ => ActionCompletion::Failed {
                error_message: format!("unsupported_action: unknown emulator command '{verb}'"),
            },
        }
    }

    fn resolve_native_device_id(
        payload: &Value,
        known_devices: &std::collections::HashMap<String, String>,
    ) -> Result<String, String> {
        if let Some(runtime_id) = payload_str(payload, "deviceId") {
            if let Some((udid, _)) = known_devices
                .iter()
                .find(|(_, registered_id)| registered_id.as_str() == runtime_id)
            {
                return Ok(udid.clone());
            }
            if !runtime_id.starts_with("emu_") {
                return Ok(runtime_id.to_string());
            }
            return Err(format!(
                "invalid_target: no simulator UDID is registered for emulator device {runtime_id}"
            ));
        }
        payload_str(payload, "udid")
            .map(str::to_string)
            .ok_or_else(|| {
                "invalid_target: emulator action payload is missing deviceId".to_string()
            })
    }

    fn run_tap(udid: &str, payload: &Value) -> ActionCompletion {
        let Some(x) = payload_f64(payload, "x").filter(|value| (0.0..=1.0).contains(value)) else {
            return invalid_input("tap x must be a normalized number from 0 to 1");
        };
        let Some(y) = payload_f64(payload, "y").filter(|value| (0.0..=1.0).contains(value)) else {
            return invalid_input("tap y must be a normalized number from 0 to 1");
        };
        run_serve_sim(&ServeSimInputCommand::Tap {
            x,
            y,
            udid: udid.to_string(),
        })
    }

    fn run_gesture(udid: &str, payload: &Value) -> ActionCompletion {
        let Some(points) = payload.get("points").and_then(Value::as_array) else {
            return invalid_input("gesture points must be an array");
        };
        if !(2..=64).contains(&points.len()) {
            return invalid_input("gesture points must contain 2 to 64 entries");
        }
        for point in points {
            let valid_type = point
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| matches!(kind, "begin" | "move" | "end"));
            let valid_coord = |key| {
                point
                    .get(key)
                    .and_then(Value::as_f64)
                    .is_some_and(|value| (0.0..=1.0).contains(&value))
            };
            if !valid_type || !valid_coord("x") || !valid_coord("y") {
                return invalid_input("gesture points require a valid type and normalized x/y");
            }
        }
        // Why: validate the entire path before injecting its first point so a
        // malformed tail cannot leave an unfinished touch active on the device.
        for point in points {
            let completion = run_serve_sim(&ServeSimInputCommand::Gesture {
                point_json: point.to_string(),
                udid: udid.to_string(),
            });
            if matches!(completion, ActionCompletion::Failed { .. }) {
                return completion;
            }
        }
        completed_input(udid)
    }

    fn run_type(udid: &str, payload: &Value) -> ActionCompletion {
        let Some(text) = payload_str(payload, "text") else {
            return invalid_input("type action payload is missing text");
        };
        if text.len() > 16 * 1024 || text.contains('\0') {
            return invalid_input("type text must be NUL-free and at most 16 KiB");
        }
        run_serve_sim(&ServeSimInputCommand::Type {
            text: text.to_string(),
            udid: udid.to_string(),
        })
    }

    fn run_button(udid: &str, payload: &Value) -> ActionCompletion {
        let name = payload_str(payload, "name").unwrap_or("home");
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return invalid_input("button name contains unsupported characters");
        }
        run_serve_sim(&ServeSimInputCommand::Button {
            name: name.to_string(),
            udid: udid.to_string(),
        })
    }

    fn run_accessibility(udid: &str) -> ActionCompletion {
        if let Err(error_message) = ensure_serve_sim_helper(udid) {
            return ActionCompletion::Failed { error_message };
        }
        match super::super::emulator_ios_accessibility::accessibility_snapshot(udid) {
            Ok(snapshot) => ActionCompletion::Completed {
                result_json: snapshot.to_string(),
            },
            Err(error_message) => ActionCompletion::Failed { error_message },
        }
    }

    fn ensure_serve_sim_helper(udid: &str) -> Result<u16, String> {
        match super::super::emulator_ios_accessibility::helper_port(udid) {
            Ok(port) if super::super::emulator_ios_accessibility::helper_is_ready(port) => {
                return Ok(port);
            }
            Ok(_) => {}
            Err(error) if error.starts_with("external_dependency:") => {}
            Err(error) => return Err(error),
        }
        start_serve_sim_preview(udid)?;
        super::super::emulator_ios_accessibility::helper_port(udid)
    }

    fn start_serve_sim_preview(udid: &str) -> Result<(), String> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("emulator_error: cannot reserve helper port: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("emulator_error: cannot inspect helper port: {error}"))?
            .port();
        drop(listener);
        let mut child = Command::new(resolve_serve_sim_helper())
            .args([udid, "--port", &port.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|error| format!("external_dependency: failed to start serve-sim: {error}"))?;
        let pid = child.id();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    return Err(format!(
                        "emulator_error: serve-sim preview exited with status {status}"
                    ));
                }
                Ok(None) if super::super::emulator_ios_accessibility::helper_is_ready(port) => {
                    return super::super::emulator_ios_accessibility::persist_helper_state(
                        udid, port, pid,
                    );
                }
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(100));
                }
                Ok(None) => {
                    let _ = child.kill();
                    return Err(
                        "timeout: serve-sim preview did not detach within 10 seconds".into(),
                    );
                }
                Err(error) => {
                    return Err(format!(
                        "emulator_error: failed to wait on serve-sim: {error}"
                    ));
                }
            }
        }
    }

    struct ExecRequest {
        argv: Vec<String>,
        timeout: Duration,
    }

    fn run_exec(udid: &str, payload: &Value) -> ActionCompletion {
        let request = match parse_exec_request(payload) {
            Ok(request) => request,
            Err(message) => return invalid_input(&message),
        };
        if let Some(completion) = run_native_exec(udid, &request.argv) {
            return completion;
        }
        run_serve_sim_exec(udid, &request)
    }

    fn run_native_exec(udid: &str, argv: &[String]) -> Option<ActionCompletion> {
        let command = argv.first()?.as_str();
        let invalid = |message: &str| Some(invalid_input(message));
        let input = match command {
            "gesture" if argv.len() == 2 => ServeSimInputCommand::Gesture {
                point_json: argv[1].clone(),
                udid: udid.to_string(),
            },
            "tap" if argv.len() == 3 => {
                let Ok(x) = argv[1].parse::<f64>() else {
                    return invalid("tap coordinates must be numbers");
                };
                let Ok(y) = argv[2].parse::<f64>() else {
                    return invalid("tap coordinates must be numbers");
                };
                if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
                    return invalid("tap coordinates must be normalized from 0 to 1");
                }
                ServeSimInputCommand::Tap {
                    x,
                    y,
                    udid: udid.to_string(),
                }
            }
            "type" if argv.len() >= 2 => ServeSimInputCommand::Type {
                text: argv[1..].join(" "),
                udid: udid.to_string(),
            },
            "button" if argv.len() <= 2 => ServeSimInputCommand::Button {
                name: argv.get(1).cloned().unwrap_or_else(|| "home".to_string()),
                udid: udid.to_string(),
            },
            "rotate" if argv.len() == 2 => ServeSimInputCommand::Rotate {
                orientation: argv[1].clone(),
                udid: udid.to_string(),
            },
            "ca-debug" if argv.len() == 3 => {
                let option = match argv[1].as_str() {
                    "blended" => "debug_color_blended",
                    "copies" | "copied" => "debug_color_copies",
                    "misaligned" => "debug_color_misaligned",
                    "offscreen" => "debug_color_offscreen",
                    "slow" | "slow-animations" => "debug_slow_animations",
                    value => value,
                };
                let enabled = match argv[2].as_str() {
                    "on" | "1" | "true" => true,
                    "off" | "0" | "false" => false,
                    _ => return invalid("ca-debug state must be on or off"),
                };
                ServeSimInputCommand::CoreAnimationDebug {
                    option: option.to_string(),
                    enabled,
                    udid: udid.to_string(),
                }
            }
            "memory-warning" if argv.len() == 1 => ServeSimInputCommand::MemoryWarning {
                udid: udid.to_string(),
            },
            "gesture" | "tap" | "button" | "rotate" | "ca-debug" | "memory-warning" => {
                return invalid("invalid serve-sim command arguments");
            }
            _ => return None,
        };
        Some(run_serve_sim(&input))
    }

    fn parse_exec_request(payload: &Value) -> Result<ExecRequest, String> {
        let raw_argv = payload
            .get("argv")
            .and_then(Value::as_array)
            .ok_or_else(|| "exec argv must be an array".to_string())?;
        if !(1..=64).contains(&raw_argv.len()) {
            return Err("exec argv must contain 1 to 64 entries".to_string());
        }
        let mut total_bytes = 0usize;
        let mut argv = Vec::with_capacity(raw_argv.len() + 2);
        let mut skip_target_value = false;
        for (index, value) in raw_argv.iter().enumerate() {
            let argument = value
                .as_str()
                .ok_or_else(|| "exec argv entries must be strings".to_string())?;
            if argument.contains('\0') || argument.len() > 4_096 {
                return Err("exec argv entries must be NUL-free and at most 4096 bytes".to_string());
            }
            total_bytes += argument.len();
            if total_bytes > 16_384 {
                return Err("exec argv must be at most 16384 bytes".to_string());
            }
            if index == 0 && argument.is_empty() {
                return Err("exec argv[0] must name a serve-sim command".to_string());
            }
            if skip_target_value {
                skip_target_value = false;
                continue;
            }
            if matches!(argument, "--device" | "-d" | "--emulator" | "--worktree") {
                skip_target_value = true;
                continue;
            }
            if ["--device=", "-d=", "--emulator=", "--worktree="]
                .iter()
                .any(|prefix| argument.starts_with(prefix))
            {
                continue;
            }
            argv.push(argument.to_string());
        }
        if argv.is_empty() {
            return Err(
                "exec argv must retain a serve-sim command after target filtering".to_string(),
            );
        }
        let timeout_ms = payload
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(30_000);
        if !(100..=30_000).contains(&timeout_ms) {
            return Err("exec timeoutMs must be from 100 to 30000".to_string());
        }
        Ok(ExecRequest {
            argv,
            timeout: Duration::from_millis(timeout_ms),
        })
    }

    fn run_serve_sim_exec(udid: &str, request: &ExecRequest) -> ActionCompletion {
        use std::io::Read as _;

        const OUTPUT_LIMIT: u64 = 10 * 1024 * 1024;
        let executable = resolve_serve_sim_executable();
        let mut child = match Command::new(&executable)
            .args(&request.argv)
            .args(["-d", udid])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return ActionCompletion::Failed {
                    error_message:
                        "external_dependency: serve-sim is required for iOS emulator.exec"
                            .to_string(),
                };
            }
            Err(error) => {
                return ActionCompletion::Failed {
                    error_message: format!("emulator_error: failed to spawn serve-sim: {error}"),
                };
            }
        };
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return ActionCompletion::Failed {
                error_message: "emulator_error: serve-sim output pipes were unavailable"
                    .to_string(),
            };
        };
        let read_output = |stream: Box<dyn std::io::Read + Send>| {
            let mut bytes = Vec::new();
            stream
                .take(OUTPUT_LIMIT + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
        };
        let stdout_reader = thread::spawn(move || read_output(Box::new(stdout)));
        let stderr_reader = thread::spawn(move || read_output(Box::new(stderr)));
        let deadline = Instant::now() + request.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(format!(
                        "timeout: serve-sim exec timed out after {} milliseconds",
                        request.timeout.as_millis()
                    ));
                }
                Err(error) => {
                    break Err(format!(
                        "emulator_error: failed to wait on serve-sim: {error}"
                    ))
                }
            }
        };
        let stdout = stdout_reader
            .join()
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        let stderr = stderr_reader
            .join()
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        let status = match status {
            Ok(status) => status,
            Err(error_message) => return ActionCompletion::Failed { error_message },
        };
        if stdout.len() as u64 > OUTPUT_LIMIT || stderr.len() as u64 > OUTPUT_LIMIT {
            return ActionCompletion::Failed {
                error_message: "emulator_error: serve-sim exec output exceeded 10 MiB".to_string(),
            };
        }
        if !status.success() {
            return ActionCompletion::Failed {
                error_message: format!(
                    "emulator_error: {}",
                    String::from_utf8_lossy(&stderr).trim()
                ),
            };
        }
        let text = String::from_utf8_lossy(&stdout);
        if text.trim().is_empty() {
            return completed_input(udid);
        }
        match serde_json::from_str::<Value>(text.trim()) {
            Ok(result) => ActionCompletion::Completed {
                result_json: result.to_string(),
            },
            Err(error) => ActionCompletion::Failed {
                error_message: format!(
                    "emulator_error: serve-sim exec returned invalid JSON: {error}"
                ),
            },
        }
    }

    fn run_logs(udid: &str, payload: &Value) -> ActionCompletion {
        let last_seconds = payload
            .get("lastSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(30)
            .clamp(1, 300) as u16;
        match run_simctl(&SimctlCommand::LogsSnapshot {
            udid: udid.to_string(),
            last_seconds,
        }) {
            Ok(logs) => ActionCompletion::Completed {
                result_json: serde_json::json!({ "logs": logs, "lastSeconds": last_seconds })
                    .to_string(),
            },
            Err(error) => ActionCompletion::Failed {
                error_message: format!("emulator_error: {error}"),
            },
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

    fn run_rotate(udid: &str, payload: &Value) -> ActionCompletion {
        let Some(orientation) = payload_str(payload, "orientation").filter(|value| {
            matches!(
                *value,
                "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right"
            )
        }) else {
            return invalid_input("orientation is not supported by serve-sim");
        };
        run_serve_sim(&ServeSimInputCommand::Rotate {
            orientation: orientation.to_string(),
            udid: udid.to_string(),
        })
    }

    fn run_serve_sim(command: &ServeSimInputCommand) -> ActionCompletion {
        let udid = command_udid(command);
        let port = match ensure_serve_sim_helper(udid) {
            Ok(port) => port,
            Err(error_message) => return ActionCompletion::Failed { error_message },
        };
        match super::super::emulator_ios_input::send_input(command, port) {
            Ok(()) => completed_input(udid),
            Err(error_message) => ActionCompletion::Failed { error_message },
        }
    }

    fn resolve_serve_sim_executable() -> PathBuf {
        let roots = std::env::current_dir().into_iter().chain(
            std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(Path::to_path_buf)),
        );
        for root in roots {
            for ancestor in root.ancestors() {
                let candidate = ancestor.join("node_modules/.bin/serve-sim");
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
        PathBuf::from("serve-sim")
    }

    fn resolve_serve_sim_helper() -> PathBuf {
        if let Ok(executable) = std::env::current_exe() {
            if let Some(contents) = executable.parent().and_then(Path::parent) {
                let bundled = contents.join("Resources/serve-sim/serve-sim-bin");
                if bundled.is_file() {
                    return bundled;
                }
            }
        }
        if let Ok(current_dir) = std::env::current_dir() {
            for ancestor in current_dir.ancestors() {
                let candidate = ancestor.join("node_modules/serve-sim/bin/serve-sim-bin");
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
        PathBuf::from("serve-sim-bin")
    }

    fn command_udid(command: &ServeSimInputCommand) -> &str {
        match command {
            ServeSimInputCommand::Gesture { udid, .. }
            | ServeSimInputCommand::Tap { udid, .. }
            | ServeSimInputCommand::Type { udid, .. }
            | ServeSimInputCommand::Button { udid, .. }
            | ServeSimInputCommand::Rotate { udid, .. }
            | ServeSimInputCommand::CoreAnimationDebug { udid, .. }
            | ServeSimInputCommand::MemoryWarning { udid } => udid,
        }
    }

    fn completed_input(udid: &str) -> ActionCompletion {
        ActionCompletion::Completed {
            result_json: serde_json::json!({ "ok": true, "deviceUdid": udid }).to_string(),
        }
    }

    fn invalid_input(message: &str) -> ActionCompletion {
        ActionCompletion::Failed {
            error_message: format!("invalid_target: {message}"),
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

    fn boot_active_sessions(
        runtime_url: &str,
        bearer_token: &Option<String>,
        known_devices: &std::collections::HashMap<String, String>,
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
        for (udid, runtime_id) in known_devices {
            if active_device_ids.contains(runtime_id) {
                // Attach is persisted by Go before native startup; reconcile it
                // here so a stopped simulator follows Electron's attach-and-boot contract.
                if let Err(error) = ensure_booted(udid) {
                    eprintln!(
                        "emulator ios provider: failed to boot active simulator {udid}: {error}"
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

    fn register_emulator_device(
        runtime_url: &str,
        bearer_token: &Option<String>,
        device: &SimctlDevice,
        status: EmulatorDeviceStatus,
    ) -> Option<String> {
        let body = serde_json::json!({
            "nativeId": device.udid,
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
            "nativeId": device.udid,
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
                "accessibilityTree".to_string(),
                "logsSnapshot".to_string(),
                "tap".to_string(),
                "gesture".to_string(),
                "type".to_string(),
                "button".to_string(),
                "rotate".to_string(),
                "exec".to_string(),
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
        fn tap_rejects_out_of_range_coordinates_before_invoking_serve_sim() {
            let completion = run_tap("UDID-1", &serde_json::json!({ "x": 1.1, "y": 0.5 }));
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("invalid_target:"));
            assert!(error_message.contains("normalized"));
        }

        #[test]
        fn active_session_parser_ignores_inactive_and_malformed_rows() {
            let ids = active_session_device_ids(
                r#"[
                    {"deviceId":"emu_active","active":true},
                    {"deviceId":"emu_inactive","active":false},
                    {"active":true},
                    "invalid"
                ]"#,
            );
            assert_eq!(
                ids,
                std::collections::HashSet::from(["emu_active".to_string()])
            );
            assert!(active_session_device_ids("not-json").is_empty());
        }

        #[test]
        fn rotate_rejects_non_serve_sim_orientation_before_invoking_tool() {
            let payload = serde_json::json!({ "orientation": "landscapeLeft" });
            let completion = run_rotate("UDID-1", &payload);
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("invalid_target:"));
            assert!(error_message.contains("orientation"));
        }

        #[test]
        fn gesture_rejects_malformed_points_before_invoking_serve_sim() {
            let completion = run_gesture(
                "UDID-1",
                &serde_json::json!({
                    "points": [
                        { "type": "begin", "x": 0.2, "y": 0.3 },
                        { "type": "end", "x": 2.0, "y": 0.4 }
                    ]
                }),
            );
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("invalid_target:"));
        }

        #[test]
        fn resolves_the_repository_installed_serve_sim_before_path_fallback() {
            let executable = resolve_serve_sim_executable();
            assert!(executable.ends_with("node_modules/.bin/serve-sim"));
        }

        #[test]
        fn accessibility_rejects_untrusted_device_identity_before_state_lookup() {
            let completion = run_accessibility("../escape");
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("invalid_target:"));
        }

        #[test]
        fn exec_request_strips_untrusted_target_arguments_and_keeps_timeout() {
            let request = parse_exec_request(&serde_json::json!({
                "argv": [
                    "ca-debug", "blended", "on",
                    "--device", "ATTACKER",
                    "--worktree=other",
                    "-d=ALSO-ATTACKER"
                ],
                "timeoutMs": 1250
            }))
            .unwrap();
            assert_eq!(request.argv, ["ca-debug", "blended", "on"]);
            assert_eq!(request.timeout, Duration::from_millis(1250));
        }

        #[test]
        fn exec_request_rejects_invalid_bounds() {
            assert!(parse_exec_request(&serde_json::json!({ "argv": [] })).is_err());
            assert!(parse_exec_request(&serde_json::json!({
                "argv": ["ca-debug"],
                "timeoutMs": 99
            }))
            .is_err());
            assert!(parse_exec_request(&serde_json::json!({
                "argv": ["ca-debug", "x".repeat(4097)]
            }))
            .is_err());
        }

        #[test]
        fn run_action_rejects_missing_device_id() {
            let action = ClaimedEmulatorAction {
                id: "eact_1".to_string(),
                kind: "emulator.screenshot".to_string(),
                payload: serde_json::json!({}),
            };
            let completion = run_action(&action, &std::collections::HashMap::new());
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
            let completion = run_action(&action, &std::collections::HashMap::new());
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

        #[test]
        fn accessibility_action_resolves_runtime_id_before_validating_native_id() {
            let action = ClaimedEmulatorAction {
                id: "eact_1".to_string(),
                kind: "emulator.ax".to_string(),
                payload: serde_json::json!({ "deviceId": "emu_runtime" }),
            };
            let known = std::collections::HashMap::from([(
                "../escape".to_string(),
                "emu_runtime".to_string(),
            )]);
            let completion = run_action(&action, &known);
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("invalid_target:"));
        }

        #[test]
        fn exec_action_resolves_runtime_id_before_validating_exec_payload() {
            let action = ClaimedEmulatorAction {
                id: "eact_1".to_string(),
                kind: "emulator.exec".to_string(),
                payload: serde_json::json!({
                    "deviceId": "emu_runtime",
                    "argv": ["--device", "ATTACKER"]
                }),
            };
            let known = std::collections::HashMap::from([(
                "UDID-1".to_string(),
                "emu_runtime".to_string(),
            )]);
            let completion = run_action(&action, &known);
            let ActionCompletion::Failed { error_message } = completion else {
                panic!("expected Failed completion");
            };
            assert!(error_message.starts_with("invalid_target:"));
            assert!(error_message.contains("after target filtering"));
        }

        #[test]
        fn runtime_id_cannot_be_overridden_by_payload_udid() {
            let known = std::collections::HashMap::from([(
                "UDID-1".to_string(),
                "emu_runtime".to_string(),
            )]);
            let udid = resolve_native_device_id(
                &serde_json::json!({
                    "deviceId": "emu_runtime",
                    "udid": "UDID-ATTACKER"
                }),
                &known,
            )
            .unwrap();
            assert_eq!(udid, "UDID-1");
        }
    }
}
