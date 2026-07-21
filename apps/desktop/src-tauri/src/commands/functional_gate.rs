use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;
use std::{collections::BTreeMap, ffi::OsStr};

use serde::{Deserialize, Serialize};

const MAX_EVIDENCE_BYTES: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionalGateConfig {
    repo_path: String,
    browser_url: Option<String>,
    screenshot_paths: Option<BTreeMap<&'static str, String>>,
    launch_epoch_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionalGateEvidenceInput {
    body_json: String,
}

#[tauri::command]
pub fn functional_gate_config() -> Result<Option<FunctionalGateConfig>, String> {
    let Some(repo_path) = env::var_os("PEBBLE_FUNCTIONAL_GATE_REPO_PATH") else {
        return Ok(None);
    };
    let path = PathBuf::from(repo_path);
    if !path.is_absolute() || !path.is_dir() {
        return Err(
            "functional gate repository must be an existing absolute directory".to_string(),
        );
    }
    Ok(Some(FunctionalGateConfig {
        repo_path: path.to_string_lossy().into_owned(),
        browser_url: env::var("PEBBLE_FUNCTIONAL_GATE_BROWSER_URL").ok(),
        screenshot_paths: functional_gate_screenshot_paths()?,
        launch_epoch_ms: env::var("PEBBLE_FUNCTIONAL_GATE_LAUNCH_EPOCH_MS")
            .ok()
            .and_then(|value| value.parse().ok()),
    }))
}

#[tauri::command]
pub fn functional_gate_restore_and_focus(app: tauri::AppHandle) -> Result<bool, String> {
    let window = crate::primary_window::webview_window(&app)
        .ok_or_else(|| "functional gate window is unavailable".to_string())?;
    let (completed_tx, completed_rx) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = completed_tx.send(crate::primary_window::restore_and_focus(&window));
    })
    .map_err(|error| error.to_string())?;
    // Why: AppKit ignores restore/activation work dispatched off its main thread.
    completed_rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "functional gate window restore timed out".to_string())
}

#[tauri::command]
pub fn functional_gate_minimize(app: tauri::AppHandle) -> Result<bool, String> {
    let window = crate::primary_window::webview_window(&app)
        .ok_or_else(|| "functional gate window is unavailable".to_string())?;
    let (completed_tx, completed_rx) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = completed_tx.send(crate::window_chrome::minimize_window(&window));
    })
    .map_err(|error| error.to_string())?;
    completed_rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "functional gate window minimize timed out".to_string())
}

#[tauri::command]
pub async fn functional_gate_capture_ready(surface: String) -> Result<bool, String> {
    let Some(path) =
        functional_gate_screenshot_paths()?.and_then(|paths| paths.get(surface.as_str()).cloned())
    else {
        return Ok(false);
    };
    Ok(PathBuf::from(format!("{path}.ready")).is_file())
}

fn functional_gate_screenshot_paths() -> Result<Option<BTreeMap<&'static str, String>>, String> {
    let Some(raw) = env::var_os("PEBBLE_FUNCTIONAL_GATE_SCREENSHOT_DIR") else {
        return Ok(None);
    };
    let directory = PathBuf::from(raw);
    if !directory.is_absolute() || !directory.is_dir() {
        return Err(
            "functional gate screenshot directory must be an existing absolute directory"
                .to_string(),
        );
    }
    let mut paths = BTreeMap::new();
    for surface in ["terminal", "browser", "source-control", "checks"] {
        let path = directory.join(format!("tauri-{surface}.png"));
        if path.extension() != Some(OsStr::new("png")) {
            return Err("functional gate screenshot path must use .png".to_string());
        }
        paths.insert(surface, path.to_string_lossy().into_owned());
    }
    Ok(Some(paths))
}

#[tauri::command]
pub fn functional_gate_write_evidence(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    input: FunctionalGateEvidenceInput,
) -> Result<bool, String> {
    let path = functional_gate_evidence_path()?;
    if input.body_json.len() > MAX_EVIDENCE_BYTES {
        return Err("functional gate evidence exceeds the size limit".to_string());
    }
    let evidence = serde_json::from_str::<serde_json::Value>(&input.body_json)
        .map_err(|error| format!("functional gate evidence is not valid JSON: {error}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "functional gate evidence path has no parent".to_string())?;
    if !parent.is_dir() {
        return Err("functional gate evidence parent does not exist".to_string());
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, input.body_json.as_bytes()).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    schedule_renderer_capture(&app, webview.label(), &evidence)?;
    if evidence_is_terminal(&evidence) {
        // Why: the harness must observe durable evidence before Tauri exits
        // through RunEvent::Exit and marks the native session clean.
        let exit_app = app.clone();
        app.run_on_main_thread(move || exit_app.exit(0))
            .map_err(|error| error.to_string())?;
    }
    Ok(true)
}

#[cfg(debug_assertions)]
fn schedule_renderer_capture(
    app: &tauri::AppHandle,
    renderer_label: &str,
    evidence: &serde_json::Value,
) -> Result<(), String> {
    let Some(stage) = evidence.get("stage").and_then(serde_json::Value::as_str) else {
        return Ok(());
    };
    let Some(surface) = stage.strip_suffix("-capture-ready") else {
        return Ok(());
    };
    if surface == "browser" {
        return Ok(());
    }
    let Some(path) =
        functional_gate_screenshot_paths()?.and_then(|paths| paths.get(surface).cloned())
    else {
        return Ok(());
    };
    super::renderer_parity_capture::schedule_functional_renderer_capture(
        app.clone(),
        renderer_label,
        &path,
    )
}

#[cfg(not(debug_assertions))]
fn schedule_renderer_capture(
    _app: &tauri::AppHandle,
    _renderer_label: &str,
    _evidence: &serde_json::Value,
) -> Result<(), String> {
    // Why: renderer capture is test-only; release builds still persist gate evidence safely.
    Ok(())
}

fn evidence_is_terminal(evidence: &serde_json::Value) -> bool {
    matches!(
        evidence.get("status").and_then(serde_json::Value::as_str),
        Some("passed" | "failed")
    )
}

fn functional_gate_evidence_path() -> Result<PathBuf, String> {
    let raw = env::var_os("PEBBLE_FUNCTIONAL_GATE_EVIDENCE_PATH")
        .ok_or_else(|| "functional gate evidence is disabled".to_string())?;
    let path = PathBuf::from(raw);
    if !path.is_absolute() || path.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err("functional gate evidence path must be an absolute .json path".to_string());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_process_has_no_functional_gate_config() {
        if env::var_os("PEBBLE_FUNCTIONAL_GATE_REPO_PATH").is_none() {
            assert!(functional_gate_config().unwrap().is_none());
        }
    }

    #[test]
    fn only_final_gate_evidence_requests_shutdown() {
        assert!(!evidence_is_terminal(&serde_json::json!({
            "status": "running",
            "stage": "renderer-ready"
        })));
        assert!(evidence_is_terminal(
            &serde_json::json!({ "status": "passed" })
        ));
        assert!(evidence_is_terminal(
            &serde_json::json!({ "status": "failed" })
        ));
    }
}
