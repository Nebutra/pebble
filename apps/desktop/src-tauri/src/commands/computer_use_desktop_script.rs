#![cfg(any(target_os = "linux", target_os = "windows"))]

use std::path::PathBuf;

use serde_json::{json, Map, Value};

use super::computer_use_action_translation::{ComputerActionExecutor, ExecutorFailure};
use super::computer_use_desktop_action::normalize_action_metadata;
use super::computer_use_desktop_bridge::invoke_desktop_script;
use super::computer_use_desktop_projection::{
    normalize_apps, normalize_windows, render_snapshot, without_screenshot,
};
use super::computer_use_desktop_snapshot_cache::DesktopSnapshotCache;

pub const DESKTOP_PROVIDER_ID: &str = "computer:tauri-desktop-native";
pub const DESKTOP_PROVIDER_NAME: &str = "desktop-native-script";

pub struct DesktopScriptExecutor {
    script_path: PathBuf,
    capabilities: Option<Value>,
    snapshots: DesktopSnapshotCache,
}

impl DesktopScriptExecutor {
    pub fn new(script_path: PathBuf) -> Self {
        Self {
            script_path,
            capabilities: None,
            snapshots: DesktopSnapshotCache::default(),
        }
    }

    fn invoke(&self, operation: &Value) -> Result<Value, ExecutorFailure> {
        invoke_desktop_script(&self.script_path, operation)
    }

    fn call_action(&mut self, method: &str, params: &Value) -> Result<Value, ExecutorFailure> {
        let app = required_string(params, "app")?;
        let mut operation = params.as_object().cloned().ok_or_else(|| {
            ExecutorFailure::new(
                "invalid_argument",
                "computer action payload must be an object",
            )
        })?;
        operation.insert("tool".into(), Value::String(action_tool(method)?.into()));
        let current = self.current_snapshot(app, params)?.cloned();
        add_cached_element(&mut operation, "elementIndex", "element", current.as_ref())?;
        add_cached_element(
            &mut operation,
            "fromElementIndex",
            "fromElement",
            current.as_ref(),
        )?;
        add_cached_element(
            &mut operation,
            "toElementIndex",
            "toElement",
            current.as_ref(),
        )?;
        rename_fields(&mut operation);
        inherit_window_target(&mut operation, current.as_ref());
        let mut response = self.invoke(&Value::Object(operation))?;
        normalize_action_metadata(&mut response, method, params);
        self.normalize_snapshot_response(app, response, params)
    }

    fn normalize_snapshot_response(
        &mut self,
        app: &str,
        response: Value,
        params: &Value,
    ) -> Result<Value, ExecutorFailure> {
        let snapshot = response.get("snapshot").cloned().ok_or_else(|| {
            ExecutorFailure::new(
                "accessibility_error",
                "desktop provider returned no snapshot",
            )
        })?;
        self.remember_snapshot(app, &snapshot);
        let mut result = render_snapshot(
            &snapshot,
            params.get("noScreenshot") == Some(&Value::Bool(true)),
        )?;
        if let Some(action) = response.get("action") {
            result
                .as_object_mut()
                .expect("rendered snapshot is an object")
                .insert("action".into(), action.clone());
        }
        Ok(result)
    }

    fn remember_snapshot(&mut self, app: &str, snapshot: &Value) {
        let cached = without_screenshot(snapshot);
        let mut keys = vec![app.to_string()];
        if let Some(window_id) = snapshot.get("windowId").and_then(Value::as_u64) {
            keys.push(format!("{app}#window-id:{window_id}"));
        }
        if let Some(window_index) = snapshot.get("windowIndex").and_then(Value::as_u64) {
            keys.push(format!("{app}#window-index:{window_index}"));
        }
        self.snapshots.remember(keys, cached);
    }

    fn current_snapshot(
        &mut self,
        app: &str,
        params: &Value,
    ) -> Result<Option<&Value>, ExecutorFailure> {
        let explicit_key = params
            .get("windowId")
            .and_then(Value::as_u64)
            .map(|id| format!("{app}#window-id:{id}"))
            .or_else(|| {
                params
                    .get("windowIndex")
                    .and_then(Value::as_u64)
                    .map(|index| format!("{app}#window-index:{index}"))
            });
        if let Some(key) = explicit_key {
            return self.snapshots.get(&key).map(Some).ok_or_else(|| {
                ExecutorFailure::new(
                    "window_stale",
                    "target window has no cached snapshot; run get-app-state for that window",
                )
            });
        }
        Ok(self.snapshots.get(app))
    }
}

impl ComputerActionExecutor for DesktopScriptExecutor {
    fn capabilities(&mut self) -> Result<Value, ExecutorFailure> {
        if let Some(capabilities) = &self.capabilities {
            return Ok(capabilities.clone());
        }
        let response = self.invoke(&json!({"tool": "handshake"}))?;
        let capabilities = response.get("capabilities").cloned().ok_or_else(|| {
            ExecutorFailure::new(
                "accessibility_error",
                "desktop provider returned no capabilities",
            )
        })?;
        self.capabilities = Some(capabilities.clone());
        Ok(capabilities)
    }

    fn call(&mut self, method: &'static str, params: &Value) -> Result<Value, ExecutorFailure> {
        match method {
            "listApps" => normalize_apps(self.invoke(&json!({"tool": "list_apps"}))?),
            "listWindows" => normalize_windows(self.invoke(&json!({
                "tool": "list_windows",
                "app": required_string(params, "app")?,
            }))?),
            "getAppState" => {
                let app = required_string(params, "app")?;
                let mut operation = params.as_object().cloned().unwrap_or_default();
                operation.insert("tool".into(), Value::String("get_app_state".into()));
                let response = self.invoke(&Value::Object(operation))?;
                self.normalize_snapshot_response(app, response, params)
            }
            _ => self.call_action(method, params),
        }
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, ExecutorFailure> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ExecutorFailure::new("invalid_argument", format!("missing {key}")))
}

fn action_tool(method: &str) -> Result<&'static str, ExecutorFailure> {
    match method {
        "click" => Ok("click"),
        "performSecondaryAction" => Ok("perform_secondary_action"),
        "scroll" => Ok("scroll"),
        "drag" => Ok("drag"),
        "typeText" => Ok("type_text"),
        "pressKey" => Ok("press_key"),
        "hotkey" => Ok("hotkey"),
        "pasteText" => Ok("paste_text"),
        "setValue" => Ok("set_value"),
        _ => Err(ExecutorFailure::new(
            "unsupported_capability",
            format!("unsupported action {method}"),
        )),
    }
}

fn add_cached_element(
    operation: &mut Map<String, Value>,
    index_key: &str,
    output_key: &str,
    snapshot: Option<&Value>,
) -> Result<(), ExecutorFailure> {
    let Some(index) = operation.remove(index_key).and_then(|value| value.as_u64()) else {
        return Ok(());
    };
    let element = snapshot
        .and_then(|value| value.get("elements"))
        .and_then(Value::as_array)
        .and_then(|elements| {
            elements
                .iter()
                .find(|element| element.get("index").and_then(Value::as_u64) == Some(index))
        })
        .cloned()
        .ok_or_else(|| {
            ExecutorFailure::new(
                "element_not_found",
                format!("element {index} is not in the current cached snapshot; run get-app-state again"),
            )
        })?;
    operation.insert(output_key.into(), element);
    Ok(())
}

fn rename_fields(operation: &mut Map<String, Value>) {
    for (from, to) in [
        ("fromX", "from_x"),
        ("fromY", "from_y"),
        ("toX", "to_x"),
        ("toY", "to_y"),
        ("clickCount", "click_count"),
        ("mouseButton", "mouse_button"),
    ] {
        if let Some(value) = operation.remove(from) {
            operation.insert(to.into(), value);
        }
    }
}

fn inherit_window_target(operation: &mut Map<String, Value>, snapshot: Option<&Value>) {
    if operation.contains_key("windowId") || operation.contains_key("windowIndex") {
        return;
    }
    for key in ["windowId", "windowIndex"] {
        if let Some(value) = snapshot
            .and_then(|snapshot| snapshot.get(key))
            .filter(|value| !value.is_null())
        {
            operation.insert(key.into(), value.clone());
            return;
        }
    }
}
