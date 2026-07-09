use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_notification::{NotificationExt, PermissionState};

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
