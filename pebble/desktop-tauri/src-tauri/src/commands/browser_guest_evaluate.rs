use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

const BROWSER_WEBVIEW_LABEL_PREFIX: &str = "browser-";
const MAX_SCRIPT_BYTES: usize = 512 * 1024;
const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGuestEvaluateInput {
    label: String,
    script: String,
    timeout_ms: Option<u64>,
}

#[tauri::command]
pub async fn browser_guest_evaluate(
    app: AppHandle,
    input: BrowserGuestEvaluateInput,
) -> Result<String, String> {
    let label = validate_browser_webview_label(&input.label)?;
    validate_script(&input.script)?;
    let timeout_ms = input.timeout_ms.unwrap_or(5_000).clamp(1, MAX_TIMEOUT_MS);
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    let (sender, receiver) = oneshot::channel::<String>();
    let sender = Arc::new(Mutex::new(Some(sender)));

    // Why: Tauri's JavaScript API exposes fire-and-forget eval only. This
    // bounded native callback preserves Electron executeJavaScript semantics.
    webview
        .eval_with_callback(input.script, move |value| {
            let sender = sender.lock().ok().and_then(|mut sender| sender.take());
            if let Some(sender) = sender {
                let _ = sender.send(value);
            }
        })
        .map_err(|error| error.to_string())?;

    tokio::time::timeout(Duration::from_millis(timeout_ms), receiver)
        .await
        .map_err(|_| "browser guest evaluation timed out".to_string())?
        .map_err(|_| "browser guest evaluation response was dropped".to_string())
}

fn validate_browser_webview_label(value: &str) -> Result<String, String> {
    let label = value.trim();
    if !label.starts_with(BROWSER_WEBVIEW_LABEL_PREFIX) || label.len() > 256 {
        return Err("invalid browser webview label".to_string());
    }
    if !label.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '/' | ':')
    }) {
        return Err("invalid browser webview label".to_string());
    }
    Ok(label.to_string())
}

fn validate_script(script: &str) -> Result<(), String> {
    if script.trim().is_empty() || script.len() > MAX_SCRIPT_BYTES {
        return Err("invalid browser guest evaluation script".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricts_evaluation_to_browser_child_webviews() {
        assert!(validate_browser_webview_label("browser-page-1").is_ok());
        assert!(validate_browser_webview_label("main").is_err());
        assert!(validate_browser_webview_label("browser-<script>").is_err());
    }

    #[test]
    fn bounds_guest_evaluation_scripts() {
        assert!(validate_script("({ ok: true })").is_ok());
        assert!(validate_script("").is_err());
        assert!(validate_script(&"x".repeat(MAX_SCRIPT_BYTES + 1)).is_err());
    }
}
