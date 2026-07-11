use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;
use uuid::Uuid;

const HELPER_APP_NAME: &str = "Pebble Computer Use.app";
const HELPER_EXECUTABLE_NAME: &str = "pebble-computer-use-macos";
const DEFAULT_HELPER_BUNDLE_ID: &str = "nebutra.pebble.computer-use";
const STATUS_HELPER_LAUNCH_TIMEOUT: Duration = Duration::from_secs(5);
const STATUS_FILE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ComputerUsePermissionId {
    Accessibility,
    Screenshots,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUsePermissionSetupInput {
    id: Option<ComputerUsePermissionId>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ComputerUsePermissionStatus {
    Granted,
    NotGranted,
    Unsupported,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComputerUsePermissionState {
    id: ComputerUsePermissionId,
    status: ComputerUsePermissionStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUsePermissionStatusResult {
    platform: &'static str,
    helper_app_path: Option<String>,
    helper_unavailable_reason: Option<String>,
    permissions: Vec<ComputerUsePermissionState>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUsePermissionSetupResult {
    platform: &'static str,
    helper_app_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_id: Option<ComputerUsePermissionId>,
    opened_settings: bool,
    launched_helper: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    permissions: Option<Vec<ComputerUsePermissionState>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_step: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUsePermissionResetResult {
    platform: &'static str,
    helper_app_path: Option<String>,
    helper_unavailable_reason: Option<String>,
    permissions: Vec<ComputerUsePermissionState>,
    bundle_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HelperStatusFile {
    accessibility: Option<ComputerUsePermissionStatus>,
    screenshots: Option<ComputerUsePermissionStatus>,
}

// Why: sync commands run on the Tauri main thread; the helper-app launches and
// status-file polling below block for seconds, so bodies run in spawn_blocking.
#[tauri::command]
pub async fn computer_permissions_status(
    app: tauri::AppHandle,
) -> Result<ComputerUsePermissionStatusResult, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_computer_permissions_status(&app))
        .await
        .map_err(|error| format!("Permission status task failed: {error}"))?
}

fn resolve_computer_permissions_status(
    app: &tauri::AppHandle,
) -> Result<ComputerUsePermissionStatusResult, String> {
    // Why: parity with Electron, which reports both permissions as unsupported
    // on every non-macOS platform (src/main/computer/macos-computer-use-permission-status.ts).
    if !cfg!(target_os = "macos") {
        return Ok(unsupported_permission_status());
    }
    let Some(helper_app_path) = resolve_helper_app_path(&app) else {
        return Ok(unavailable_permission_status(
            "Pebble Computer Use.app was not found",
            None,
        ));
    };
    if resolve_helper_executable_path(&helper_app_path).is_none() {
        return Ok(unavailable_permission_status(
            format!(
                "{}/Contents/MacOS/{} was not found",
                helper_app_path.to_string_lossy(),
                HELPER_EXECUTABLE_NAME
            ),
            Some(&helper_app_path),
        ));
    }
    let raw = read_permission_status_from_helper(&helper_app_path)?;
    Ok(ComputerUsePermissionStatusResult {
        platform: current_platform(),
        helper_app_path: Some(path_string(&helper_app_path)),
        helper_unavailable_reason: None,
        permissions: permission_states(
            raw.accessibility
                .unwrap_or(ComputerUsePermissionStatus::NotGranted),
            raw.screenshots
                .unwrap_or(ComputerUsePermissionStatus::NotGranted),
        ),
    })
}

#[tauri::command]
pub async fn computer_permissions_open(
    app: tauri::AppHandle,
    input: Option<ComputerUsePermissionSetupInput>,
) -> Result<ComputerUsePermissionSetupResult, String> {
    tauri::async_runtime::spawn_blocking(move || open_computer_permissions_blocking(&app, input))
        .await
        .map_err(|error| format!("Permission setup task failed: {error}"))?
}

fn open_computer_permissions_blocking(
    app: &tauri::AppHandle,
    input: Option<ComputerUsePermissionSetupInput>,
) -> Result<ComputerUsePermissionSetupResult, String> {
    let permission_id = input.and_then(|value| value.id);
    // Why: parity with Electron's non-macOS response — unsupported permissions,
    // no settings opened (src/main/computer/macos-computer-use-permissions.ts).
    if !cfg!(target_os = "macos") {
        return Ok(ComputerUsePermissionSetupResult {
            platform: current_platform(),
            helper_app_path: None,
            permission_id,
            opened_settings: false,
            launched_helper: false,
            permissions: Some(unsupported_permissions()),
            next_step: None,
        });
    }

    let Some(helper_app_path) = resolve_helper_app_path(&app) else {
        return Err("Pebble Computer Use.app was not found".to_string());
    };
    let status = resolve_computer_permissions_status(&app)?;
    if let Some(reason) = status.helper_unavailable_reason {
        return Err(reason);
    }
    let next_step = next_permission_step(&status.permissions);
    if permission_id.is_none() && next_step.is_none() {
        return Ok(ComputerUsePermissionSetupResult {
            platform: current_platform(),
            helper_app_path: Some(path_string(&helper_app_path)),
            permission_id,
            opened_settings: false,
            launched_helper: false,
            permissions: Some(status.permissions),
            next_step,
        });
    }

    close_existing_permission_helpers();
    launch_permission_setup_helper(&helper_app_path, permission_id)?;
    Ok(ComputerUsePermissionSetupResult {
        platform: current_platform(),
        helper_app_path: Some(path_string(&helper_app_path)),
        permission_id,
        opened_settings: permission_id.is_some(),
        launched_helper: true,
        permissions: Some(status.permissions),
        next_step,
    })
}

#[tauri::command]
pub async fn computer_permissions_reset(
    app: tauri::AppHandle,
) -> Result<ComputerUsePermissionResetResult, String> {
    tauri::async_runtime::spawn_blocking(move || reset_computer_permissions_blocking(&app))
        .await
        .map_err(|error| format!("Permission reset task failed: {error}"))?
}

fn reset_computer_permissions_blocking(
    app: &tauri::AppHandle,
) -> Result<ComputerUsePermissionResetResult, String> {
    if !cfg!(target_os = "macos") {
        return Ok(ComputerUsePermissionResetResult {
            platform: current_platform(),
            helper_app_path: None,
            helper_unavailable_reason: None,
            permissions: unsupported_permissions(),
            bundle_id: None,
        });
    }
    let Some(helper_app_path) = resolve_helper_app_path(&app) else {
        return Err("Pebble Computer Use.app was not found".to_string());
    };
    let status = resolve_computer_permissions_status(&app)?;
    if let Some(reason) = status.helper_unavailable_reason {
        return Err(reason);
    }
    let bundle_id = read_helper_bundle_id(&helper_app_path);
    close_existing_permission_helpers();
    reset_tcc_permission("Accessibility", &bundle_id)?;
    reset_tcc_permission("ScreenCapture", &bundle_id)?;
    let next_status = resolve_computer_permissions_status(&app)?;
    Ok(ComputerUsePermissionResetResult {
        platform: current_platform(),
        helper_app_path: next_status.helper_app_path,
        helper_unavailable_reason: next_status.helper_unavailable_reason,
        permissions: next_status.permissions,
        bundle_id: Some(bundle_id),
    })
}

fn read_permission_status_from_helper(helper_app_path: &Path) -> Result<HelperStatusFile, String> {
    let temp_dir = env::temp_dir().join(format!(
        "pebble-computer-use-permissions-{}",
        Uuid::new_v4()
    ));
    fs::create_dir_all(&temp_dir)
        .map_err(|error| format!("Could not create permission status temp dir: {error}"))?;
    let status_path = temp_dir.join("status.json");
    let result = (|| {
        // Why: TCC must be checked via the helper app identity; direct binary
        // execution can inherit the parent app's already-granted context.
        launch_permission_status_helper(helper_app_path, &status_path)?;
        let deadline = Instant::now() + STATUS_FILE_TIMEOUT;
        while Instant::now() < deadline {
            if status_path.exists() {
                let contents = fs::read_to_string(&status_path)
                    .map_err(|error| format!("Could not read permission status: {error}"))?;
                return serde_json::from_str::<HelperStatusFile>(&contents)
                    .map_err(|error| format!("Could not parse permission status: {error}"));
            }
            thread::sleep(Duration::from_millis(100));
        }
        Err("Timed out checking permissions".to_string())
    })();
    let _ = fs::remove_dir_all(temp_dir);
    result
}

fn launch_permission_status_helper(
    helper_app_path: &Path,
    status_path: &Path,
) -> Result<(), String> {
    let mut child = Command::new("/usr/bin/open")
        .args(["-n"])
        .arg(helper_app_path)
        .args(["--args", "--permission-status-file"])
        .arg(status_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not check permissions: {error}"))?;
    let deadline = Instant::now() + STATUS_HELPER_LAUNCH_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(format!(
                    "Could not check permissions: exit {}",
                    status.code().unwrap_or(-1)
                ));
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Timed out launching permission helper".to_string());
            }
            Err(error) => return Err(format!("Could not check permissions: {error}")),
        }
    }
}

fn launch_permission_setup_helper(
    helper_app_path: &Path,
    permission_id: Option<ComputerUsePermissionId>,
) -> Result<(), String> {
    let mut command = Command::new("/usr/bin/open");
    command.arg("-n").arg(helper_app_path).arg("--args");
    match permission_id {
        Some(permission_id) => {
            command
                .arg("--permission")
                .arg(permission_id_arg(permission_id));
        }
        None => {
            command.arg("--permissions");
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open permission setup: {error}"))
}

fn close_existing_permission_helpers() {
    let patterns = [
        r"pebble-computer-use-macos[[:space:]]+--permission([[:space:]]|$)",
        r"pebble-computer-use-macos[[:space:]]+--permissions([[:space:]]|$)",
    ];
    for pattern in patterns {
        let _ = Command::new("/usr/bin/pkill")
            .args(["-f", pattern])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn reset_tcc_permission(service: &str, bundle_id: &str) -> Result<(), String> {
    let output = Command::new("/usr/bin/tccutil")
        .args(["reset", service, bundle_id])
        .output()
        .map_err(|error| format!("Could not reset {service}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let fallback = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !detail.is_empty() {
        detail
    } else if !fallback.is_empty() {
        fallback
    } else {
        format!("exit {}", output.status.code().unwrap_or(-1))
    };
    Err(format!("Could not reset {service}: {detail}"))
}

fn resolve_helper_app_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(path) = env::var_os("PEBBLE_COMPUTER_MACOS_HELPER_APP_PATH")
        .map(PathBuf::from)
        .filter(|path| path.exists())
    {
        return Some(path);
    }

    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(HELPER_APP_NAME));
    }
    if let Ok(current_dir) = env::current_dir() {
        add_dev_helper_candidates(&mut candidates, &current_dir);
        for ancestor in current_dir.ancestors().take(6) {
            add_dev_helper_candidates(&mut candidates, ancestor);
        }
    }
    candidates.into_iter().find(|path| path.exists())
}

fn add_dev_helper_candidates(candidates: &mut Vec<PathBuf>, base: &Path) {
    candidates.push(
        base.join("native")
            .join("computer-use-macos")
            .join(".build")
            .join("release")
            .join(HELPER_APP_NAME),
    );
    for triple in ["arm64-apple-macosx", "x86_64-apple-macosx"] {
        candidates.push(
            base.join("native")
                .join("computer-use-macos")
                .join(".build")
                .join(triple)
                .join("release")
                .join(HELPER_APP_NAME),
        );
    }
}

fn resolve_helper_executable_path(helper_app_path: &Path) -> Option<PathBuf> {
    let path = helper_app_path
        .join("Contents")
        .join("MacOS")
        .join(HELPER_EXECUTABLE_NAME);
    path.exists().then_some(path)
}

fn read_helper_bundle_id(helper_app_path: &Path) -> String {
    let info_plist = helper_app_path.join("Contents").join("Info.plist");
    let output = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :CFBundleIdentifier"])
        .arg(info_plist)
        .output();
    let Ok(output) = output else {
        return DEFAULT_HELPER_BUNDLE_ID.to_string();
    };
    if !output.status.success() {
        return DEFAULT_HELPER_BUNDLE_ID.to_string();
    }
    let bundle_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if bundle_id.is_empty() {
        DEFAULT_HELPER_BUNDLE_ID.to_string()
    } else {
        bundle_id
    }
}

fn unavailable_permission_status(
    reason: impl Into<String>,
    helper_app_path: Option<&Path>,
) -> ComputerUsePermissionStatusResult {
    ComputerUsePermissionStatusResult {
        platform: current_platform(),
        helper_app_path: helper_app_path.map(path_string),
        helper_unavailable_reason: Some(reason.into()),
        permissions: permission_states(
            ComputerUsePermissionStatus::NotGranted,
            ComputerUsePermissionStatus::NotGranted,
        ),
    }
}

fn unsupported_permission_status() -> ComputerUsePermissionStatusResult {
    ComputerUsePermissionStatusResult {
        platform: current_platform(),
        helper_app_path: None,
        helper_unavailable_reason: None,
        permissions: unsupported_permissions(),
    }
}

fn unsupported_permissions() -> Vec<ComputerUsePermissionState> {
    permission_states(
        ComputerUsePermissionStatus::Unsupported,
        ComputerUsePermissionStatus::Unsupported,
    )
}

fn permission_states(
    accessibility: ComputerUsePermissionStatus,
    screenshots: ComputerUsePermissionStatus,
) -> Vec<ComputerUsePermissionState> {
    vec![
        ComputerUsePermissionState {
            id: ComputerUsePermissionId::Accessibility,
            status: accessibility,
        },
        ComputerUsePermissionState {
            id: ComputerUsePermissionId::Screenshots,
            status: screenshots,
        },
    ]
}

fn next_permission_step(permissions: &[ComputerUsePermissionState]) -> Option<String> {
    permissions
        .iter()
        .find(|permission| !matches!(permission.status, ComputerUsePermissionStatus::Granted))
        .map(|permission| match permission.id {
            ComputerUsePermissionId::Accessibility => {
                "Grant Accessibility to Pebble Computer Use, then retry get-app-state.".to_string()
            }
            ComputerUsePermissionId::Screenshots => {
                "Grant Screen Recording to Pebble Computer Use, then retry get-app-state."
                    .to_string()
            }
        })
}

fn permission_id_arg(permission_id: ComputerUsePermissionId) -> &'static str {
    match permission_id {
        ComputerUsePermissionId::Accessibility => "accessibility",
        ComputerUsePermissionId::Screenshots => "screenshots",
    }
}

// Why: the native computer-use provider must gate queue execution on the same
// helper-app TCC status these commands report, not a parallel re-derivation.
#[cfg(target_os = "macos")]
pub(crate) fn computer_use_helper_executable(app: &tauri::AppHandle) -> Option<PathBuf> {
    let helper_app_path = resolve_helper_app_path(app)?;
    resolve_helper_executable_path(&helper_app_path)
}

/// Returns the ids of permissions not yet granted (empty means fully granted).
#[cfg(target_os = "macos")]
pub(crate) fn computer_use_missing_permissions(
    app: &tauri::AppHandle,
) -> Result<Vec<String>, String> {
    let status = resolve_computer_permissions_status(app)?;
    if let Some(reason) = status.helper_unavailable_reason {
        return Err(reason);
    }
    Ok(status
        .permissions
        .iter()
        .filter(|permission| !matches!(permission.status, ComputerUsePermissionStatus::Granted))
        .map(|permission| permission_id_arg(permission.id).to_string())
        .collect())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn current_platform() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "darwin"
    }
    #[cfg(target_os = "windows")]
    {
        "win32"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(all(
        not(target_os = "macos"),
        not(target_os = "windows"),
        not(target_os = "linux")
    ))]
    {
        env::consts::OS
    }
}
