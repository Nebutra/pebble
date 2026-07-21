use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;

const BROWSER_WEBVIEW_LABEL_PREFIX: &str = "browser-";
const FIND_RESULT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct BrowserGuestFindState {
    selections: Mutex<HashMap<String, BrowserFindSelection>>,
}

#[derive(Debug, Clone)]
struct BrowserFindSelection {
    query: String,
    matches: u32,
    active_match_ordinal: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGuestFindInput {
    pub label: String,
    pub query: String,
    #[serde(default = "default_forward")]
    pub forward: bool,
    #[serde(default)]
    pub find_next: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGuestFindResult {
    pub active_match_ordinal: u32,
    pub matches: u32,
    pub final_update: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGuestStopFindInput {
    pub label: String,
}

#[derive(Debug, Deserialize)]
struct BrowserGuestFindEvaluation {
    found: bool,
    matches: u32,
    error: Option<String>,
}

#[tauri::command]
pub async fn browser_guest_find(
    app: AppHandle,
    input: BrowserGuestFindInput,
    state: State<'_, BrowserGuestFindState>,
) -> Result<BrowserGuestFindResult, String> {
    let label = validate_browser_webview_label(&input.label)?;
    let query = input.query.trim();
    if query.is_empty() {
        clear_browser_find_selection(&state, &label)?;
        return Ok(BrowserGuestFindResult {
            active_match_ordinal: 0,
            matches: 0,
            final_update: true,
        });
    }
    let evaluation = evaluate_browser_find(&app, &label, query, input.forward).await?;
    if let Some(error) = evaluation.error {
        return Err(error);
    }
    let matches = if evaluation.found {
        evaluation.matches.max(1)
    } else {
        0
    };
    let active_match_ordinal = update_browser_find_selection(
        &state,
        &label,
        query,
        matches,
        input.forward,
        input.find_next,
    )?;
    Ok(BrowserGuestFindResult {
        active_match_ordinal,
        matches,
        final_update: true,
    })
}

#[tauri::command]
pub async fn browser_guest_stop_find(
    app: AppHandle,
    input: BrowserGuestStopFindInput,
    state: State<'_, BrowserGuestFindState>,
) -> Result<(), String> {
    let label = validate_browser_webview_label(&input.label)?;
    clear_browser_find_selection(&state, &label)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    // Why: WebKit has no Electron-style stopFindInPage API. Clearing the
    // selection removes the active native find highlight without navigating.
    webview
        .eval("window.getSelection && window.getSelection().removeAllRanges();")
        .map_err(|error| error.to_string())
}

async fn evaluate_browser_find(
    app: &AppHandle,
    label: &str,
    query: &str,
    forward: bool,
) -> Result<BrowserGuestFindEvaluation, String> {
    let webview = app
        .get_webview(label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    let script = browser_find_script(query, forward)?;
    let (sender, receiver) = oneshot::channel::<String>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    webview
        .eval_with_callback(script, move |value| {
            let sender = sender.lock().ok().and_then(|mut sender| sender.take());
            if let Some(sender) = sender {
                let _ = sender.send(value);
            }
        })
        .map_err(|error| error.to_string())?;
    let response = tokio::time::timeout(FIND_RESULT_TIMEOUT, receiver)
        .await
        .map_err(|_| "browser find request timed out".to_string())?
        .map_err(|_| "browser find response was dropped".to_string())?;
    serde_json::from_str(&response)
        .map_err(|_| "browser find returned an invalid response".to_string())
}

fn browser_find_script(query: &str, forward: bool) -> Result<String, String> {
    let query = serde_json::to_string(query).map_err(|error| error.to_string())?;
    let forward = if forward { "true" } else { "false" };
    Ok(format!(
        r#"(() => {{
          try {{
            const query = {query};
            const found = window.find(query, false, {forward}, true, false, false, false);
            const needle = query.toLocaleLowerCase();
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let matches = 0;
            let node;
            while ((node = walker.nextNode())) {{
              const text = (node.nodeValue || '').toLocaleLowerCase();
              let index = text.indexOf(needle);
              while (index !== -1) {{
                matches += 1;
                index = text.indexOf(needle, index + needle.length);
              }}
            }}
            return {{ found, matches }};
          }} catch (error) {{
            return {{ found: false, matches: 0, error: String(error) }};
          }}
        }})()"#
    ))
}

fn update_browser_find_selection(
    state: &BrowserGuestFindState,
    label: &str,
    query: &str,
    matches: u32,
    forward: bool,
    find_next: bool,
) -> Result<u32, String> {
    let mut selections = state
        .selections
        .lock()
        .map_err(|_| "browser find state lock is poisoned".to_string())?;
    if matches == 0 {
        selections.remove(label);
        return Ok(0);
    }
    let selection = selections
        .entry(label.to_string())
        .or_insert(BrowserFindSelection {
            query: query.to_string(),
            matches,
            active_match_ordinal: 1,
        });
    if selection.query != query || selection.matches != matches {
        *selection = BrowserFindSelection {
            query: query.to_string(),
            matches,
            active_match_ordinal: 1,
        };
        return Ok(1);
    }
    if find_next {
        selection.active_match_ordinal = if forward {
            (selection.active_match_ordinal % matches) + 1
        } else if selection.active_match_ordinal <= 1 {
            matches
        } else {
            selection.active_match_ordinal - 1
        };
    }
    Ok(selection.active_match_ordinal)
}

fn clear_browser_find_selection(state: &BrowserGuestFindState, label: &str) -> Result<(), String> {
    let mut selections = state
        .selections
        .lock()
        .map_err(|_| "browser find state lock is poisoned".to_string())?;
    selections.remove(label);
    Ok(())
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

fn default_forward() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_child_browser_webview_labels() {
        assert_eq!(
            validate_browser_webview_label("browser-tab_1-2").as_deref(),
            Ok("browser-tab_1-2")
        );
        assert!(validate_browser_webview_label("main").is_err());
        assert!(validate_browser_webview_label("browser-<script>").is_err());
    }

    #[test]
    fn tracks_find_selection_across_navigation() {
        let state = BrowserGuestFindState::default();
        assert_eq!(
            update_browser_find_selection(&state, "browser-tab", "pebble", 3, true, false)
                .expect("first match"),
            1
        );
        assert_eq!(
            update_browser_find_selection(&state, "browser-tab", "pebble", 3, true, true)
                .expect("next match"),
            2
        );
        assert_eq!(
            update_browser_find_selection(&state, "browser-tab", "pebble", 3, false, true)
                .expect("previous match"),
            1
        );
    }
}
