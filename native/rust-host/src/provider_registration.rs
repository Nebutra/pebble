use std::collections::BTreeSet;
use std::time::Duration;

use crate::host_command::DEFAULT_RUNTIME_URL;
use crate::runtime_status_probe::{
    default_runtime_status_timeout, write_runtime_resource, RuntimeResourceGetResult,
    RuntimeResourceWriteMethod, RuntimeResourceWriteRequest, RuntimeTransportState,
};

pub const PROVIDERS_PATH: &str = "/v1/providers";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeProviderRegistrationCommand {
    pub runtime_url: String,
    pub bearer_token: Option<String>,
    pub timeout_ms: u64,
    pub id: Option<String>,
    pub subsystem: String,
    pub name: String,
    pub status: Option<String>,
    pub capabilities: Vec<String>,
    pub message: Option<String>,
}

impl Default for NativeProviderRegistrationCommand {
    fn default() -> Self {
        let timeout = default_runtime_status_timeout();

        Self {
            runtime_url: DEFAULT_RUNTIME_URL.to_string(),
            bearer_token: None,
            timeout_ms: timeout.as_millis() as u64,
            id: None,
            subsystem: String::new(),
            name: String::new(),
            status: None,
            capabilities: Vec::new(),
            message: None,
        }
    }
}

pub fn register_native_provider(
    command: NativeProviderRegistrationCommand,
) -> RuntimeResourceGetResult {
    let body = match native_provider_registration_body(&command) {
        Ok(body) => body,
        Err(error) => {
            return RuntimeResourceGetResult {
                runtime_url: command.runtime_url,
                request_path: PROVIDERS_PATH.to_string(),
                transport: RuntimeTransportState::InvalidEndpoint,
                http_status: None,
                body: None,
                error: Some(error),
            };
        }
    };

    write_runtime_resource(RuntimeResourceWriteRequest::new(
        command.runtime_url,
        PROVIDERS_PATH,
        RuntimeResourceWriteMethod::Post,
        body,
        command.bearer_token,
        Duration::from_millis(command.timeout_ms.max(1)),
    ))
}

fn native_provider_registration_body(
    command: &NativeProviderRegistrationCommand,
) -> Result<String, String> {
    let subsystem = command.subsystem.trim();
    if !is_native_provider_subsystem(subsystem) {
        return Err("native provider subsystem must be browser, computer, or emulator".to_string());
    }
    let name = command.name.trim();
    if name.is_empty() {
        return Err("native provider name is required".to_string());
    }
    let status = command
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("ready");
    if !is_native_provider_status(status) {
        return Err(
            "native provider status must be ready, running, degraded, or error".to_string(),
        );
    }

    let mut body = serde_json::Map::new();
    if let Some(id) = command
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let required_prefix = format!("{}:", subsystem);
        if !id.starts_with(&required_prefix) {
            return Err("native provider id must be scoped to subsystem".to_string());
        }
        body.insert("id".to_string(), serde_json::json!(id));
    }
    body.insert("subsystem".to_string(), serde_json::json!(subsystem));
    body.insert("name".to_string(), serde_json::json!(name));
    body.insert("status".to_string(), serde_json::json!(status));
    body.insert(
        "capabilities".to_string(),
        serde_json::json!(normalize_capabilities(&command.capabilities)),
    );
    if let Some(message) = command
        .message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.insert("message".to_string(), serde_json::json!(message));
    }

    Ok(serde_json::Value::Object(body).to_string())
}

fn normalize_capabilities(capabilities: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    for capability in capabilities {
        let capability = capability.trim();
        if !capability.is_empty() {
            seen.insert(capability.to_string());
        }
    }
    seen.into_iter().collect()
}

fn is_native_provider_subsystem(subsystem: &str) -> bool {
    matches!(subsystem, "browser" | "computer" | "emulator")
}

fn is_native_provider_status(status: &str) -> bool {
    matches!(status, "ready" | "running" | "degraded" | "error")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_native_provider_registration_body() {
        let command = NativeProviderRegistrationCommand {
            id: Some("browser:tauri-action-bridge".to_string()),
            subsystem: " browser ".to_string(),
            name: " tauri-action-bridge ".to_string(),
            status: Some(" degraded ".to_string()),
            capabilities: vec![
                "tabs".to_string(),
                "screenshots".to_string(),
                "tabs".to_string(),
                "actions".to_string(),
            ],
            message: Some(" action bridge online ".to_string()),
            ..NativeProviderRegistrationCommand::default()
        };

        let body = native_provider_registration_body(&command).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();

        assert_eq!(
            parsed,
            serde_json::json!({
                "id": "browser:tauri-action-bridge",
                "subsystem": "browser",
                "name": "tauri-action-bridge",
                "status": "degraded",
                "capabilities": ["actions", "screenshots", "tabs"],
                "message": "action bridge online"
            })
        );
    }

    #[test]
    fn defaults_native_provider_status_to_ready() {
        let command = NativeProviderRegistrationCommand {
            subsystem: "computer".to_string(),
            name: "accessibility".to_string(),
            status: Some(" ".to_string()),
            ..NativeProviderRegistrationCommand::default()
        };

        let body = native_provider_registration_body(&command).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();

        assert_eq!(parsed["status"], "ready");
    }

    #[test]
    fn rejects_invalid_native_provider_subsystem() {
        let command = NativeProviderRegistrationCommand {
            subsystem: "source-control".to_string(),
            name: "git".to_string(),
            ..NativeProviderRegistrationCommand::default()
        };

        let error = native_provider_registration_body(&command).unwrap_err();

        assert!(error.contains("subsystem"));
    }

    #[test]
    fn rejects_invalid_native_provider_status() {
        let command = NativeProviderRegistrationCommand {
            subsystem: "browser".to_string(),
            name: "tauri".to_string(),
            status: Some("maybe".to_string()),
            ..NativeProviderRegistrationCommand::default()
        };

        let error = native_provider_registration_body(&command).unwrap_err();

        assert!(error.contains("status"));
    }

    #[test]
    fn rejects_native_provider_id_from_different_subsystem() {
        let command = NativeProviderRegistrationCommand {
            id: Some("computer:accessibility".to_string()),
            subsystem: "browser".to_string(),
            name: "tauri".to_string(),
            ..NativeProviderRegistrationCommand::default()
        };

        let error = native_provider_registration_body(&command).unwrap_err();

        assert!(error.contains("scoped"));
    }
}
