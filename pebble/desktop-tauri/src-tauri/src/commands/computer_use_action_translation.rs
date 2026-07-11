use serde_json::Value;

/// Protocol version the bundled "Pebble Computer Use.app" helper must speak.
/// Mirrors Electron's REQUIRED_MACOS_PROVIDER_PROTOCOL_VERSION
/// (src/main/computer/macos-native-provider-contract.ts).
pub const REQUIRED_HELPER_PROTOCOL_VERSION: u64 = 1;

/// Kind prefix the provider claims from the Go runtime action queue.
pub const COMPUTER_ACTION_KIND_PREFIX: &str = "computer.";

/// One claimed action from POST /v1/computer/actions/claim.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimedComputerAction {
    pub id: String,
    pub kind: String,
    pub payload: Value,
}

/// How a claimed queue kind maps onto the helper-app JSON protocol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComputerActionPlan {
    /// Forward to the helper socket as this protocol method.
    HelperCall { method: &'static str },
    /// Answer from the cached handshake capabilities, no helper round-trip.
    Capabilities,
    /// Typed refusal: the kind is known but must not run through the queue.
    Unsupported { reason: &'static str },
    /// Typed refusal: the kind is not a computer-use action at all.
    UnknownKind,
}

/// Typed failure from an executor, serialized as "code: message" — the same
/// code vocabulary Electron's RuntimeClientError uses (accessibility_error,
/// action_timeout, provider_incompatible, ...).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutorFailure {
    pub code: String,
    pub message: String,
}

impl ExecutorFailure {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn typed_message(&self) -> String {
        format!("{}: {}", self.code, self.message)
    }
}

/// Boundary that actually talks to the macOS helper. Isolated as a trait so
/// action-routing logic stays testable without a GUI session or the helper app.
pub trait ComputerActionExecutor {
    fn capabilities(&mut self) -> Result<Value, ExecutorFailure>;
    fn call(&mut self, method: &'static str, params: &Value) -> Result<Value, ExecutorFailure>;
}

/// Terminal outcome for one claimed action, posted back to the Go queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionCompletion {
    Completed { result_json: String },
    Failed { error_message: String },
}

pub fn plan_computer_action(kind: &str) -> ComputerActionPlan {
    let method = match kind.strip_prefix(COMPUTER_ACTION_KIND_PREFIX) {
        Some(method) => method,
        None => return ComputerActionPlan::UnknownKind,
    };
    match method {
        "capabilities" => ComputerActionPlan::Capabilities,
        "listApps" => ComputerActionPlan::HelperCall { method: "listApps" },
        "listWindows" => ComputerActionPlan::HelperCall {
            method: "listWindows",
        },
        // "snapshot" is the Electron client-side name for the same helper call.
        "getAppState" | "snapshot" => ComputerActionPlan::HelperCall {
            method: "getAppState",
        },
        "click" => ComputerActionPlan::HelperCall { method: "click" },
        "performSecondaryAction" => ComputerActionPlan::HelperCall {
            method: "performSecondaryAction",
        },
        "scroll" => ComputerActionPlan::HelperCall { method: "scroll" },
        "drag" => ComputerActionPlan::HelperCall { method: "drag" },
        "typeText" => ComputerActionPlan::HelperCall { method: "typeText" },
        "pressKey" => ComputerActionPlan::HelperCall { method: "pressKey" },
        "hotkey" => ComputerActionPlan::HelperCall { method: "hotkey" },
        "pasteText" => ComputerActionPlan::HelperCall {
            method: "pasteText",
        },
        "setValue" => ComputerActionPlan::HelperCall { method: "setValue" },
        // Permission flows must go through the dedicated Tauri commands so TCC
        // prompts attach to a user gesture, never a background queue drain.
        "permissions" | "permissionsStatus" => ComputerActionPlan::Unsupported {
            reason: "permission flows must use the computer_permissions Tauri commands",
        },
        _ => ComputerActionPlan::UnknownKind,
    }
}

/// Parses the claim-response body (JSON array of computer actions; the Go
/// runtime serializes an empty claim as `null`).
pub fn parse_claimed_actions(body: &str) -> Result<Vec<ClaimedComputerAction>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|error| format!("claim response is not valid JSON: {error}"))?;
    let entries = match value {
        Value::Null => return Ok(Vec::new()),
        Value::Array(entries) => entries,
        _ => return Err("claim response must be a JSON array".to_string()),
    };
    let mut actions = Vec::with_capacity(entries.len());
    for entry in entries {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "claimed action is missing an id".to_string())?
            .to_string();
        let kind = entry
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let payload = entry.get("payload").cloned().unwrap_or(Value::Null);
        actions.push(ClaimedComputerAction { id, kind, payload });
    }
    Ok(actions)
}

pub fn execute_claimed_action(
    executor: &mut dyn ComputerActionExecutor,
    action: &ClaimedComputerAction,
) -> ActionCompletion {
    match plan_computer_action(&action.kind) {
        ComputerActionPlan::Capabilities => match executor.capabilities() {
            Ok(result) => completed(result),
            Err(failure) => ActionCompletion::Failed {
                error_message: failure.typed_message(),
            },
        },
        ComputerActionPlan::HelperCall { method } => {
            let params = match &action.payload {
                Value::Null => Value::Object(serde_json::Map::new()),
                Value::Object(_) => action.payload.clone(),
                _ => {
                    return ActionCompletion::Failed {
                        error_message: format!(
                            "invalid_action_payload: {} payload must be a JSON object",
                            action.kind
                        ),
                    }
                }
            };
            match executor.call(method, &params) {
                Ok(result) => completed(result),
                Err(failure) => ActionCompletion::Failed {
                    error_message: failure.typed_message(),
                },
            }
        }
        ComputerActionPlan::Unsupported { reason } => ActionCompletion::Failed {
            error_message: format!("unsupported_action_kind: {reason}"),
        },
        ComputerActionPlan::UnknownKind => ActionCompletion::Failed {
            error_message: format!(
                "unsupported_action_kind: {} is not a supported computer-use action",
                action.kind
            ),
        },
    }
}

/// Typed failure posted when macOS TCC permissions are missing; never fake
/// success or silently drop the claim.
pub fn permission_denied_completion(missing_permissions: &[String]) -> ActionCompletion {
    ActionCompletion::Failed {
        error_message: format!(
            "permission_denied: missing macOS permissions for Pebble Computer Use: {}",
            missing_permissions.join(", ")
        ),
    }
}

/// The queue PATCH body requires `result` to be a JSON object.
fn completed(result: Value) -> ActionCompletion {
    let object = match result {
        Value::Object(_) => result,
        other => serde_json::json!({ "value": other }),
    };
    ActionCompletion::Completed {
        result_json: object.to_string(),
    }
}

/// Validates the helper handshake payload and returns its capabilities.
pub fn accept_handshake_capabilities(handshake: Value) -> Result<Value, ExecutorFailure> {
    let protocol_version = handshake.get("protocolVersion").and_then(Value::as_u64);
    if protocol_version != Some(REQUIRED_HELPER_PROTOCOL_VERSION) {
        return Err(ExecutorFailure::new(
            "provider_incompatible",
            format!(
                "native macOS provider protocol {} is incompatible with required protocol {}",
                protocol_version
                    .map(|version| version.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                REQUIRED_HELPER_PROTOCOL_VERSION
            ),
        ));
    }
    Ok(handshake)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeExecutor {
        calls: Vec<(String, Value)>,
        response: Result<Value, ExecutorFailure>,
    }

    impl FakeExecutor {
        fn returning(response: Result<Value, ExecutorFailure>) -> Self {
            Self {
                calls: Vec::new(),
                response,
            }
        }
    }

    impl ComputerActionExecutor for FakeExecutor {
        fn capabilities(&mut self) -> Result<Value, ExecutorFailure> {
            self.calls.push(("capabilities".to_string(), Value::Null));
            self.response.clone()
        }

        fn call(&mut self, method: &'static str, params: &Value) -> Result<Value, ExecutorFailure> {
            self.calls.push((method.to_string(), params.clone()));
            self.response.clone()
        }
    }

    fn action(kind: &str, payload: Value) -> ClaimedComputerAction {
        ClaimedComputerAction {
            id: "cact_1".to_string(),
            kind: kind.to_string(),
            payload,
        }
    }

    #[test]
    fn plans_every_electron_parity_action_kind() {
        for (kind, method) in [
            ("computer.listApps", "listApps"),
            ("computer.listWindows", "listWindows"),
            ("computer.getAppState", "getAppState"),
            ("computer.snapshot", "getAppState"),
            ("computer.click", "click"),
            ("computer.performSecondaryAction", "performSecondaryAction"),
            ("computer.scroll", "scroll"),
            ("computer.drag", "drag"),
            ("computer.typeText", "typeText"),
            ("computer.pressKey", "pressKey"),
            ("computer.hotkey", "hotkey"),
            ("computer.pasteText", "pasteText"),
            ("computer.setValue", "setValue"),
        ] {
            assert_eq!(
                plan_computer_action(kind),
                ComputerActionPlan::HelperCall { method },
                "kind {kind}"
            );
        }
        assert_eq!(
            plan_computer_action("computer.capabilities"),
            ComputerActionPlan::Capabilities
        );
    }

    #[test]
    fn refuses_permission_kinds_and_unknown_kinds() {
        assert!(matches!(
            plan_computer_action("computer.permissions"),
            ComputerActionPlan::Unsupported { .. }
        ));
        assert!(matches!(
            plan_computer_action("computer.permissionsStatus"),
            ComputerActionPlan::Unsupported { .. }
        ));
        assert_eq!(
            plan_computer_action("computer.launchMissiles"),
            ComputerActionPlan::UnknownKind
        );
        assert_eq!(
            plan_computer_action("browser.click"),
            ComputerActionPlan::UnknownKind
        );
    }

    #[test]
    fn parses_claimed_actions_including_null_body() {
        assert_eq!(parse_claimed_actions("null").unwrap(), Vec::new());
        let actions = parse_claimed_actions(
            r#"[{"id":"cact_1","kind":"computer.click","payload":{"app":"Safari","x":1,"y":2},"status":"running"}]"#,
        )
        .unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].id, "cact_1");
        assert_eq!(actions[0].kind, "computer.click");
        assert_eq!(actions[0].payload["app"], "Safari");
    }

    #[test]
    fn rejects_claimed_actions_without_ids() {
        let error = parse_claimed_actions(r#"[{"kind":"computer.click"}]"#).unwrap_err();
        assert!(error.contains("missing an id"));
    }

    #[test]
    fn forwards_helper_call_with_object_payload() {
        let mut executor =
            FakeExecutor::returning(Ok(serde_json::json!({ "verification": "passed" })));
        let completion = execute_claimed_action(
            &mut executor,
            &action("computer.click", serde_json::json!({"app": "Safari"})),
        );
        assert_eq!(executor.calls.len(), 1);
        assert_eq!(executor.calls[0].0, "click");
        assert_eq!(
            completion,
            ActionCompletion::Completed {
                result_json: r#"{"verification":"passed"}"#.to_string()
            }
        );
    }

    #[test]
    fn defaults_null_payload_to_empty_object() {
        let mut executor = FakeExecutor::returning(Ok(serde_json::json!({ "apps": [] })));
        execute_claimed_action(&mut executor, &action("computer.listApps", Value::Null));
        assert_eq!(executor.calls[0].1, serde_json::json!({}));
    }

    #[test]
    fn rejects_non_object_payload_without_calling_helper() {
        let mut executor = FakeExecutor::returning(Ok(Value::Null));
        let completion = execute_claimed_action(
            &mut executor,
            &action("computer.click", serde_json::json!([1, 2])),
        );
        assert!(executor.calls.is_empty());
        assert!(matches!(
            completion,
            ActionCompletion::Failed { error_message } if error_message.starts_with("invalid_action_payload:")
        ));
    }

    #[test]
    fn wraps_non_object_helper_results_for_the_queue() {
        let mut executor = FakeExecutor::returning(Ok(serde_json::json!(true)));
        let completion =
            execute_claimed_action(&mut executor, &action("computer.typeText", Value::Null));
        assert_eq!(
            completion,
            ActionCompletion::Completed {
                result_json: r#"{"value":true}"#.to_string()
            }
        );
    }

    #[test]
    fn maps_executor_failures_to_typed_messages() {
        let mut executor = FakeExecutor::returning(Err(ExecutorFailure::new(
            "action_timeout",
            "native macOS provider click timed out",
        )));
        let completion =
            execute_claimed_action(&mut executor, &action("computer.click", Value::Null));
        assert_eq!(
            completion,
            ActionCompletion::Failed {
                error_message: "action_timeout: native macOS provider click timed out".to_string()
            }
        );
    }

    #[test]
    fn permission_denied_completion_is_typed() {
        let completion =
            permission_denied_completion(&["accessibility".to_string(), "screenshots".to_string()]);
        assert_eq!(
            completion,
            ActionCompletion::Failed {
                error_message: "permission_denied: missing macOS permissions for Pebble Computer Use: accessibility, screenshots".to_string()
            }
        );
    }

    #[test]
    fn accepts_only_the_required_handshake_protocol() {
        let capabilities = serde_json::json!({ "protocolVersion": 1, "supports": {} });
        assert_eq!(
            accept_handshake_capabilities(capabilities.clone()).unwrap(),
            capabilities
        );
        let failure =
            accept_handshake_capabilities(serde_json::json!({ "protocolVersion": 2 })).unwrap_err();
        assert_eq!(failure.code, "provider_incompatible");
        let failure = accept_handshake_capabilities(serde_json::json!({})).unwrap_err();
        assert!(failure.message.contains("unknown"));
    }
}
