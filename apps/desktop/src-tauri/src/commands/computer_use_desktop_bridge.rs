#![cfg(any(target_os = "linux", target_os = "windows"))]

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::Manager;

use super::computer_use_action_translation::ExecutorFailure;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BRIDGE_OUTPUT_BYTES: u64 = 20 * 1024 * 1024;

pub fn invoke_desktop_script(
    script_path: &Path,
    operation: &Value,
) -> Result<Value, ExecutorFailure> {
    let directory = tempfile::Builder::new()
        .prefix("pebble-computer-use-")
        .tempdir()
        .map_err(accessibility_failure)?;
    let operation_path = directory.path().join("operation.json");
    fs::write(
        &operation_path,
        serde_json::to_vec(operation).map_err(accessibility_failure)?,
    )
    .map_err(accessibility_failure)?;
    let stdout_path = directory.path().join("stdout.json");
    let stderr_path = directory.path().join("stderr.txt");
    let stdout = File::create(&stdout_path).map_err(accessibility_failure)?;
    let stderr = File::create(&stderr_path).map_err(accessibility_failure)?;
    let mut child = platform_command(script_path, &operation_path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(accessibility_failure)?;
    let deadline = Instant::now() + REQUEST_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().map_err(accessibility_failure)? {
            if !status.success() {
                return Err(map_script_failure(read_bounded(&stderr_path)?));
            }
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ExecutorFailure::new(
                "action_timeout",
                "desktop provider timed out after 30000ms",
            ));
        }
        thread::sleep(Duration::from_millis(20));
    }
    let response: Value =
        serde_json::from_slice(&read_bounded_bytes(&stdout_path)?).map_err(|error| {
            ExecutorFailure::new(
                "accessibility_error",
                format!("desktop provider returned invalid JSON: {error}"),
            )
        })?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(map_script_failure(
            response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("desktop provider failed")
                .to_string(),
        ));
    }
    Ok(response)
}

pub fn resolve_desktop_script(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PEBBLE_COMPUTER_DESKTOP_SCRIPT_PROVIDER_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let (directory, filename, source) = platform_paths();
    let mut candidates = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join(directory).join(filename));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(source).join(filename));
        candidates.push(cwd.join("..").join("..").join(source).join(filename));
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(target_os = "linux")]
fn platform_paths() -> (&'static str, &'static str, &'static str) {
    (
        "computer-use-linux",
        "runtime.py",
        "native/computer-use-linux",
    )
}

#[cfg(target_os = "windows")]
fn platform_paths() -> (&'static str, &'static str, &'static str) {
    (
        "computer-use-windows",
        "runtime.ps1",
        "native/computer-use-windows",
    )
}

#[cfg(target_os = "linux")]
fn platform_command(script: &Path, operation: &Path) -> Command {
    let mut command = Command::new("python3");
    command.arg(script).arg(operation);
    command
}

#[cfg(target_os = "windows")]
fn platform_command(script: &Path, operation: &Path) -> Command {
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]);
    command.arg(script).arg(operation);
    command
}

fn read_bounded(path: &Path) -> Result<String, ExecutorFailure> {
    Ok(String::from_utf8_lossy(&read_bounded_bytes(path)?).into_owned())
}

fn read_bounded_bytes(path: &Path) -> Result<Vec<u8>, ExecutorFailure> {
    if fs::metadata(path).map_err(accessibility_failure)?.len() > MAX_BRIDGE_OUTPUT_BYTES {
        return Err(ExecutorFailure::new(
            "accessibility_error",
            "desktop provider output exceeded 20 MiB",
        ));
    }
    fs::read(path).map_err(accessibility_failure)
}

fn accessibility_failure(error: impl std::fmt::Display) -> ExecutorFailure {
    ExecutorFailure::new("accessibility_error", error.to_string())
}

fn map_script_failure(message: String) -> ExecutorFailure {
    let lower = message.to_ascii_lowercase();
    // Preserve provider-owned typed failures before inspecting explanatory text;
    // permission guidance in a focus/screenshot error must not change its code.
    let code = if lower.starts_with("invalid_argument:") {
        "invalid_argument"
    } else if lower.starts_with("window_not_focused:")
        || (lower.contains("keyboard input requires")
            && lower.contains("window")
            && lower.contains("focused"))
    {
        "window_not_focused"
    } else if lower.starts_with("screenshot_failed:")
        || lower.contains("screenshot failed")
        || lower.contains("screen recording")
        || lower.contains("payload cap")
    {
        "screenshot_failed"
    } else if lower.contains("app not found") || lower.contains("appnotfound") {
        "app_not_found"
    } else if lower.contains("appblocked") || lower.contains("app blocked") {
        "app_blocked"
    } else if lower.contains("modulenotfounderror: no module named 'gi'")
        || lower.contains("pygobject")
        || lower.contains("gdk is required")
    {
        "unsupported_capability"
    } else if lower.contains("permission") || lower.contains("dbus") || lower.contains("at-spi") {
        "permission_denied"
    } else if lower.contains("window") && lower.contains("not found") {
        "window_not_found"
    } else if lower.contains("stale element") || lower.contains("unknown element") {
        "element_not_found"
    } else if lower.contains("not settable") {
        "value_not_settable"
    } else if lower.contains("not a valid secondary action")
        || (lower.contains("action") && lower.contains("not supported"))
    {
        "action_not_supported"
    } else if lower.contains("unsupported") {
        "unsupported_capability"
    } else {
        "accessibility_error"
    };
    ExecutorFailure::new(code, message.trim())
}

#[cfg(test)]
mod tests {
    use super::map_script_failure;

    #[test]
    fn preserves_provider_owned_error_codes_before_permission_hints() {
        for (message, expected) in [
            ("invalid_argument: missing text", "invalid_argument"),
            (
                "window_not_focused: bring it forward or check Accessibility permissions",
                "window_not_focused",
            ),
            (
                "screenshot_failed: Screen Recording permission is required",
                "screenshot_failed",
            ),
        ] {
            assert_eq!(map_script_failure(message.to_string()).code, expected);
        }
    }

    #[test]
    fn maps_desktop_provider_failure_vocabulary() {
        for (message, expected) in [
            ("app not found", "app_not_found"),
            ("app blocked by policy", "app_blocked"),
            ("DBUS session is unavailable", "permission_denied"),
            ("window 2 not found", "window_not_found"),
            ("stale element 4", "element_not_found"),
            ("value is not settable", "value_not_settable"),
            ("not a valid secondary action", "action_not_supported"),
            (
                "GDK is required for key synthesis",
                "unsupported_capability",
            ),
            ("unclassified bridge failure", "accessibility_error"),
        ] {
            assert_eq!(map_script_failure(message.to_string()).code, expected);
        }
    }
}
