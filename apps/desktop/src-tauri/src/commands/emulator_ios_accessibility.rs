use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use pebble_rust_host::{get_runtime_resource, RuntimeResourceGetRequest};
use serde_json::{json, Value};

const MAX_STATE_BYTES: u64 = 64 * 1024;
const MAX_AX_BYTES: usize = 8 * 1024 * 1024;
const MAX_ELEMENTS: usize = 500;
const MAX_DEPTH: usize = 128;

pub fn helper_is_ready(port: u16) -> bool {
    let response = get_runtime_resource(RuntimeResourceGetRequest::new(
        format!("http://127.0.0.1:{port}"),
        "/health",
        None,
        Duration::from_millis(500),
    ));
    response.http_status.is_some_and(|status| status < 300)
}

pub fn persist_helper_state(udid: &str, port: u16, pid: u32) -> Result<(), String> {
    let path = state_path_for_udid(std::env::temp_dir().as_path(), udid)?;
    let directory = path
        .parent()
        .ok_or_else(|| "accessibility_error: invalid serve-sim state path".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("accessibility_error: cannot create serve-sim state: {error}"))?;
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let state = json!({
        "pid": pid,
        "port": port,
        "device": udid,
        "url": format!("http://127.0.0.1:{port}"),
        "streamUrl": format!("http://127.0.0.1:{port}/stream.mjpeg"),
        "wsUrl": format!("ws://127.0.0.1:{port}/ws")
    });
    fs::write(&temporary, serde_json::to_vec_pretty(&state).unwrap())
        .map_err(|error| format!("accessibility_error: cannot write serve-sim state: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("accessibility_error: cannot publish serve-sim state: {error}"))
}

pub fn accessibility_snapshot(udid: &str) -> Result<Value, String> {
    let state_path = state_path_for_udid(std::env::temp_dir().as_path(), udid)?;
    let state = read_bounded_json(&state_path, MAX_STATE_BYTES)?;
    let port = state
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65_535).contains(port))
        .ok_or_else(|| "serve-sim state has no valid helper port".to_string())?;
    let response = get_runtime_resource(RuntimeResourceGetRequest::new(
        format!("http://127.0.0.1:{port}"),
        "/ax",
        None,
        Duration::from_millis(3_500),
    ));
    if response.http_status == Some(503) {
        return Err("accessibility_unavailable: simulator helper cannot read accessibility".into());
    }
    if !response.http_status.is_some_and(|status| status < 300) {
        return Err(format!(
            "accessibility_error: serve-sim helper returned HTTP {}",
            response.http_status.unwrap_or_default()
        ));
    }
    let body = response.body.ok_or_else(|| {
        response
            .error
            .unwrap_or_else(|| "empty accessibility response".into())
    })?;
    if body.len() > MAX_AX_BYTES {
        return Err("accessibility_error: simulator accessibility response is too large".into());
    }
    let roots: Value = serde_json::from_str(&body)
        .map_err(|error| format!("accessibility_error: invalid simulator tree: {error}"))?;
    normalize_tree(&roots)
}

pub fn helper_port(udid: &str) -> Result<u16, String> {
    let state_path = state_path_for_udid(std::env::temp_dir().as_path(), udid)?;
    let state = read_bounded_json(&state_path, MAX_STATE_BYTES)?;
    let state_device = state.get("device").and_then(Value::as_str);
    if state_device != Some(udid) {
        return Err("invalid_target: serve-sim state belongs to another device".into());
    }
    state
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
        .ok_or_else(|| "accessibility_error: serve-sim state has no valid helper port".into())
}

fn state_path_for_udid(temp_root: &Path, udid: &str) -> Result<PathBuf, String> {
    if udid.is_empty()
        || udid.len() > 128
        || !udid
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("invalid_target: simulator UDID contains unsupported characters".into());
    }
    Ok(temp_root
        .join("serve-sim")
        .join(format!("server-{udid}.json")))
}

fn read_bounded_json(path: &Path, max_bytes: u64) -> Result<Value, String> {
    let metadata = fs::metadata(path).map_err(|_| {
        "external_dependency: start the serve-sim preview before requesting accessibility"
            .to_string()
    })?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > max_bytes {
        return Err("accessibility_error: serve-sim state file has an invalid size".into());
    }
    let body = fs::read_to_string(path)
        .map_err(|error| format!("accessibility_error: cannot read serve-sim state: {error}"))?;
    serde_json::from_str(&body)
        .map_err(|error| format!("accessibility_error: invalid serve-sim state: {error}"))
}

fn normalize_tree(roots: &Value) -> Result<Value, String> {
    let roots = roots
        .as_array()
        .ok_or_else(|| "accessibility_error: simulator tree root must be an array".to_string())?;
    let screen = roots
        .first()
        .and_then(|root| root.get("frame"))
        .cloned()
        .unwrap_or_else(|| json!({"x": 0, "y": 0, "width": 1, "height": 1}));
    let mut elements = Vec::new();
    for (index, root) in roots.iter().enumerate() {
        visit(root, index.to_string(), 0, &screen, &mut elements);
        if elements.len() >= MAX_ELEMENTS {
            break;
        }
    }
    Ok(json!({
        "screen": {
            "width": frame_number(&screen, "width"),
            "height": frame_number(&screen, "height")
        },
        "elements": elements
    }))
}

fn visit(node: &Value, path: String, depth: usize, screen: &Value, output: &mut Vec<Value>) {
    if depth > MAX_DEPTH || output.len() >= MAX_ELEMENTS {
        return;
    }
    let frame = node
        .get("frame")
        .cloned()
        .unwrap_or_else(|| json!({"x": 0, "y": 0, "width": 0, "height": 0}));
    if !same_frame(&frame, screen) {
        output.push(json!({
            "id": string_field(node, "AXUniqueId").unwrap_or_else(|| path.clone()),
            "path": path,
            "label": string_field(node, "AXLabel").unwrap_or_default(),
            "value": string_field(node, "AXValue").unwrap_or_default(),
            "role": string_field(node, "role_description").unwrap_or_default(),
            "type": string_field(node, "type").unwrap_or_default(),
            "enabled": node.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            "frame": frame
        }));
    }
    if let Some(children) = node.get("children").and_then(Value::as_array) {
        for (index, child) in children.iter().enumerate() {
            visit(child, format!("{path}.{index}"), depth + 1, screen, output);
            if output.len() >= MAX_ELEMENTS {
                break;
            }
        }
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn frame_number(frame: &Value, key: &str) -> f64 {
    frame.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn same_frame(left: &Value, right: &Value) -> bool {
    ["x", "y", "width", "height"]
        .iter()
        .all(|key| (frame_number(left, key) - frame_number(right, key)).abs() < 0.5)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;
    use tempfile::tempdir;

    use super::{normalize_tree, read_bounded_json, state_path_for_udid};

    #[test]
    fn normalizes_real_helper_shape_and_excludes_screen_root() {
        let tree = json!([{
            "frame": {"x": 0, "y": 0, "width": 390, "height": 844},
            "children": [{
                "AXUniqueId": "button-1", "AXLabel": "Continue", "AXValue": null,
                "enabled": true, "role_description": "button", "type": "Button",
                "frame": {"x": 20, "y": 700, "width": 350, "height": 48}, "children": []
            }]
        }]);
        let snapshot = normalize_tree(&tree).unwrap();
        assert_eq!(snapshot["screen"], json!({"width": 390.0, "height": 844.0}));
        assert_eq!(snapshot["elements"][0]["label"], "Continue");
        assert_eq!(snapshot["elements"][0]["path"], "0.0");
    }

    #[test]
    fn state_path_rejects_path_traversal() {
        assert!(state_path_for_udid(std::path::Path::new("/tmp"), "../escape").is_err());
    }

    #[test]
    fn bounded_state_reader_rejects_oversized_files() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state.json");
        fs::write(&path, vec![b'x'; 128]).unwrap();
        assert!(read_bounded_json(&path, 64)
            .unwrap_err()
            .contains("invalid size"));
    }
}
