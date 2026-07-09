use std::time::Duration;

use pebble_rust_host::{
    default_runtime_status_timeout, get_runtime_resource,
    poll_browser_actions as poll_browser_actions_boundary,
    poll_emulator_actions as poll_emulator_actions_boundary,
    poll_native_actions as poll_native_actions_boundary,
    probe_runtime_status as probe_runtime_status_boundary,
    read_runtime_events as read_runtime_events_boundary,
    register_native_provider as register_native_provider_boundary,
    update_browser_action as update_browser_action_boundary,
    update_emulator_action as update_emulator_action_boundary, write_runtime_resource,
    BrowserActionPollCommand, BrowserActionUpdateCommand, EmulatorActionPollCommand,
    EmulatorActionUpdateCommand, NativeActionCompletionStatus, NativeActionPollCommand,
    NativeActionUpdateCommand, NativeProviderRegistrationCommand, RuntimeEventStreamRequest,
    RuntimeEventStreamResult as HostRuntimeEventStreamResult, RuntimeResourceGetRequest,
    RuntimeResourceGetResult as HostRuntimeResourceGetResult, RuntimeResourceWriteMethod,
    RuntimeResourceWriteRequest, RuntimeStatusProbeRequest,
    RuntimeStatusProbeResult as HostRuntimeStatusProbeResult, RuntimeTransportState,
    DEFAULT_RUNTIME_URL,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusProbeCommand {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusProbeResult {
    pub runtime_url: String,
    pub request_path: String,
    pub transport: &'static str,
    pub http_status: Option<u16>,
    pub contract_version: Option<String>,
    pub contract_version_matches: Option<bool>,
    pub service_state: Option<String>,
    pub body: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceGetCommand {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    pub path: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceRequestCommand {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body_json: Option<String>,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceGetResult {
    pub runtime_url: String,
    pub request_path: String,
    pub transport: &'static str,
    pub http_status: Option<u16>,
    pub body: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventStreamCommand {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_event_limit")]
    pub limit: usize,
    #[serde(default)]
    pub topic: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventStreamEntry {
    pub id: Option<String>,
    pub topic: Option<String>,
    pub data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventStreamResult {
    pub runtime_url: String,
    pub request_path: String,
    pub transport: &'static str,
    pub http_status: Option<u16>,
    pub events: Vec<RuntimeEventStreamEntry>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeActionPollInput {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub kind_prefix: Option<String>,
    #[serde(default = "default_native_action_limit")]
    pub limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeActionUpdateInput {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    pub action_id: String,
    pub status: String,
    #[serde(default)]
    pub result_json: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionPollInput {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_native_action_limit")]
    pub limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionUpdateInput {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    pub action_id: String,
    pub status: String,
    #[serde(default)]
    pub result_json: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorActionPollInput {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_native_action_limit")]
    pub limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorActionUpdateInput {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    pub action_id: String,
    pub status: String,
    #[serde(default)]
    pub result_json: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProviderRegistrationInput {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub id: Option<String>,
    pub subsystem: String,
    pub name: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[tauri::command]
pub async fn probe_runtime_status(
    input: RuntimeStatusProbeCommand,
) -> Result<RuntimeStatusProbeResult, String> {
    run_runtime_boundary(move || {
        let timeout_ms = input.timeout_ms.max(1);

        let result = probe_runtime_status_boundary(RuntimeStatusProbeRequest::new(
            input.runtime_url,
            input.bearer_token,
            Duration::from_millis(timeout_ms),
        ));

        result.into()
    })
    .await
}

#[tauri::command]
pub async fn get_runtime_resource_json(
    input: RuntimeResourceGetCommand,
) -> Result<RuntimeResourceGetResult, String> {
    run_runtime_boundary(move || {
        let timeout_ms = input.timeout_ms.max(1);
        let result = get_runtime_resource(RuntimeResourceGetRequest::new(
            input.runtime_url,
            input.path,
            input.bearer_token,
            Duration::from_millis(timeout_ms),
        ));

        result.into()
    })
    .await
}

#[tauri::command]
pub async fn request_runtime_resource_json(
    input: RuntimeResourceRequestCommand,
) -> Result<RuntimeResourceGetResult, String> {
    run_runtime_boundary(move || {
        let timeout = Duration::from_millis(input.timeout_ms.max(1));
        let method = input.method.trim().to_ascii_uppercase();
        let result = match method.as_str() {
            "GET" => get_runtime_resource(RuntimeResourceGetRequest::new(
                input.runtime_url,
                input.path,
                input.bearer_token,
                timeout,
            )),
            "DELETE" | "POST" | "PATCH" => {
                let write_method = match method.as_str() {
                    "DELETE" => RuntimeResourceWriteMethod::Delete,
                    "POST" => RuntimeResourceWriteMethod::Post,
                    "PATCH" => RuntimeResourceWriteMethod::Patch,
                    _ => unreachable!("method is matched above"),
                };
                write_runtime_resource(RuntimeResourceWriteRequest::new(
                    input.runtime_url,
                    input.path,
                    write_method,
                    input.body_json.unwrap_or_else(|| "{}".to_string()),
                    input.bearer_token,
                    timeout,
                ))
            }
            _ => {
                return Err(
                    "runtime resource method must be GET, POST, PATCH, or DELETE".to_string(),
                )
            }
        };

        Ok(result.into())
    })
    .await?
}

#[tauri::command]
pub async fn read_runtime_event_stream(
    input: RuntimeEventStreamCommand,
) -> Result<RuntimeEventStreamResult, String> {
    run_runtime_boundary(move || {
        let mut request = RuntimeEventStreamRequest::new(
            input.runtime_url,
            input.bearer_token,
            Duration::from_millis(input.timeout_ms.max(1)),
            input.limit.clamp(1, 20),
        );
        if let Some(topic) = input.topic {
            request = request.with_topic(topic);
        }
        let result = read_runtime_events_boundary(request);

        result.into()
    })
    .await
}

#[tauri::command]
pub async fn poll_native_actions(
    input: NativeActionPollInput,
) -> Result<RuntimeResourceGetResult, String> {
    run_runtime_boundary(move || {
        let result = poll_native_actions_boundary(NativeActionPollCommand {
            runtime_url: input.runtime_url,
            bearer_token: input.bearer_token,
            timeout_ms: input.timeout_ms.max(1),
            kind_prefix: input.kind_prefix,
            limit: input.limit,
        });

        result.into()
    })
    .await
}

#[tauri::command]
pub async fn update_native_action(
    input: NativeActionUpdateInput,
) -> Result<RuntimeResourceGetResult, String> {
    run_runtime_boundary(move || {
        let status = match input.status.as_str() {
            "completed" => NativeActionCompletionStatus::Completed,
            "failed" => NativeActionCompletionStatus::Failed,
            _ => return Err("native action status must be completed or failed".to_string()),
        };
        let result = pebble_rust_host::update_native_action(NativeActionUpdateCommand {
            runtime_url: input.runtime_url,
            bearer_token: input.bearer_token,
            timeout_ms: input.timeout_ms.max(1),
            action_id: input.action_id,
            status,
            result_json: input.result_json,
            error_message: input.error_message,
        });

        Ok(result.into())
    })
    .await?
}

#[tauri::command]
pub async fn poll_browser_actions(
    input: BrowserActionPollInput,
) -> Result<RuntimeResourceGetResult, String> {
    run_runtime_boundary(move || {
        let result = poll_browser_actions_boundary(BrowserActionPollCommand {
            runtime_url: input.runtime_url,
            bearer_token: input.bearer_token,
            timeout_ms: input.timeout_ms.max(1),
            limit: input.limit,
        });

        result.into()
    })
    .await
}

#[tauri::command]
pub async fn update_browser_action(
    input: BrowserActionUpdateInput,
) -> Result<RuntimeResourceGetResult, String> {
    run_runtime_boundary(move || {
        let status = parse_native_action_status(&input.status)?;
        let result = update_browser_action_boundary(BrowserActionUpdateCommand {
            runtime_url: input.runtime_url,
            bearer_token: input.bearer_token,
            timeout_ms: input.timeout_ms.max(1),
            action_id: input.action_id,
            status,
            result_json: input.result_json,
            error_message: input.error_message,
        });

        Ok(result.into())
    })
    .await?
}

#[tauri::command]
pub async fn poll_emulator_actions(
    input: EmulatorActionPollInput,
) -> Result<RuntimeResourceGetResult, String> {
    run_runtime_boundary(move || {
        let result = poll_emulator_actions_boundary(EmulatorActionPollCommand {
            runtime_url: input.runtime_url,
            bearer_token: input.bearer_token,
            timeout_ms: input.timeout_ms.max(1),
            limit: input.limit,
        });

        result.into()
    })
    .await
}

#[tauri::command]
pub async fn update_emulator_action(
    input: EmulatorActionUpdateInput,
) -> Result<RuntimeResourceGetResult, String> {
    run_runtime_boundary(move || {
        let status = parse_native_action_status(&input.status)?;
        let result = update_emulator_action_boundary(EmulatorActionUpdateCommand {
            runtime_url: input.runtime_url,
            bearer_token: input.bearer_token,
            timeout_ms: input.timeout_ms.max(1),
            action_id: input.action_id,
            status,
            result_json: input.result_json,
            error_message: input.error_message,
        });

        Ok(result.into())
    })
    .await?
}

#[tauri::command]
pub async fn register_native_provider(
    input: NativeProviderRegistrationInput,
) -> Result<RuntimeResourceGetResult, String> {
    run_runtime_boundary(move || {
        let result = register_native_provider_boundary(NativeProviderRegistrationCommand {
            runtime_url: input.runtime_url,
            bearer_token: input.bearer_token,
            timeout_ms: input.timeout_ms.max(1),
            id: input.id,
            subsystem: input.subsystem,
            name: input.name,
            status: input.status,
            capabilities: input.capabilities,
            message: input.message,
        });

        result.into()
    })
    .await
}

impl From<HostRuntimeStatusProbeResult> for RuntimeStatusProbeResult {
    fn from(result: HostRuntimeStatusProbeResult) -> Self {
        Self {
            runtime_url: result.runtime_url,
            request_path: result.request_path,
            transport: transport_label(result.transport),
            http_status: result.http_status,
            contract_version: result.contract_version,
            contract_version_matches: result.contract_version_matches,
            service_state: result.service_state,
            body: result.body,
            error: result.error,
        }
    }
}

impl From<HostRuntimeResourceGetResult> for RuntimeResourceGetResult {
    fn from(result: HostRuntimeResourceGetResult) -> Self {
        Self {
            runtime_url: result.runtime_url,
            request_path: result.request_path,
            transport: transport_label(result.transport),
            http_status: result.http_status,
            body: result.body,
            error: result.error,
        }
    }
}

impl From<HostRuntimeEventStreamResult> for RuntimeEventStreamResult {
    fn from(result: HostRuntimeEventStreamResult) -> Self {
        Self {
            runtime_url: result.runtime_url,
            request_path: result.request_path,
            transport: transport_label(result.transport),
            http_status: result.http_status,
            events: result
                .events
                .into_iter()
                .map(|event| RuntimeEventStreamEntry {
                    id: event.id,
                    topic: event.topic,
                    data: event.data,
                })
                .collect(),
            error: result.error,
        }
    }
}

fn transport_label(state: RuntimeTransportState) -> &'static str {
    state.as_str()
}

fn default_runtime_url() -> String {
    DEFAULT_RUNTIME_URL.to_string()
}

fn default_timeout_ms() -> u64 {
    default_runtime_status_timeout().as_millis() as u64
}

fn default_native_action_limit() -> usize {
    25
}

fn default_event_limit() -> usize {
    5
}

async fn run_runtime_boundary<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    // Why: Tauri dispatches IPC through WebKit's main URL-scheme path on macOS;
    // blocking runtime HTTP/SSE reads here freezes pointer and keyboard input.
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("runtime command worker failed: {}", error))
}

fn parse_native_action_status(status: &str) -> Result<NativeActionCompletionStatus, String> {
    match status {
        "completed" => Ok(NativeActionCompletionStatus::Completed),
        "failed" => Ok(NativeActionCompletionStatus::Failed),
        _ => Err("native action status must be completed or failed".to_string()),
    }
}
