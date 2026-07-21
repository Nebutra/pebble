use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::emulator_android_adb::{is_valid_android_package_name, AdbCommand};
use super::emulator_android_exec::{run_bounded_adb_command, AndroidExecResult};

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MIN_TIMEOUT_MS: u64 = 100;
const MAX_TIMEOUT_MS: u64 = 30_000;

#[derive(Default)]
pub struct EmulatorAndroidPermissionState {
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorAndroidPermissionCommand {
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
pub struct EmulatorAndroidPermissionResult {
    pub ok: bool,
    pub operation_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorAndroidPermissionCancelResult {
    pub cancelled: bool,
}

#[tauri::command]
pub async fn emulator_android_permission_set(
    state: State<'_, EmulatorAndroidPermissionState>,
    input: EmulatorAndroidPermissionCommand,
) -> Result<EmulatorAndroidPermissionResult, String> {
    let request = validate_request(input)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut operations = state
            .cancellations
            .lock()
            .map_err(|_| "emulator permission state was poisoned".to_string())?;
        if operations.contains_key(&request.operation_id) {
            return Err("invalid_target: permission operationId is already active".to_string());
        }
        operations.insert(request.operation_id.clone(), cancelled.clone());
    }

    let operation_id = request.operation_id.clone();
    let worker_result =
        tauri::async_runtime::spawn_blocking(move || run_permission(request, &cancelled)).await;
    // Why: operation ids must be reusable even if the blocking task panics;
    // otherwise one native failure permanently poisons cancellation state.
    state
        .cancellations
        .lock()
        .map_err(|_| "emulator permission state was poisoned".to_string())?
        .remove(&operation_id);
    let result = worker_result
        .map_err(|error| format!("emulator_error: permission worker failed: {error}"))?;
    result?;
    Ok(EmulatorAndroidPermissionResult {
        ok: true,
        operation_id,
    })
}

#[tauri::command]
pub fn emulator_android_permission_cancel(
    state: State<'_, EmulatorAndroidPermissionState>,
    operation_id: String,
) -> Result<EmulatorAndroidPermissionCancelResult, String> {
    let operation_id = validate_operation_id(&operation_id)?;
    let cancelled = state
        .cancellations
        .lock()
        .map_err(|_| "emulator permission state was poisoned".to_string())?
        .get(operation_id)
        .cloned();
    if let Some(cancelled) = cancelled.as_ref() {
        cancelled.store(true, Ordering::SeqCst);
    }
    Ok(EmulatorAndroidPermissionCancelResult {
        cancelled: cancelled.is_some(),
    })
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

fn validate_request(
    mut input: EmulatorAndroidPermissionCommand,
) -> Result<EmulatorAndroidPermissionCommand, String> {
    input.operation_id = validate_operation_id(&input.operation_id)?.to_string();
    if input.serial.trim().is_empty()
        || input.serial.len() > 255
        || input.serial.contains(char::is_whitespace)
    {
        return Err("invalid_target: serial must be a non-empty adb device identifier".to_string());
    }
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&input.timeout_ms) {
        return Err(format!(
            "invalid_target: timeoutMs must be an integer from {MIN_TIMEOUT_MS} to {MAX_TIMEOUT_MS}"
        ));
    }
    match input.operation.as_str() {
        "reset" => {
            if input.package.is_some() || input.permission.is_some() {
                return Err(
                    "invalid_target: reset does not accept package or permission".to_string(),
                );
            }
        }
        "grant" | "revoke" => {
            let package = input.package.as_deref().unwrap_or_default();
            let permission = input.permission.as_deref().unwrap_or_default();
            if !is_valid_android_package_name(package) {
                return Err(
                    "invalid_target: package is not a valid Android application ID".to_string(),
                );
            }
            if !is_valid_android_package_name(permission) {
                return Err(
                    "invalid_target: permission is not a valid Android permission name".to_string(),
                );
            }
        }
        _ => return Err("invalid_target: operation must be grant, revoke, or reset".to_string()),
    }
    Ok(input)
}

fn validate_operation_id(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid_target: operationId contains unsupported characters".to_string());
    }
    Ok(value)
}

fn run_permission(
    input: EmulatorAndroidPermissionCommand,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let command = AdbCommand::Permission {
        serial: input.serial,
        operation: if input.operation == "reset" {
            "reset-permissions".to_string()
        } else {
            input.operation
        },
        package: input.package,
        permission: input.permission,
    };
    match run_bounded_adb_command(
        &command,
        Duration::from_millis(input.timeout_ms),
        cancelled,
        || false,
    ) {
        Ok(result) if result.exit_code == Some(0) => Ok(()),
        Ok(result) => Err(format!(
            "emulator_error: adb permission command failed: {}",
            error_detail(&result)
        )),
        Err(error) if error == "exec was canceled" => {
            Err("cancelled: Android permission operation was cancelled".to_string())
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

    fn request(operation: &str) -> EmulatorAndroidPermissionCommand {
        EmulatorAndroidPermissionCommand {
            operation_id: "permission-1".to_string(),
            serial: "emulator-5554".to_string(),
            operation: operation.to_string(),
            package: None,
            permission: None,
            timeout_ms: 2_000,
        }
    }

    #[test]
    fn accepts_android_permission_contract() {
        let mut grant = request("grant");
        grant.package = Some("com.example.app".to_string());
        grant.permission = Some("android.permission.CAMERA".to_string());
        assert!(validate_request(grant).is_ok());
        assert!(validate_request(request("reset")).is_ok());
    }

    #[test]
    fn rejects_invalid_operation_shapes_and_bounds() {
        let mut grant = request("grant");
        grant.package = Some("com.example.app".to_string());
        assert!(validate_request(grant).unwrap_err().contains("permission"));

        let mut reset = request("reset");
        reset.package = Some("com.example.app".to_string());
        assert!(validate_request(reset)
            .unwrap_err()
            .contains("does not accept"));

        let mut timeout = request("reset");
        timeout.timeout_ms = MAX_TIMEOUT_MS + 1;
        assert!(validate_request(timeout).unwrap_err().contains("timeoutMs"));
    }

    #[test]
    fn builds_shell_free_permission_argv() {
        let command = AdbCommand::Permission {
            serial: "emulator-5554".to_string(),
            operation: "grant".to_string(),
            package: Some("com.example.app".to_string()),
            permission: Some("android.permission.CAMERA".to_string()),
        };
        assert_eq!(
            command.to_argv(),
            [
                "-s",
                "emulator-5554",
                "shell",
                "pm",
                "grant",
                "com.example.app",
                "android.permission.CAMERA"
            ]
        );
    }
}
