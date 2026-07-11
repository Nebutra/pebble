use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeveloperPermissionId {
    Microphone,
    Camera,
    Screen,
    Accessibility,
    FullDiskAccess,
    Automation,
    LocalNetwork,
    Usb,
    Bluetooth,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeveloperPermissionState {
    id: DeveloperPermissionId,
    status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeveloperPermissionRequestResult {
    id: DeveloperPermissionId,
    status: &'static str,
    opened_system_settings: bool,
}

const IDS: [DeveloperPermissionId; 9] = [
    DeveloperPermissionId::Microphone,
    DeveloperPermissionId::Camera,
    DeveloperPermissionId::Screen,
    DeveloperPermissionId::Accessibility,
    DeveloperPermissionId::FullDiskAccess,
    DeveloperPermissionId::Automation,
    DeveloperPermissionId::LocalNetwork,
    DeveloperPermissionId::Usb,
    DeveloperPermissionId::Bluetooth,
];

#[tauri::command]
pub fn developer_permissions_status() -> Vec<DeveloperPermissionState> {
    IDS.into_iter()
        .map(|id| DeveloperPermissionState {
            status: permission_status(id),
            id,
        })
        .collect()
}

#[tauri::command]
pub fn developer_permissions_request(
    id: DeveloperPermissionId,
) -> DeveloperPermissionRequestResult {
    #[cfg(target_os = "macos")]
    let opened = open_privacy_pane(id);
    #[cfg(not(target_os = "macos"))]
    let opened = false;
    DeveloperPermissionRequestResult {
        id,
        status: permission_status(id),
        opened_system_settings: opened,
    }
}

#[tauri::command]
pub fn developer_permissions_open_settings(id: DeveloperPermissionId) -> bool {
    #[cfg(target_os = "macos")]
    return open_privacy_pane(id);
    #[cfg(not(target_os = "macos"))]
    false
}

fn permission_status(id: DeveloperPermissionId) -> &'static str {
    if !cfg!(target_os = "macos") {
        return "unsupported";
    }
    match id {
        DeveloperPermissionId::FullDiskAccess => {
            let bookmarks = home_dir().join("Library/Safari/Bookmarks.plist");
            if std::fs::File::open(bookmarks).is_ok() {
                "granted"
            } else {
                "unknown"
            }
        }
        DeveloperPermissionId::Usb | DeveloperPermissionId::Bluetooth => "ready",
        _ => "unknown",
    }
}

#[cfg(target_os = "macos")]
fn open_privacy_pane(id: DeveloperPermissionId) -> bool {
    let section = match id {
        DeveloperPermissionId::Microphone => "Privacy_Microphone",
        DeveloperPermissionId::Camera => "Privacy_Camera",
        DeveloperPermissionId::Screen => "Privacy_ScreenCapture",
        DeveloperPermissionId::Accessibility => "Privacy_Accessibility",
        DeveloperPermissionId::FullDiskAccess => "Privacy_AllFiles",
        DeveloperPermissionId::Automation => "Privacy_Automation",
        DeveloperPermissionId::Bluetooth => "Privacy_Bluetooth",
        DeveloperPermissionId::LocalNetwork | DeveloperPermissionId::Usb => "Privacy",
    };
    Command::new("open")
        .arg(format!(
            "x-apple.systempreferences:com.apple.preference.security?{section}"
        ))
        .spawn()
        .is_ok()
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}
