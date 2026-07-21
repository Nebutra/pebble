use std::{
    sync::atomic::{AtomicU64, Ordering},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Webview};
use tokio::sync::oneshot;

const BROWSER_WEBVIEW_LABEL_PREFIX: &str = "browser-";
const MAX_SCRIPT_BYTES: usize = 512 * 1024;
const MAX_TIMEOUT_MS: u64 = 120_000;
const EVALUATION_POLL_MS: u64 = 10;
const EVALUATION_RESPONSE_DROPPED: &str = "browser guest evaluation response was dropped";
static EVALUATION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsyncEvaluationSlot {
    done: bool,
    ok: Option<bool>,
    value: Option<Value>,
    error: Option<String>,
}

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
    evaluate_async_script(&webview, &input.script, timeout_ms).await
}

async fn evaluate_async_script(
    webview: &Webview,
    script: &str,
    timeout_ms: u64,
) -> Result<String, String> {
    let slot = format!(
        "__pebbleAsyncEvaluation{}",
        EVALUATION_ID.fetch_add(1, Ordering::Relaxed)
    );
    let slot_json = serde_json::to_string(&slot).map_err(|error| error.to_string())?;
    let script_json = serde_json::to_string(script).map_err(|error| error.to_string())?;
    let launch = format!(
        "(() => {{ const key = {slot_json}; globalThis[key] = {{ done: false }}; \
         Promise.resolve().then(() => (0, eval)({script_json})).then(\
         value => {{ globalThis[key] = {{ done: true, ok: true, value: value === undefined ? null : value }}; }}, \
         error => {{ globalThis[key] = {{ done: true, ok: false, error: error instanceof Error ? error.message : String(error) }}; }}); }})()"
    );
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    #[cfg(target_os = "macos")]
    {
        // Why: WKWebView may defer fire-and-forget evaluation indefinitely;
        // await its native callback before polling the completion slot.
        evaluate_once(
            webview,
            launch,
            deadline.saturating_duration_since(Instant::now()),
        )
        .await?;
    }
    #[cfg(not(target_os = "macos"))]
    webview.eval(launch).map_err(|error| error.to_string())?;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            cleanup_evaluation_slot(webview, &slot_json);
            return Err("browser guest evaluation timed out".to_string());
        }
        let response = match evaluate_once(
            webview,
            format!("globalThis[{slot_json}] ?? null"),
            remaining,
        )
        .await
        {
            Ok(response) => response,
            // Why: WebKit drops pending callback objects while committing a
            // navigation even though the child webview remains usable.
            Err(error) if is_transient_callback_drop(&error) => {
                tokio::time::sleep(Duration::from_millis(EVALUATION_POLL_MS)).await;
                continue;
            }
            Err(error) => return Err(error),
        };
        if let Ok(slot) = decode_evaluation_slot(&response) {
            if slot.done {
                cleanup_evaluation_slot(webview, &slot_json);
                if slot.ok == Some(false) {
                    return Err(slot
                        .error
                        .unwrap_or_else(|| "browser guest evaluation failed".to_string()));
                }
                return serde_json::to_string(&slot.value.unwrap_or(Value::Null))
                    .map_err(|error| error.to_string());
            }
        }
        tokio::time::sleep(Duration::from_millis(EVALUATION_POLL_MS)).await;
    }
}

fn decode_evaluation_slot(response: &str) -> Result<AsyncEvaluationSlot, serde_json::Error> {
    let value = serde_json::from_str::<Value>(response)?;
    // Why: WKWebView returns callback objects as a JSON string while other
    // Tauri backends return the object directly; normalize both contracts.
    let value = match value {
        Value::String(inner) => serde_json::from_str::<Value>(&inner)?,
        value => value,
    };
    serde_json::from_value(value)
}

async fn evaluate_once(
    webview: &Webview,
    script: String,
    timeout: Duration,
) -> Result<String, String> {
    let (sender, receiver) = oneshot::channel::<String>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    #[cfg(target_os = "macos")]
    evaluate_once_macos(webview, script, sender)?;
    #[cfg(not(target_os = "macos"))]
    webview
        .eval_with_callback(script, move |value| {
            let sender = sender.lock().ok().and_then(|mut sender| sender.take());
            if let Some(sender) = sender {
                let _ = sender.send(value);
            }
        })
        .map_err(|error| error.to_string())?;

    tokio::time::timeout(timeout, receiver)
        .await
        .map_err(|_| "browser guest evaluation timed out".to_string())?
        .map_err(|_| EVALUATION_RESPONSE_DROPPED.to_string())
}

#[cfg(target_os = "macos")]
fn evaluate_once_macos(
    webview: &Webview,
    script: String,
    sender: Arc<Mutex<Option<oneshot::Sender<String>>>>,
) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::{runtime::AnyObject, AnyThread, MainThreadMarker};
    use objc2_foundation::{
        NSJSONSerialization, NSJSONWritingOptions, NSString, NSUTF8StringEncoding,
    };
    use objc2_web_kit::WKWebView;

    webview
        .with_webview(move |platform_webview| unsafe {
            let pointer = platform_webview.inner();
            if pointer.is_null() {
                return;
            }
            let Some(_main_thread) = MainThreadMarker::new() else {
                return;
            };
            let native = &*(pointer as *const WKWebView);
            let body = NSString::from_str(&script);
            let callback = RcBlock::new(move |value: *mut AnyObject, _error| {
                let response = if value.is_null() {
                    "null".to_string()
                } else {
                    NSJSONSerialization::dataWithJSONObject_options_error(
                        &*value,
                        NSJSONWritingOptions::FragmentsAllowed,
                    )
                    .ok()
                    .and_then(|data| {
                        NSString::initWithData_encoding(
                            NSString::alloc(),
                            &data,
                            NSUTF8StringEncoding,
                        )
                    })
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "null".to_string())
                };
                if let Some(sender) = sender.lock().ok().and_then(|mut sender| sender.take()) {
                    let _ = sender.send(response);
                }
            });
            native.evaluateJavaScript_completionHandler(&body, Some(&callback));
        })
        .map_err(|error| error.to_string())
}

fn is_transient_callback_drop(error: &str) -> bool {
    error == EVALUATION_RESPONSE_DROPPED
}

fn cleanup_evaluation_slot(webview: &Webview, slot_json: &str) {
    let _ = webview.eval(format!("delete globalThis[{slot_json}]"));
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

    #[test]
    fn decodes_direct_and_webkit_double_encoded_completion_slots() {
        let direct = r#"{"done":true,"ok":true,"value":{"result":"ready"}}"#;
        let encoded = serde_json::to_string(direct).unwrap();
        for response in [direct.to_string(), encoded] {
            let slot = decode_evaluation_slot(&response).unwrap();
            assert!(slot.done);
            assert_eq!(slot.ok, Some(true));
            assert_eq!(slot.value.unwrap()["result"], "ready");
        }
    }

    #[test]
    fn retries_only_webkit_callback_drops() {
        assert!(is_transient_callback_drop(EVALUATION_RESPONSE_DROPPED));
        assert!(!is_transient_callback_drop(
            "browser guest evaluation timed out"
        ));
        assert!(!is_transient_callback_drop(
            "browser webview is not available"
        ));
    }
}
