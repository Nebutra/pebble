use serde_json::{json, Value};

pub fn normalize_action_metadata(response: &mut Value, method: &str, params: &Value) {
    let snapshot = response.get("snapshot").cloned().unwrap_or(Value::Null);
    let Some(action) = response.get_mut("action").and_then(Value::as_object_mut) else {
        return;
    };
    if !action.contains_key("targetWindowId") {
        action.insert(
            "targetWindowId".into(),
            params
                .get("windowId")
                .or_else(|| snapshot.get("windowId"))
                .cloned()
                .unwrap_or(Value::Null),
        );
    }
    if !action.contains_key("targetWindowIndex") {
        action.insert(
            "targetWindowIndex".into(),
            params
                .get("windowIndex")
                .or_else(|| snapshot.get("windowIndex"))
                .cloned()
                .unwrap_or(Value::Null),
        );
    }
    if !action.contains_key("verification") {
        if matches!(method, "typeText" | "pressKey" | "hotkey") {
            action.insert(
                "verification".into(),
                json!({"state": "unverified", "reason": "synthetic_input"}),
            );
        } else if method == "pasteText" {
            action.insert(
                "verification".into(),
                json!({"state": "unverified", "reason": "clipboard_paste"}),
            );
        } else if method == "setValue" {
            action.insert(
                "verification".into(),
                set_value_verification(params, &snapshot),
            );
        }
    }
}

fn set_value_verification(params: &Value, snapshot: &Value) -> Value {
    let expected = params.get("value").and_then(Value::as_str);
    let index = params.get("elementIndex").and_then(Value::as_u64);
    let actual = index.and_then(|index| {
        snapshot
            .get("elements")
            .and_then(Value::as_array)
            .and_then(|elements| {
                elements
                    .iter()
                    .find(|element| element.get("index").and_then(Value::as_u64) == Some(index))
            })
            .and_then(|element| element.get("value"))
            .and_then(Value::as_str)
    });
    match (expected, actual) {
        (Some(expected), Some(actual)) if expected == actual => json!({
            "state": "verified", "property": "value", "expected": expected, "actualPreview": actual
        }),
        (Some(expected), actual) => json!({
            "state": "unverified",
            "reason": if actual.is_some() { "value_mismatch" } else { "provider_unavailable" },
            "expected": expected,
            "actualPreview": actual
        }),
        _ => json!({"state": "unverified", "reason": "provider_unavailable"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_window_target_and_verifies_set_value() {
        let mut response = json!({
            "action": {"path": "accessibility", "actionName": "setValue"},
            "snapshot": {"windowId": 7, "windowIndex": 1, "elements": [{"index": 2, "value": "done"}]}
        });
        normalize_action_metadata(
            &mut response,
            "setValue",
            &json!({"app": "Editor", "elementIndex": 2, "value": "done"}),
        );
        assert_eq!(response["action"]["targetWindowId"], 7);
        assert_eq!(response["action"]["verification"]["state"], "verified");
    }
}
