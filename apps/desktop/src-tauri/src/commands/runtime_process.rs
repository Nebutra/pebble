use std::env;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct RuntimeProcessState {
    process: Mutex<Option<RuntimeProcessHandle>>,
    last_reported_failure: Mutex<Option<RuntimeFailureReport>>,
}

const RUNTIME_FAILURE_REPORT_WINDOW: Duration = Duration::from_secs(30);
const RUNTIME_STARTUP_GRACE: Duration = Duration::from_secs(5);

struct RuntimeFailureReport {
    executable: String,
    listen: String,
    exit_code: Option<i32>,
    reported_at: Instant,
}

struct RuntimeProcessHandle {
    child: Child,
    executable: String,
    listen: String,
    bearer_token: Option<String>,
    started_at: Instant,
}

impl Drop for RuntimeProcessHandle {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            // The desktop shell owns this child; do not leave a runtime process orphaned on exit.
            let _ = kill_runtime_child(&mut self.child);
            let _ = self.child.wait();
        }
    }
}

struct RuntimeSpawnPlan {
    executable: String,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    display_executable: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProcessStartCommand {
    #[serde(default = "default_runtime_executable")]
    pub executable: String,
    #[serde(default = "default_listen_address")]
    pub listen: String,
    #[serde(default)]
    pub data_dir: Option<String>,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProcessStatusResult {
    pub running: bool,
    pub pid: Option<u32>,
    pub executable: Option<String>,
    pub listen: Option<String>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

#[tauri::command]
pub fn start_runtime_process(
    app: AppHandle,
    input: RuntimeProcessStartCommand,
    state: State<'_, RuntimeProcessState>,
) -> Result<RuntimeProcessStatusResult, String> {
    let mut process = state
        .process
        .lock()
        .map_err(|_| "runtime process state lock is poisoned".to_string())?;
    let current = refresh_process_status(&app, &state, &mut process);
    if current.running {
        return Err("runtime process is already running".to_string());
    }

    let executable =
        normalize_text(input.executable.as_str()).unwrap_or_else(default_runtime_executable);
    let listen = normalize_text(input.listen.as_str()).unwrap_or_else(default_listen_address);
    let args = runtime_process_args(&input, &listen);
    let bearer_token = normalize_optional_text(input.bearer_token.as_deref());
    let relay_worker_bundle_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|directory| directory.join("binaries").join("relay-workers"));
    let (child, display_executable) = spawn_runtime_process(
        &executable,
        &args,
        bearer_token.as_deref(),
        relay_worker_bundle_dir.as_deref(),
    )?;
    let pid = child.id();
    *process = Some(RuntimeProcessHandle {
        child,
        executable: display_executable.clone(),
        listen: listen.clone(),
        bearer_token,
        started_at: Instant::now(),
    });

    Ok(RuntimeProcessStatusResult {
        running: true,
        pid: Some(pid),
        executable: Some(display_executable),
        listen: Some(listen),
        exit_code: None,
        error: None,
    })
}

#[tauri::command]
pub fn stop_runtime_process(
    state: State<'_, RuntimeProcessState>,
) -> Result<RuntimeProcessStatusResult, String> {
    stop_managed_runtime_process(&state)
}

pub fn stop_managed_runtime_process(
    state: &RuntimeProcessState,
) -> Result<RuntimeProcessStatusResult, String> {
    let mut process = state
        .process
        .lock()
        .map_err(|_| "runtime process state lock is poisoned".to_string())?;
    let Some(mut handle) = process.take() else {
        return Ok(stopped_status(None));
    };

    let kill_error = kill_runtime_child(&mut handle.child).err();
    let exit_code = handle.child.wait().ok().and_then(|status| status.code());

    Ok(RuntimeProcessStatusResult {
        running: false,
        pid: None,
        executable: Some(handle.executable.clone()),
        listen: Some(handle.listen.clone()),
        exit_code,
        error: kill_error,
    })
}

fn kill_runtime_child(child: &mut Child) -> Result<(), String> {
    #[cfg(unix)]
    {
        // Why: the Tauri-owned Go runtime is the first production consumer of
        // the Zig system ABI; Rust still owns wait/reaping and crash reporting.
        crate::zig_system::kill_process(child.id())
    }
    #[cfg(not(unix))]
    {
        child.kill().map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn runtime_process_status(
    app: AppHandle,
    state: State<'_, RuntimeProcessState>,
) -> Result<RuntimeProcessStatusResult, String> {
    let mut process = state
        .process
        .lock()
        .map_err(|_| "runtime process state lock is poisoned".to_string())?;

    Ok(refresh_process_status(&app, &state, &mut process))
}

fn refresh_process_status(
    app: &AppHandle,
    state: &RuntimeProcessState,
    process: &mut Option<RuntimeProcessHandle>,
) -> RuntimeProcessStatusResult {
    let Some(handle) = process.as_mut() else {
        return stopped_status(None);
    };

    match handle.child.try_wait() {
        Ok(Some(status)) => {
            let finished = process.take().expect("process handle exists");
            let exit_code = status.code();
            if should_report_runtime_exit(status.success(), finished.started_at.elapsed())
                && state.claim_failure_report(
                    &finished.executable,
                    &finished.listen,
                    exit_code,
                    Instant::now(),
                )
            {
                let mut details = serde_json::Map::new();
                details.insert("executable".to_string(), finished.executable.clone().into());
                details.insert("listen".to_string(), finished.listen.clone().into());
                if let Some(code) = exit_code {
                    details.insert("exit_code".to_string(), code.into());
                }
                let _ = super::crash_reports::record_native_process_failure(
                    app,
                    "go-runtime",
                    "runtime-process-exited",
                    exit_code,
                    details,
                );
            }
            RuntimeProcessStatusResult {
                running: false,
                pid: None,
                executable: Some(finished.executable.clone()),
                listen: Some(finished.listen.clone()),
                exit_code,
                error: None,
            }
        }
        Ok(None) => RuntimeProcessStatusResult {
            running: true,
            pid: Some(handle.child.id()),
            executable: Some(handle.executable.clone()),
            listen: Some(handle.listen.clone()),
            exit_code: None,
            error: None,
        },
        Err(error) => RuntimeProcessStatusResult {
            running: true,
            pid: Some(handle.child.id()),
            executable: Some(handle.executable.clone()),
            listen: Some(handle.listen.clone()),
            exit_code: None,
            error: Some(error.to_string()),
        },
    }
}

fn should_report_runtime_exit(success: bool, lifetime: Duration) -> bool {
    // Why: app replacement can briefly race the previous runtime for its port.
    // The renderer owns bounded startup retries; only a settled child is a crash.
    !success && lifetime >= RUNTIME_STARTUP_GRACE
}

impl RuntimeProcessState {
    pub(crate) fn local_connection(&self) -> Result<Option<(String, Option<String>)>, String> {
        let process = self
            .process
            .lock()
            .map_err(|_| "runtime process state lock is poisoned".to_string())?;
        Ok(process.as_ref().map(|handle| {
            (
                format!("http://{}", handle.listen),
                handle.bearer_token.clone(),
            )
        }))
    }

    fn claim_failure_report(
        &self,
        executable: &str,
        listen: &str,
        exit_code: Option<i32>,
        now: Instant,
    ) -> bool {
        let Ok(mut previous) = self.last_reported_failure.lock() else {
            return true;
        };
        let duplicate = previous.as_ref().is_some_and(|candidate| {
            candidate.executable == executable
                && candidate.listen == listen
                && candidate.exit_code == exit_code
                && now.saturating_duration_since(candidate.reported_at)
                    < RUNTIME_FAILURE_REPORT_WINDOW
        });
        if duplicate {
            return false;
        }
        // Why: concurrent startup callers may repeatedly spawn the same broken
        // sidecar; keep one actionable crash record per short failure incident.
        *previous = Some(RuntimeFailureReport {
            executable: executable.to_string(),
            listen: listen.to_string(),
            exit_code,
            reported_at: now,
        });
        true
    }
}

fn runtime_process_args(input: &RuntimeProcessStartCommand, listen: &str) -> Vec<String> {
    let mut args = vec!["--listen".to_string(), listen.to_string()];
    if let Some(data_dir) = normalize_optional_text(input.data_dir.as_deref()) {
        args.extend(["--data-dir".to_string(), data_dir]);
    }
    args.extend(runtime_extra_args_without_token(&input.extra_args));

    args
}

fn runtime_extra_args_without_token(extra_args: &[String]) -> Vec<String> {
    let mut result = Vec::new();
    let mut skip_next = false;
    for arg in extra_args {
        let Some(arg) = normalize_text(arg) else {
            continue;
        };
        if skip_next {
            skip_next = false;
            continue;
        }
        // Extra args are developer-facing; keep bearer tokens out of process argv.
        if is_runtime_token_arg(&arg) {
            skip_next = arg == "--token" || arg == "-token";
            continue;
        }
        result.push(arg);
    }
    result
}

fn is_runtime_token_arg(arg: &str) -> bool {
    arg == "--token" || arg == "-token" || arg.starts_with("--token=") || arg.starts_with("-token=")
}

fn spawn_runtime_process(
    executable: &str,
    args: &[String],
    bearer_token: Option<&str>,
    relay_worker_bundle_dir: Option<&Path>,
) -> Result<(Child, String), String> {
    let primary = RuntimeSpawnPlan {
        executable: executable.to_string(),
        args: args.to_vec(),
        cwd: None,
        display_executable: executable.to_string(),
    };

    match spawn_runtime_plan(&primary, bearer_token, relay_worker_bundle_dir) {
        Ok(child) => Ok((child, primary.display_executable)),
        Err(error) if should_try_go_run_fallback(executable, &error) => {
            let Some(fallback) = go_run_runtime_spawn_plan(args) else {
                return Err(format!("failed to start runtime process: {error}"));
            };
            let display_executable = fallback.display_executable.clone();
            spawn_runtime_plan(&fallback, bearer_token, relay_worker_bundle_dir)
                .map(|child| (child, display_executable))
                .map_err(|fallback_error| {
                    format!(
                        "failed to start runtime process: {error}; go run fallback failed: {fallback_error}"
                    )
                })
        }
        Err(error) => Err(format!("failed to start runtime process: {error}")),
    }
}

fn spawn_runtime_plan(
    plan: &RuntimeSpawnPlan,
    bearer_token: Option<&str>,
    relay_worker_bundle_dir: Option<&Path>,
) -> io::Result<Child> {
    let mut command = Command::new(&plan.executable);
    command
        .args(&plan.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(cwd) = &plan.cwd {
        command.current_dir(cwd);
    }
    if let Some(token) = bearer_token {
        // Keep bearer tokens out of argv because process lists can expose command-line args.
        command.env("PEBBLE_RUNTIME_TOKEN", token);
    }
    if let Some(directory) = relay_worker_bundle_dir {
        // Why: the runtime may deploy to a different SSH OS/architecture; only
        // expose Tauri's signed resource matrix, never a renderer-provided path.
        command.env("PEBBLE_RELAY_WORKER_BUNDLE_DIR", directory);
    }
    command.env("PEBBLE_RUNTIME_PARENT_PID", std::process::id().to_string());

    command.spawn()
}

fn should_try_go_run_fallback(executable: &str, error: &io::Error) -> bool {
    executable == default_runtime_executable() && error.kind() == io::ErrorKind::NotFound
}

fn go_run_runtime_spawn_plan(runtime_args: &[String]) -> Option<RuntimeSpawnPlan> {
    let root = find_pebble_source_root()?;
    let go_runtime_dir = root.join("runtime/go");
    let mut args = vec!["run".to_string(), "./cmd/pebble-runtime".to_string()];
    args.extend(runtime_args.iter().cloned());

    Some(RuntimeSpawnPlan {
        executable: "go".to_string(),
        args,
        cwd: Some(go_runtime_dir),
        display_executable: "go run ./cmd/pebble-runtime".to_string(),
    })
}

fn find_pebble_source_root() -> Option<PathBuf> {
    runtime_search_start_dirs()
        .into_iter()
        .flat_map(|start| start.ancestors().map(Path::to_path_buf).collect::<Vec<_>>())
        .find(|candidate| candidate.join("runtime/go/cmd/pebble-runtime").is_dir())
}

fn runtime_search_start_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(current_dir) = env::current_dir() {
        dirs.push(current_dir);
    }
    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    if let Some(manifest_dir) = option_env!("CARGO_MANIFEST_DIR") {
        dirs.push(PathBuf::from(manifest_dir));
    }

    dirs
}

fn stopped_status(error: Option<String>) -> RuntimeProcessStatusResult {
    RuntimeProcessStatusResult {
        running: false,
        pid: None,
        executable: None,
        listen: None,
        exit_code: None,
        error,
    }
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    value.and_then(normalize_text)
}

fn normalize_text(value: impl AsRef<str>) -> Option<String> {
    let trimmed = value.as_ref().trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn default_runtime_executable() -> String {
    if let Ok(current) = env::current_exe() {
        if let Some(parent) = current.parent() {
            let bundled = parent.join(runtime_binary_name());
            if bundled.is_file() {
                return bundled.to_string_lossy().into_owned();
            }
        }
    }
    "pebble-runtime".to_string()
}

fn runtime_binary_name() -> &'static str {
    if cfg!(windows) {
        "pebble-runtime.exe"
    } else {
        "pebble-runtime"
    }
}

fn default_listen_address() -> String {
    "127.0.0.1:17777".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn zig_signal_boundary_stops_a_tauri_owned_child() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("spawn test child");
        kill_runtime_child(&mut child).expect("kill child through Zig ABI");
        let status = child.wait().expect("reap test child");
        assert!(!status.success());
    }

    #[test]
    fn builds_launch_args_without_leaking_token_to_argv() {
        let input = RuntimeProcessStartCommand {
            executable: "pebble-runtime".to_string(),
            listen: "127.0.0.1:18888".to_string(),
            data_dir: Some("/tmp/pebble".to_string()),
            bearer_token: Some("secret".to_string()),
            extra_args: vec![
                "--token".to_string(),
                "secret".to_string(),
                "--verbose".to_string(),
                "-token=other".to_string(),
            ],
        };

        assert_eq!(
            runtime_process_args(&input, "127.0.0.1:18888"),
            vec![
                "--listen",
                "127.0.0.1:18888",
                "--data-dir",
                "/tmp/pebble",
                "--verbose"
            ]
        );
    }

    #[test]
    fn omits_blank_optional_runtime_flags() {
        let input = RuntimeProcessStartCommand {
            executable: "pebble-runtime".to_string(),
            listen: "127.0.0.1:17777".to_string(),
            data_dir: Some(" ".to_string()),
            bearer_token: Some("".to_string()),
            extra_args: vec![" ".to_string()],
        };

        assert_eq!(
            runtime_process_args(&input, "127.0.0.1:17777"),
            vec!["--listen", "127.0.0.1:17777"]
        );
    }

    #[test]
    fn builds_go_run_fallback_plan_from_source_root() {
        let plan =
            go_run_runtime_spawn_plan(&["--listen".to_string(), "127.0.0.1:17777".to_string()])
                .expect("source root should be discoverable from Cargo manifest directory");

        assert_eq!(plan.executable, "go");
        assert_eq!(
            plan.args,
            vec!["run", "./cmd/pebble-runtime", "--listen", "127.0.0.1:17777"]
        );
        assert!(plan
            .cwd
            .expect("fallback should set source root")
            .join("cmd/pebble-runtime")
            .is_dir());
    }

    #[test]
    fn fallback_is_limited_to_default_missing_runtime_binary() {
        assert!(should_try_go_run_fallback(
            "pebble-runtime",
            &io::Error::from(io::ErrorKind::NotFound)
        ));
        assert!(!should_try_go_run_fallback(
            "custom-runtime",
            &io::Error::from(io::ErrorKind::NotFound)
        ));
    }

    #[test]
    fn duplicate_runtime_failures_are_coalesced_per_incident() {
        let state = RuntimeProcessState::default();
        let started = Instant::now();
        assert!(state.claim_failure_report("runtime", "127.0.0.1:17777", Some(1), started));
        assert!(!state.claim_failure_report(
            "runtime",
            "127.0.0.1:17777",
            Some(1),
            started + Duration::from_secs(1),
        ));
        assert!(state.claim_failure_report(
            "runtime",
            "127.0.0.1:17778",
            Some(1),
            started + Duration::from_secs(1),
        ));
        assert!(state.claim_failure_report(
            "runtime",
            "127.0.0.1:17777",
            Some(1),
            started + RUNTIME_FAILURE_REPORT_WINDOW,
        ));
    }

    #[test]
    fn startup_handoff_exit_is_not_reported_as_a_runtime_crash() {
        assert!(!should_report_runtime_exit(
            false,
            RUNTIME_STARTUP_GRACE - Duration::from_millis(1)
        ));
        assert!(should_report_runtime_exit(false, RUNTIME_STARTUP_GRACE));
        assert!(!should_report_runtime_exit(true, Duration::from_secs(60)));
    }
}
