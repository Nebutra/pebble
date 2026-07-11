use serde::{Deserialize, Serialize};
use std::process::Command;
use std::{fs, path::Path};
use tauri::AppHandle;
use tauri_plugin_notification::{NotificationExt, PermissionState};

const MAX_NOTIFICATION_SOUND_BYTES: u64 = 10 * 1024 * 1024;

/// Desktop notification request. Mirrors the fields the renderer's
/// NotificationDispatchRequest surfaces that a system toast can actually render;
/// routing/cooldown/focus policy stays in the renderer, which decides whether to
/// call this at all.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationShowCommand {
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationShowResult {
    pub delivered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPermissionResult {
    pub granted: bool,
    /// Raw OS permission state so the renderer can distinguish
    /// granted/denied/prompt without re-deriving it from `granted` alone.
    pub state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSoundDataResult {
    pub data_base64: String,
    pub mime_type: String,
}

fn permission_label(state: PermissionState) -> String {
    match state {
        PermissionState::Granted => "granted".to_string(),
        PermissionState::Denied => "denied".to_string(),
        _ => "prompt".to_string(),
    }
}

#[tauri::command]
pub fn show_native_notification(
    app: AppHandle,
    input: NotificationShowCommand,
) -> NotificationShowResult {
    // Why: showing a toast before the OS grants permission silently drops it, so
    // report a permission reason the renderer can act on instead of lying that it
    // was delivered.
    let permission = app
        .notification()
        .permission_state()
        .unwrap_or(PermissionState::Prompt);
    if !matches!(permission, PermissionState::Granted) {
        return NotificationShowResult {
            delivered: false,
            reason: Some("permission-not-granted".to_string()),
        };
    }
    let mut builder = app.notification().builder().title(input.title);
    if let Some(body) = input.body {
        builder = builder.body(body);
    }
    match builder.show() {
        Ok(()) => NotificationShowResult {
            delivered: true,
            reason: None,
        },
        Err(error) => NotificationShowResult {
            delivered: false,
            reason: Some(error.to_string()),
        },
    }
}

#[tauri::command]
pub fn native_notification_permission(app: AppHandle) -> NotificationPermissionResult {
    let state = app
        .notification()
        .permission_state()
        .unwrap_or(PermissionState::Prompt);
    NotificationPermissionResult {
        granted: matches!(state, PermissionState::Granted),
        state: permission_label(state),
    }
}

#[tauri::command]
pub fn request_native_notification_permission(app: AppHandle) -> NotificationPermissionResult {
    let state = app
        .notification()
        .request_permission()
        .unwrap_or(PermissionState::Prompt);
    NotificationPermissionResult {
        granted: matches!(state, PermissionState::Granted),
        state: permission_label(state),
    }
}

#[tauri::command]
pub fn open_notification_system_settings() -> Result<(), String> {
    for (program, arguments) in notification_settings_commands() {
        if Command::new(program).args(arguments).spawn().is_ok() {
            return Ok(());
        }
    }
    Err("Could not open the operating system notification settings.".to_string())
}

#[tauri::command]
pub fn load_notification_sound(path: String) -> Result<NotificationSoundDataResult, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let path = Path::new(&path);
    if !path.is_absolute() {
        return Err("Notification sound path must be absolute.".to_string());
    }
    let mime_type = notification_sound_mime(path)
        .ok_or_else(|| "Notification sound type is not supported.".to_string())?;
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_NOTIFICATION_SOUND_BYTES {
        return Err("Notification sound exceeds the desktop safety limit.".to_string());
    }
    let data = fs::read(path).map_err(|error| error.to_string())?;
    Ok(NotificationSoundDataResult {
        data_base64: STANDARD.encode(data),
        mime_type: mime_type.to_string(),
    })
}

fn notification_sound_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "ogg" => Some("audio/ogg"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "m4a" | "aac" => Some("audio/mp4"),
        "flac" => Some("audio/flac"),
        _ => None,
    }
}

fn notification_settings_commands() -> Vec<(&'static str, &'static [&'static str])> {
    #[cfg(target_os = "macos")]
    return vec![(
        "open",
        &["x-apple.systempreferences:com.apple.preference.notifications"],
    )];

    #[cfg(target_os = "windows")]
    return vec![("cmd", &["/C", "start", "", "ms-settings:notifications"])];

    #[cfg(target_os = "linux")]
    return vec![
        ("gnome-control-center", &["notifications"]),
        ("systemsettings6", &["kcm_notifications"]),
        ("systemsettings5", &["kcm_notifications"]),
    ];

    #[allow(unreachable_code)]
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_settings_plan_is_available_on_desktop_targets() {
        let commands = notification_settings_commands();
        assert!(!commands.is_empty());
        assert!(commands.iter().all(|(program, _)| !program.is_empty()));
    }

    #[test]
    fn notification_sound_mime_accepts_only_supported_audio_extensions() {
        assert_eq!(
            notification_sound_mime(Path::new("/tmp/sound.MP3")),
            Some("audio/mpeg")
        );
        assert_eq!(notification_sound_mime(Path::new("/tmp/sound.txt")), None);
    }
}
