use std::collections::HashMap;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::emulator_android_exec::{run_bounded_native_command, AndroidExecResult};

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MIN_TIMEOUT_MS: u64 = 100;
const MAX_TIMEOUT_MS: u64 = 30_000;

#[derive(Default)]
pub struct EmulatorIosPermissionState {
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorIosPermissionCommand {
    pub operation_id: String,
    pub serial: String,
    pub operation: String,
    pub package: Option<String>,
    pub permission: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorIosPermissionResult {
    pub ok: bool,
    pub operation_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorIosPermissionCancelResult {
    pub cancelled: bool,
}

#[tauri::command]
pub async fn emulator_ios_permission_set(
    state: State<'_, EmulatorIosPermissionState>,
    input: EmulatorIosPermissionCommand,
) -> Result<EmulatorIosPermissionResult, String> {
    let request = validate_request(input)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut operations = state
            .cancellations
            .lock()
            .map_err(|_| "iOS permission state was poisoned".to_string())?;
        if operations.contains_key(&request.operation_id) {
            return Err("invalid_target: permission operationId is already active".to_string());
        }
        operations.insert(request.operation_id.clone(), cancelled.clone());
    }

    let operation_id = request.operation_id.clone();
    let worker_result =
        tauri::async_runtime::spawn_blocking(move || run_permission(request, &cancelled)).await;
    state
        .cancellations
        .lock()
        .map_err(|_| "iOS permission state was poisoned".to_string())?
        .remove(&operation_id);
    worker_result
        .map_err(|error| format!("emulator_error: iOS permission worker failed: {error}"))??;
    Ok(EmulatorIosPermissionResult {
        ok: true,
        operation_id,
    })
}

#[tauri::command]
pub fn emulator_ios_permission_cancel(
    state: State<'_, EmulatorIosPermissionState>,
    operation_id: String,
) -> Result<EmulatorIosPermissionCancelResult, String> {
    let operation_id = validate_operation_id(&operation_id)?;
    let cancelled = state
        .cancellations
        .lock()
        .map_err(|_| "iOS permission state was poisoned".to_string())?
        .get(operation_id)
        .cloned();
    if let Some(cancelled) = cancelled.as_ref() {
        cancelled.store(true, Ordering::SeqCst);
    }
    Ok(EmulatorIosPermissionCancelResult {
        cancelled: cancelled.is_some(),
    })
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

fn validate_request(
    mut input: EmulatorIosPermissionCommand,
) -> Result<EmulatorIosPermissionCommand, String> {
    input.operation_id = validate_operation_id(&input.operation_id)?.to_string();
    if !is_safe_identifier(&input.serial, 64) {
        return Err("invalid_target: serial must be a bounded Simulator UDID".to_string());
    }
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&input.timeout_ms) {
        return Err(format!(
            "invalid_target: timeoutMs must be an integer from {MIN_TIMEOUT_MS} to {MAX_TIMEOUT_MS}"
        ));
    }
    match input.operation.as_str() {
        "grant" | "revoke" => {
            if !is_safe_service(input.permission.as_deref().unwrap_or_default()) {
                return Err(
                    "invalid_target: permission must name a simctl privacy service".to_string(),
                );
            }
            if !is_safe_bundle_id(input.package.as_deref().unwrap_or_default()) {
                return Err(
                    "invalid_target: package must be an application bundle identifier".to_string(),
                );
            }
        }
        "reset" => {
            if input
                .permission
                .as_deref()
                .is_some_and(|value| !is_safe_service(value))
            {
                return Err(
                    "invalid_target: permission must name a simctl privacy service".to_string(),
                );
            }
            if input
                .package
                .as_deref()
                .is_some_and(|value| !is_safe_bundle_id(value))
            {
                return Err(
                    "invalid_target: package must be an application bundle identifier".to_string(),
                );
            }
        }
        _ => return Err("invalid_target: operation must be grant, revoke, or reset".to_string()),
    }
    Ok(input)
}

fn validate_operation_id(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if !is_safe_identifier(value, 128) {
        return Err("invalid_target: operationId contains unsupported characters".to_string());
    }
    Ok(value)
}

fn is_safe_identifier(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_safe_bundle_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value.split('.').count() >= 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn is_safe_service(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
}

fn permission_argv(input: &EmulatorIosPermissionCommand) -> Vec<String> {
    let mut argv = vec![
        "simctl".to_string(),
        "privacy".to_string(),
        input.serial.clone(),
        input.operation.clone(),
    ];
    if let Some(permission) = input.permission.as_ref() {
        argv.push(permission.clone());
    }
    if let Some(package) = input.package.as_ref() {
        argv.push(package.clone());
    }
    argv
}

fn run_permission(
    input: EmulatorIosPermissionCommand,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let mut command = Command::new("xcrun");
    command.args(permission_argv(&input));
    match run_bounded_native_command(
        command,
        "xcrun simctl privacy",
        Duration::from_millis(input.timeout_ms),
        cancelled,
        || false,
    ) {
        Ok(result) if result.exit_code == Some(0) => Ok(()),
        Ok(result) => Err(format!(
            "emulator_error: simctl privacy command failed: {}",
            error_detail(&result)
        )),
        Err(error) if error == "exec was canceled" => {
            Err("cancelled: iOS permission operation was cancelled".to_string())
        }
        Err(error) if error.starts_with("exec timed out") => Err(format!("timeout: {error}")),
        Err(error) => Err(format!("emulator_error: {error}")),
    }
}

fn error_detail(result: &AndroidExecResult) -> String {
    let detail = format!("{}\n{}", result.stdout, result.stderr);
    let detail = detail.trim();
    if detail.is_empty() {
        format!("exit status {:?} with no output", result.exit_code)
    } else if result.truncated {
        format!("{detail} [output truncated]")
    } else {
        detail.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(operation: &str) -> EmulatorIosPermissionCommand {
        EmulatorIosPermissionCommand {
            operation_id: "permission-1".to_string(),
            serial: "AAAAAAAA-0000-0000-0000-000000000001".to_string(),
            operation: operation.to_string(),
            package: None,
            permission: None,
            timeout_ms: 2_000,
        }
    }

    #[test]
    fn builds_shell_free_simctl_privacy_argv() {
        let mut grant = request("grant");
        grant.permission = Some("camera".to_string());
        grant.package = Some("com.example.app".to_string());
        let grant = validate_request(grant).unwrap();
        assert_eq!(
            permission_argv(&grant),
            [
                "simctl",
                "privacy",
                "AAAAAAAA-0000-0000-0000-000000000001",
                "grant",
                "camera",
                "com.example.app"
            ]
        );
        assert_eq!(
            permission_argv(&validate_request(request("reset")).unwrap()),
            [
                "simctl",
                "privacy",
                "AAAAAAAA-0000-0000-0000-000000000001",
                "reset"
            ]
        );
    }

    #[test]
    fn rejects_invalid_ios_permission_shapes_and_bounds() {
        let mut grant = request("grant");
        grant.permission = Some("camera".to_string());
        assert!(validate_request(grant).unwrap_err().contains("package"));

        let mut reset = request("reset");
        reset.permission = Some("../camera".to_string());
        assert!(validate_request(reset).unwrap_err().contains("permission"));

        let mut invalid = request("grant");
        invalid.permission = Some("camera".to_string());
        invalid.package = Some("com.example.app;rm".to_string());
        assert!(validate_request(invalid).unwrap_err().contains("package"));
    }
}
