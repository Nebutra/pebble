use crate::host_command::DEFAULT_RUNTIME_URL;
use crate::native_action_bridge::{
    poll_native_actions, update_native_action, NativeActionCompletionStatus,
    NativeActionPollCommand, NativeActionUpdateCommand,
};
use crate::runtime_status_probe::{default_runtime_status_timeout, RuntimeResourceGetResult};

pub const EMULATOR_ACTION_KIND_PREFIX: &str = "emulator.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmulatorActionPollCommand {
    pub runtime_url: String,
    pub bearer_token: Option<String>,
    pub timeout_ms: u64,
    pub limit: usize,
}

impl Default for EmulatorActionPollCommand {
    fn default() -> Self {
        let timeout = default_runtime_status_timeout();

        Self {
            runtime_url: DEFAULT_RUNTIME_URL.to_string(),
            bearer_token: None,
            timeout_ms: timeout.as_millis() as u64,
            limit: 25,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmulatorActionUpdateCommand {
    pub runtime_url: String,
    pub bearer_token: Option<String>,
    pub timeout_ms: u64,
    pub action_id: String,
    pub status: NativeActionCompletionStatus,
    pub result_json: Option<String>,
    pub error_message: Option<String>,
}

impl EmulatorActionUpdateCommand {
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

impl Default for EmulatorActionUpdateCommand {
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

pub fn poll_emulator_actions(command: EmulatorActionPollCommand) -> RuntimeResourceGetResult {
    poll_native_actions(native_poll_command(command))
}

pub fn update_emulator_action(command: EmulatorActionUpdateCommand) -> RuntimeResourceGetResult {
    update_native_action(native_update_command(command))
}

fn native_poll_command(command: EmulatorActionPollCommand) -> NativeActionPollCommand {
    NativeActionPollCommand {
        runtime_url: command.runtime_url,
        bearer_token: command.bearer_token,
        timeout_ms: command.timeout_ms,
        // Emulator providers should not claim browser or generic computer actions.
        kind_prefix: Some(EMULATOR_ACTION_KIND_PREFIX.to_string()),
        limit: command.limit,
    }
}

fn native_update_command(command: EmulatorActionUpdateCommand) -> NativeActionUpdateCommand {
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
    fn emulator_poll_claims_only_emulator_actions() {
        let command = EmulatorActionPollCommand {
            runtime_url: "http://127.0.0.1:17778".to_string(),
            bearer_token: Some("token".to_string()),
            timeout_ms: 42,
            limit: 7,
        };

        let native = native_poll_command(command);

        assert_eq!(native.runtime_url, "http://127.0.0.1:17778");
        assert_eq!(native.bearer_token, Some("token".to_string()));
        assert_eq!(native.timeout_ms, 42);
        assert_eq!(
            native.kind_prefix,
            Some(EMULATOR_ACTION_KIND_PREFIX.to_string())
        );
        assert_eq!(native.limit, 7);
    }

    #[test]
    fn emulator_update_reuses_native_completion_contract() {
        let command = EmulatorActionUpdateCommand::completed(
            "cact_1",
            Some(r#"{"path":"screen.png"}"#.to_string()),
        );

        let native = native_update_command(command);

        assert_eq!(native.action_id, "cact_1");
        assert_eq!(native.status, NativeActionCompletionStatus::Completed);
        assert_eq!(
            native.result_json,
            Some(r#"{"path":"screen.png"}"#.to_string())
        );
    }
}
