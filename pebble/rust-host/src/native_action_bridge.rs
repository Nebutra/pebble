use std::time::Duration;

use crate::host_command::DEFAULT_RUNTIME_URL;
use crate::runtime_status_probe::{
    default_runtime_status_timeout, write_runtime_resource, RuntimeResourceGetResult,
    RuntimeResourceWriteMethod, RuntimeResourceWriteRequest, RuntimeTransportState,
};

pub const COMPUTER_ACTIONS_PATH: &str = "/v1/computer/actions";
pub const COMPUTER_ACTION_CLAIM_PATH: &str = "/v1/computer/actions/claim";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeActionPollCommand {
    pub runtime_url: String,
    pub bearer_token: Option<String>,
    pub timeout_ms: u64,
    pub kind_prefix: Option<String>,
    pub limit: usize,
}

impl NativeActionPollCommand {
    pub fn queued(kind_prefix: impl Into<String>) -> Self {
        Self {
            kind_prefix: Some(kind_prefix.into()),
            ..Self::default()
        }
    }

    pub fn timeout(&self) -> Duration {
        Duration::from_millis(self.timeout_ms)
    }
}

impl Default for NativeActionPollCommand {
    fn default() -> Self {
        let timeout = default_runtime_status_timeout();

        Self {
            runtime_url: DEFAULT_RUNTIME_URL.to_string(),
            bearer_token: None,
            timeout_ms: timeout.as_millis() as u64,
            kind_prefix: None,
            limit: 25,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeActionCompletionStatus {
    Completed,
    Failed,
}

impl NativeActionCompletionStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeActionUpdateCommand {
    pub runtime_url: String,
    pub bearer_token: Option<String>,
    pub timeout_ms: u64,
    pub action_id: String,
    pub status: NativeActionCompletionStatus,
    pub result_json: Option<String>,
    pub error_message: Option<String>,
}

impl NativeActionUpdateCommand {
    pub fn completed(action_id: impl Into<String>, result_json: Option<String>) -> Self {
        Self {
            action_id: action_id.into(),
            status: NativeActionCompletionStatus::Completed,
            result_json,
            ..Self::default()
        }
    }

    pub fn failed(action_id: impl Into<String>, error_message: impl Into<String>) -> Self {
        Self {
            action_id: action_id.into(),
            status: NativeActionCompletionStatus::Failed,
            error_message: Some(error_message.into()),
            ..Self::default()
        }
    }

    pub fn timeout(&self) -> Duration {
        Duration::from_millis(self.timeout_ms)
    }
}

impl Default for NativeActionUpdateCommand {
    fn default() -> Self {
        let timeout = default_runtime_status_timeout();

        Self {
            runtime_url: DEFAULT_RUNTIME_URL.to_string(),
            bearer_token: None,
            timeout_ms: timeout.as_millis() as u64,
            action_id: String::new(),
            status: NativeActionCompletionStatus::Completed,
            result_json: None,
            error_message: None,
        }
    }
}

pub fn poll_native_actions(command: NativeActionPollCommand) -> RuntimeResourceGetResult {
    let timeout = command.timeout();
    let body = native_action_claim_body(&command);

    write_runtime_resource(RuntimeResourceWriteRequest::new(
        command.runtime_url,
        COMPUTER_ACTION_CLAIM_PATH,
        RuntimeResourceWriteMethod::Post,
        body,
        command.bearer_token,
        timeout,
    ))
}

pub fn update_native_action(command: NativeActionUpdateCommand) -> RuntimeResourceGetResult {
    let body = match native_action_update_body(&command) {
        Ok(body) => body,
        Err(error) => {
            return RuntimeResourceGetResult {
                runtime_url: command.runtime_url,
                request_path: COMPUTER_ACTIONS_PATH.to_string(),
                transport: RuntimeTransportState::InvalidEndpoint,
                http_status: None,
                body: None,
                error: Some(error),
            };
        }
    };
    let timeout = command.timeout();
    let path = format!(
        "{}/{}",
        COMPUTER_ACTIONS_PATH,
        percent_encode_path_segment(command.action_id.trim())
    );

    write_runtime_resource(RuntimeResourceWriteRequest::new(
        command.runtime_url,
        path,
        RuntimeResourceWriteMethod::Patch,
        body,
        command.bearer_token,
        timeout,
    ))
}

fn native_action_claim_body(command: &NativeActionPollCommand) -> String {
    let mut fields = Vec::new();

    if let Some(kind_prefix) = command
        .kind_prefix
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        fields.push(format!("\"kindPrefix\":\"{}\"", json_escape(kind_prefix)));
    }
    fields.push(format!("\"limit\":{}", command.limit));

    format!("{{{}}}", fields.join(","))
}

fn native_action_update_body(command: &NativeActionUpdateCommand) -> Result<String, String> {
    let mut fields = vec![format!(
        "\"status\":\"{}\"",
        json_escape(command.status.as_str())
    )];

    if let Some(result_json) = command
        .result_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        fields.push(format!(
            "\"result\":{}",
            normalize_action_result_json(result_json)?
        ));
    }
    if let Some(error_message) = command
        .error_message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        fields.push(format!("\"error\":\"{}\"", json_escape(error_message)));
    }

    Ok(format!("{{{}}}", fields.join(",")))
}

fn normalize_action_result_json(result_json: &str) -> Result<&str, String> {
    match serde_json::from_str::<serde_json::Value>(result_json) {
        Ok(serde_json::Value::Object(_)) => Ok(result_json),
        Ok(_) => Err("action result_json must be a JSON object".to_string()),
        Err(error) => Err(format!("action result_json must be valid JSON: {}", error)),
    }
}

fn percent_encode_path_segment(value: &str) -> String {
    percent_encode(value, false)
}

fn percent_encode(value: &str, space_as_plus: bool) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char)
            }
            b' ' if space_as_plus => output.push('+'),
            _ => output.push_str(&format!("%{:02X}", byte)),
        }
    }
    output
}

fn json_escape(value: &str) -> String {
    let mut output = String::new();
    for char in value.chars() {
        match char {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            current if current.is_control() => {
                output.push_str(&format!("\\u{:04x}", current as u32))
            }
            current => output.push(current),
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_queued_action_claim_body() {
        let command = NativeActionPollCommand::queued("browser.");

        assert_eq!(
            native_action_claim_body(&command),
            r#"{"kindPrefix":"browser.","limit":25}"#
        );
    }

    #[test]
    fn builds_completed_action_body() {
        let command =
            NativeActionUpdateCommand::completed("cact_1", Some(r#"{"ok":true}"#.to_string()));

        assert_eq!(
            native_action_update_body(&command).unwrap(),
            r#"{"status":"completed","result":{"ok":true}}"#
        );
    }

    #[test]
    fn builds_failed_action_body_with_escaping() {
        let command = NativeActionUpdateCommand::failed("cact_1", "bad \"click\"");

        assert_eq!(
            native_action_update_body(&command).unwrap(),
            r#"{"status":"failed","error":"bad \"click\""}"#
        );
    }

    #[test]
    fn rejects_invalid_completed_action_result_body() {
        let command = NativeActionUpdateCommand::completed("cact_1", Some("not-json".to_string()));

        let error = native_action_update_body(&command).unwrap_err();

        assert!(error.contains("valid JSON"));
    }

    #[test]
    fn rejects_non_object_completed_action_result_body() {
        let command = NativeActionUpdateCommand::completed("cact_1", Some("true".to_string()));

        let error = native_action_update_body(&command).unwrap_err();

        assert_eq!(error, "action result_json must be a JSON object");
    }
}
