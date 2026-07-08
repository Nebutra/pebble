use std::fmt;
use std::time::Duration;

use crate::native_action_bridge::{
    poll_native_actions, update_native_action, NativeActionPollCommand, NativeActionUpdateCommand,
};
use crate::runtime_status_probe::{
    default_runtime_status_timeout, probe_runtime_status, RuntimeResourceGetResult,
    RuntimeStatusProbeRequest, RuntimeStatusProbeResult,
};

pub const DEFAULT_RUNTIME_URL: &str = "http://127.0.0.1:17777";

#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeStatusCommand {
    pub runtime_url: String,
    pub bearer_token: Option<String>,
    pub timeout_ms: u64,
}

impl RuntimeStatusCommand {
    pub fn with_runtime_url(runtime_url: impl Into<String>) -> Self {
        Self {
            runtime_url: runtime_url.into(),
            ..Self::default()
        }
    }

    pub fn timeout(&self) -> Duration {
        Duration::from_millis(self.timeout_ms)
    }
}

impl Default for RuntimeStatusCommand {
    fn default() -> Self {
        let timeout = default_runtime_status_timeout();

        Self {
            runtime_url: DEFAULT_RUNTIME_URL.to_string(),
            bearer_token: None,
            timeout_ms: timeout.as_millis() as u64,
        }
    }
}

impl fmt::Debug for RuntimeStatusCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeStatusCommand")
            .field("runtime_url", &self.runtime_url)
            .field(
                "bearer_token",
                &self.bearer_token.as_ref().map(|_| "<redacted>"),
            )
            .field("timeout_ms", &self.timeout_ms)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostCommand {
    ProbeRuntimeStatus(RuntimeStatusCommand),
    PollNativeActions(NativeActionPollCommand),
    UpdateNativeAction(NativeActionUpdateCommand),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostCommandOutput {
    RuntimeStatus(RuntimeStatusProbeResult),
    RuntimeResource(RuntimeResourceGetResult),
}

pub fn run_host_command(command: HostCommand) -> HostCommandOutput {
    match command {
        HostCommand::ProbeRuntimeStatus(command) => {
            HostCommandOutput::RuntimeStatus(probe_runtime_status(command.into()))
        }
        HostCommand::PollNativeActions(command) => {
            HostCommandOutput::RuntimeResource(poll_native_actions(command))
        }
        HostCommand::UpdateNativeAction(command) => {
            HostCommandOutput::RuntimeResource(update_native_action(command))
        }
    }
}

impl From<RuntimeStatusCommand> for RuntimeStatusProbeRequest {
    fn from(command: RuntimeStatusCommand) -> Self {
        let timeout = command.timeout();

        Self::new(command.runtime_url, command.bearer_token, timeout)
    }
}
