use serde_json::{json, Value};

use super::computer_use_action_translation::ExecutorFailure;

pub fn without_screenshot(snapshot: &Value) -> Value {
    let mut value = snapshot.clone();
    if let Some(object) = value.as_object_mut() {
        object.insert("screenshotPngBase64".into(), Value::Null);
    }
    value
}

pub fn normalize_apps(response: Value) -> Result<Value, ExecutorFailure> {
    let apps = response
        .get("apps")
        .and_then(Value::as_array)
        .ok_or_else(|| failure("desktop provider returned no apps"))?;
    Ok(json!({"apps": apps.iter().map(|app| json!({
        "name": app["name"],
        "bundleId": bundle_id(app),
        "pid": app["pid"],
        "isRunning": true,
        "lastUsedAt": null,
        "useCount": null
    })).collect::<Vec<_>>() }))
}

pub fn normalize_windows(response: Value) -> Result<Value, ExecutorFailure> {
    let app = response
        .get("app")
        .cloned()
        .ok_or_else(|| failure("desktop provider returned no app"))?;
    let windows = response
        .get("windows")
        .and_then(Value::as_array)
        .map(|windows| {
            windows
                .iter()
                .map(|window| {
                    let mut value = window.clone();
                    if let Some(object) = value.as_object_mut() {
                        object.insert(
                            "app".into(),
                            normalize_app(window.get("app").unwrap_or(&app)),
                        );
                    }
                    value
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(json!({"app": normalize_app(&app), "windows": windows}))
}

pub fn render_snapshot(snapshot: &Value, no_screenshot: bool) -> Result<Value, ExecutorFailure> {
    let app = snapshot
        .get("app")
        .ok_or_else(|| failure("desktop provider snapshot has no app"))?;
    let bounds = snapshot
        .get("windowBounds")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let screenshot = snapshot
        .get("screenshotPngBase64")
        .and_then(Value::as_str)
        .map(|data| {
            json!({
                "data": data,
                "format": "png",
                "width": positive_integer(snapshot, "screenshotWidth"),
                "height": positive_integer(snapshot, "screenshotHeight"),
                "scale": snapshot.get("screenshotScale").and_then(Value::as_f64).unwrap_or(1.0)
            })
        });
    let tree_text = render_tree_text(snapshot, app);
    let screenshot_status = if screenshot.is_some() {
        json!({"state": "captured", "metadata": {
            "engine": "unknown",
            "windowId": snapshot.get("windowId").cloned().unwrap_or(Value::Null)
        }})
    } else if no_screenshot {
        json!({"state": "skipped", "reason": "no_screenshot_flag"})
    } else {
        json!({"state": "failed", "code": "screenshot_failed", "message": snapshot
            .pointer("/screenshotError/message")
            .and_then(Value::as_str)
            .unwrap_or("desktop provider returned no image")})
    };
    Ok(json!({
        "snapshot": {
            "id": snapshot.get("snapshotId").cloned().unwrap_or_else(|| fallback_id(app)),
            "app": normalize_app(app),
            "window": {
                "title": snapshot.get("windowTitle").cloned().unwrap_or_else(|| app.get("name").cloned().unwrap_or(Value::Null)),
                "id": snapshot.get("windowId").cloned().unwrap_or(Value::Null),
                "index": snapshot.get("windowIndex").cloned().unwrap_or(Value::Null),
                "x": bounds.get("x").cloned().unwrap_or(Value::Null),
                "y": bounds.get("y").cloned().unwrap_or(Value::Null),
                "width": bounds.get("width").cloned().unwrap_or(json!(0)),
                "height": bounds.get("height").cloned().unwrap_or(json!(0)),
                "isMinimized": null,
                "isOffscreen": null,
                "screenIndex": null
            },
            "coordinateSpace": "window",
            "treeText": tree_text,
            "elementCount": snapshot.get("elements").and_then(Value::as_array).map_or(0, Vec::len),
            "focusedElementId": normalized_focus(snapshot),
            "truncation": snapshot.get("truncation").cloned().unwrap_or_else(|| json!({"truncated": false}))
        },
        "screenshot": screenshot,
        "screenshotStatus": screenshot_status
    }))
}

fn normalize_app(app: &Value) -> Value {
    json!({"name": app["name"], "bundleId": bundle_id(app), "pid": app["pid"]})
}

fn bundle_id(app: &Value) -> Value {
    app.get("bundleId")
        .or_else(|| app.get("bundleIdentifier"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn positive_integer(snapshot: &Value, key: &str) -> u64 {
    snapshot
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .unwrap_or(1)
}

fn fallback_id(app: &Value) -> Value {
    Value::String(format!(
        "{}:{}",
        app.get("name").and_then(Value::as_str).unwrap_or("app"),
        app.get("pid").and_then(Value::as_i64).unwrap_or(0)
    ))
}

fn normalized_focus(snapshot: &Value) -> Value {
    let focus = snapshot.get("focusedElementId").and_then(Value::as_u64);
    let exists = focus.is_some_and(|focus| {
        snapshot
            .get("elements")
            .and_then(Value::as_array)
            .is_some_and(|elements| elements.iter().any(|element| element["index"] == focus))
    });
    if exists {
        json!(focus)
    } else {
        Value::Null
    }
}

fn render_tree_text(snapshot: &Value, app: &Value) -> String {
    let name = app.get("name").and_then(Value::as_str).unwrap_or("");
    let reference = bundle_id(app);
    let mut lines = vec![
        format!(
            "App={} (pid {})",
            reference.as_str().unwrap_or(name),
            app["pid"]
        ),
        format!(
            "Window: \"{}\", App: {}.",
            snapshot
                .get("windowTitle")
                .and_then(Value::as_str)
                .unwrap_or(name),
            name
        ),
        String::new(),
    ];
    lines.extend(
        snapshot
            .get("treeLines")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|line| line.replace(['\n', '\r'], " ")),
    );
    lines.join("\n")
}

fn failure(message: &str) -> ExecutorFailure {
    ExecutorFailure::new("accessibility_error", message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_snapshot() -> Value {
        json!({
            "snapshotId": "snapshot-1",
            "app": {"name": "Editor", "bundleIdentifier": "dev.pebble.editor", "pid": 42},
            "windowTitle": "Document",
            "windowId": 9,
            "windowIndex": 1,
            "windowBounds": {"x": 10, "y": 20, "width": 800, "height": 600},
            "treeLines": ["[0] button Save"],
            "elements": [{"index": 0, "name": "Save"}],
            "focusedElementId": 0,
            "screenshotPngBase64": "cG5n",
            "screenshotWidth": 400,
            "screenshotHeight": 300,
            "screenshotScale": 0.5
        })
    }

    #[test]
    fn renders_bridge_snapshot_into_the_canonical_contract() {
        let result = render_snapshot(&raw_snapshot(), false).unwrap();
        assert_eq!(result["snapshot"]["app"]["bundleId"], "dev.pebble.editor");
        assert_eq!(result["snapshot"]["window"]["id"], 9);
        assert_eq!(result["snapshot"]["elementCount"], 1);
        assert_eq!(result["screenshot"]["width"], 400);
        assert_eq!(result["screenshotStatus"]["state"], "captured");
    }

    #[test]
    fn cached_snapshot_drops_large_image_data() {
        let cached = without_screenshot(&raw_snapshot());
        assert!(cached["screenshotPngBase64"].is_null());
        assert_eq!(cached["elements"][0]["name"], "Save");
    }

    #[test]
    fn no_screenshot_is_an_explicit_skipped_state() {
        let mut snapshot = raw_snapshot();
        snapshot["screenshotPngBase64"] = Value::Null;
        let result = render_snapshot(&snapshot, true).unwrap();
        assert!(result["screenshot"].is_null());
        assert_eq!(result["screenshotStatus"]["reason"], "no_screenshot_flag");
    }

    #[test]
    fn normalizes_app_and_window_lists() {
        let apps = normalize_apps(json!({"apps": [{
            "name": "Editor", "bundleIdentifier": "dev.pebble.editor", "pid": 42
        }]}))
        .unwrap();
        assert_eq!(apps["apps"][0]["bundleId"], "dev.pebble.editor");
        assert_eq!(apps["apps"][0]["isRunning"], true);

        let windows = normalize_windows(json!({
            "app": {"name": "Editor", "bundleIdentifier": "dev.pebble.editor", "pid": 42},
            "windows": [{"index": 0, "title": "Document", "width": 800, "height": 600}]
        }))
        .unwrap();
        assert_eq!(windows["windows"][0]["app"]["pid"], 42);
        assert_eq!(windows["windows"][0]["title"], "Document");
    }
}
