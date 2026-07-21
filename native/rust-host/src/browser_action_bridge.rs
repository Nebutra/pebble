use crate::host_command::DEFAULT_RUNTIME_URL;
use crate::native_action_bridge::{
    poll_native_actions, update_native_action, NativeActionCompletionStatus,
    NativeActionPollCommand, NativeActionUpdateCommand,
};
use crate::runtime_status_probe::{default_runtime_status_timeout, RuntimeResourceGetResult};

pub const BROWSER_ACTION_KIND_PREFIX: &str = "browser.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserActionPollCommand {
    pub runtime_url: String,
    pub bearer_token: Option<String>,
    pub timeout_ms: u64,
    pub limit: usize,
    pub targets: Vec<String>,
}

impl Default for BrowserActionPollCommand {
    fn default() -> Self {
        let timeout = default_runtime_status_timeout();

        Self {
            runtime_url: DEFAULT_RUNTIME_URL.to_string(),
            bearer_token: None,
            timeout_ms: timeout.as_millis() as u64,
            limit: 25,
            targets: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserActionUpdateCommand {
    pub runtime_url: String,
    pub bearer_token: Option<String>,
    pub timeout_ms: u64,
    pub action_id: String,
    pub status: NativeActionCompletionStatus,
    pub result_json: Option<String>,
    pub error_message: Option<String>,
}

impl BrowserActionUpdateCommand {
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
}

impl Default for BrowserActionUpdateCommand {
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

pub fn poll_browser_actions(command: BrowserActionPollCommand) -> RuntimeResourceGetResult {
    poll_native_actions(native_poll_command(command))
}

pub fn update_browser_action(command: BrowserActionUpdateCommand) -> RuntimeResourceGetResult {
    update_native_action(native_update_command(command))
}

fn native_poll_command(command: BrowserActionPollCommand) -> NativeActionPollCommand {
    NativeActionPollCommand {
        runtime_url: command.runtime_url,
        bearer_token: command.bearer_token,
        timeout_ms: command.timeout_ms,
        // Browser adapters should not accidentally claim generic keyboard or computer actions.
        kind_prefix: Some(BROWSER_ACTION_KIND_PREFIX.to_string()),
        limit: command.limit,
        targets: command.targets,
    }
}

fn native_update_command(command: BrowserActionUpdateCommand) -> NativeActionUpdateCommand {
    NativeActionUpdateCommand {
        runtime_url: command.runtime_url,
        bearer_token: command.bearer_token,
        timeout_ms: command.timeout_ms,
        action_id: command.action_id,
        status: command.status,
        result_json: command.result_json,
        error_message: command.error_message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_poll_claims_only_browser_actions() {
        let command = BrowserActionPollCommand {
            runtime_url: "http://127.0.0.1:17778".to_string(),
            bearer_token: Some("token".to_string()),
            timeout_ms: 42,
            limit: 7,
            targets: vec!["page-1".to_string()],
        };

        let native = native_poll_command(command);

        assert_eq!(native.runtime_url, "http://127.0.0.1:17778");
        assert_eq!(native.bearer_token, Some("token".to_string()));
        assert_eq!(native.timeout_ms, 42);
        assert_eq!(
            native.kind_prefix,
            Some(BROWSER_ACTION_KIND_PREFIX.to_string())
        );
        assert_eq!(native.limit, 7);
        assert_eq!(native.targets, vec!["page-1".to_string()]);
    }

    #[test]
    fn browser_update_reuses_native_completion_contract() {
        let command = BrowserActionUpdateCommand::completed(
            "cact_1",
            Some(r#"{"url":"https://pebble.dev"}"#.to_string()),
        );

        let native = native_update_command(command);

        assert_eq!(native.action_id, "cact_1");
        assert_eq!(native.status, NativeActionCompletionStatus::Completed);
        assert_eq!(
            native.result_json,
            Some(r#"{"url":"https://pebble.dev"}"#.to_string())
        );
    }
}
