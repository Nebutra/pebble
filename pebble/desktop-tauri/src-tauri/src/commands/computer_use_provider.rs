//! Native computer-use provider: drains the Go runtime's /v1/computer/actions
//! queue and executes each claimed action on macOS through the bundled
//! "Pebble Computer Use.app" helper (Electron parity — the helper owns
//! screenshots, accessibility reads, and input synthesis).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

pub const COMPUTER_PROVIDER_ID: &str = "computer:tauri-macos-native";
pub const COMPUTER_PROVIDER_NAME: &str = "macos-native-helper";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseProviderStartCommand {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseProviderStartResult {
    pub supported: bool,
    pub platform: &'static str,
    pub provider_id: Option<&'static str>,
    /// Honest-gap detail when unsupported: why this platform cannot run the provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_reason: Option<String>,
}

#[derive(Default)]
pub struct ComputerUseProviderState {
    stop_flag: Mutex<Option<Arc<AtomicBool>>>,
}

/// Starts the background queue consumer. Idempotent while a worker is live.
/// Linux/Windows return an explicit unsupported result and never register,
/// so the runtime's computer subsystem keeps its stub/unsupported status there.
#[tauri::command]
pub async fn start_computer_use_provider(
    app: AppHandle,
    state: State<'_, ComputerUseProviderState>,
    input: ComputerUseProviderStartCommand,
) -> Result<ComputerUseProviderStartResult, String> {
    if !cfg!(target_os = "macos") {
        return Ok(ComputerUseProviderStartResult {
            supported: false,
            platform: std::env::consts::OS,
            provider_id: None,
            unsupported_reason: Some(
                "native computer-use execution requires the macOS Pebble Computer Use helper"
                    .to_string(),
            ),
        });
    }
    {
        let mut slot = state
            .stop_flag
            .lock()
            .map_err(|_| "computer-use provider state was poisoned".to_string())?;
        if let Some(existing) = slot.as_ref() {
            if !existing.load(Ordering::SeqCst) {
                return Ok(supported_result());
            }
        }
        let stop = Arc::new(AtomicBool::new(false));
        *slot = Some(stop.clone());
        spawn_worker(app, input, stop);
    }
    Ok(supported_result())
}

/// Stops the worker after its current cycle; the queue is left intact.
#[tauri::command]
pub fn stop_computer_use_provider(app: AppHandle) {
    let state = app.state::<ComputerUseProviderState>();
    let stop = state
        .stop_flag
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().cloned());
    if let Some(stop) = stop {
        stop.store(true, Ordering::SeqCst);
    }
}

fn supported_result() -> ComputerUseProviderStartResult {
    ComputerUseProviderStartResult {
        supported: true,
        platform: std::env::consts::OS,
        provider_id: Some(COMPUTER_PROVIDER_ID),
        unsupported_reason: None,
    }
}

fn default_runtime_url() -> String {
    pebble_rust_host::DEFAULT_RUNTIME_URL.to_string()
}

#[cfg(not(target_os = "macos"))]
fn spawn_worker(_app: AppHandle, _input: ComputerUseProviderStartCommand, _stop: Arc<AtomicBool>) {}

// Why: every step (queue HTTP, helper socket I/O, permission probes) blocks,
// so the whole loop runs on one blocking-pool thread instead of interleaving
// spawn_blocking hops; commands stay async per the Tauri main-thread rule.
#[cfg(target_os = "macos")]
fn spawn_worker(app: AppHandle, input: ComputerUseProviderStartCommand, stop: Arc<AtomicBool>) {
    tauri::async_runtime::spawn_blocking(move || {
        macos_worker::run_provider_loop(app, input, stop);
    });
}

#[cfg(target_os = "macos")]
mod macos_worker {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    use pebble_rust_host::{
        poll_native_actions, register_native_provider, update_native_action,
        NativeActionPollCommand, NativeActionUpdateCommand, NativeProviderRegistrationCommand,
    };
    use tauri::AppHandle;

    use super::super::computer_permissions::{
        computer_use_helper_executable, computer_use_missing_permissions,
    };
    use super::super::computer_use_action_translation::{
        execute_claimed_action, parse_claimed_actions, permission_denied_completion,
        ActionCompletion, ClaimedComputerAction, COMPUTER_ACTION_KIND_PREFIX,
    };
    use super::super::computer_use_helper_socket::HelperSocketExecutor;
    use super::{ComputerUseProviderStartCommand, COMPUTER_PROVIDER_ID, COMPUTER_PROVIDER_NAME};

    const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(900);
    const RUNTIME_ERROR_BACKOFF: Duration = Duration::from_secs(5);
    const CLAIM_LIMIT: usize = 8;
    const QUEUE_HTTP_TIMEOUT_MS: u64 = 10_000;
    // Completion PATCHes carry screenshots; give them a longer window.
    const UPDATE_HTTP_TIMEOUT_MS: u64 = 30_000;
    // Permission probes launch the helper app via `open`; cache to avoid
    // relaunching it for every claimed batch.
    const PERMISSION_CACHE_TTL: Duration = Duration::from_secs(15);

    struct PermissionCache {
        checked_at: Option<Instant>,
        missing: Result<Vec<String>, String>,
    }

    pub fn run_provider_loop(
        app: AppHandle,
        input: ComputerUseProviderStartCommand,
        stop: Arc<AtomicBool>,
    ) {
        let runtime_url = input.runtime_url;
        let bearer_token = input.bearer_token;
        let helper_executable = computer_use_helper_executable(&app);
        let mut registered = false;
        let mut executor = helper_executable.clone().map(HelperSocketExecutor::new);
        let mut permission_cache = PermissionCache {
            checked_at: None,
            missing: Ok(Vec::new()),
        };

        while !stop.load(Ordering::SeqCst) {
            if !registered {
                registered = register_provider(&runtime_url, &bearer_token, &helper_executable);
                if !registered {
                    sleep_unless_stopped(&stop, RUNTIME_ERROR_BACKOFF);
                    continue;
                }
            }

            let claim = poll_native_actions(NativeActionPollCommand {
                runtime_url: runtime_url.clone(),
                bearer_token: bearer_token.clone(),
                timeout_ms: QUEUE_HTTP_TIMEOUT_MS,
                kind_prefix: Some(COMPUTER_ACTION_KIND_PREFIX.to_string()),
                limit: CLAIM_LIMIT,
            });
            let http_ok = claim.http_status.is_some_and(|status| status < 300);
            if !http_ok || claim.error.is_some() {
                sleep_unless_stopped(&stop, RUNTIME_ERROR_BACKOFF);
                continue;
            }
            let actions = match parse_claimed_actions(claim.body.as_deref().unwrap_or("null")) {
                Ok(actions) => actions,
                Err(_) => {
                    sleep_unless_stopped(&stop, RUNTIME_ERROR_BACKOFF);
                    continue;
                }
            };
            if actions.is_empty() {
                sleep_unless_stopped(&stop, IDLE_POLL_INTERVAL);
                continue;
            }

            for action in &actions {
                let completion = run_action(&app, &mut executor, &mut permission_cache, action);
                post_completion(&runtime_url, &bearer_token, &action.id, completion);
            }
        }
    }

    fn run_action(
        app: &AppHandle,
        executor: &mut Option<HelperSocketExecutor>,
        permission_cache: &mut PermissionCache,
        action: &ClaimedComputerAction,
    ) -> ActionCompletion {
        let Some(executor) = executor.as_mut() else {
            return ActionCompletion::Failed {
                error_message: "accessibility_error: Pebble Computer Use.app was not found"
                    .to_string(),
            };
        };
        match resolve_missing_permissions(app, permission_cache) {
            Ok(missing) if missing.is_empty() => execute_claimed_action(executor, action),
            Ok(missing) => permission_denied_completion(&missing),
            Err(reason) => ActionCompletion::Failed {
                error_message: format!("permission_denied: could not verify permissions: {reason}"),
            },
        }
    }

    fn resolve_missing_permissions(
        app: &AppHandle,
        cache: &mut PermissionCache,
    ) -> Result<Vec<String>, String> {
        let fresh = cache
            .checked_at
            .is_some_and(|at| at.elapsed() < PERMISSION_CACHE_TTL);
        if !fresh {
            cache.missing = computer_use_missing_permissions(app);
            cache.checked_at = Some(Instant::now());
        }
        cache.missing.clone()
    }

    fn register_provider(
        runtime_url: &str,
        bearer_token: &Option<String>,
        helper_executable: &Option<PathBuf>,
    ) -> bool {
        // Degraded (not error) when the helper bundle is absent: the queue is
        // consumed either way and actions get honest typed failures.
        let (status, message) = match helper_executable {
            Some(_) => ("ready", None),
            None => (
                "degraded",
                Some("Pebble Computer Use.app was not found".to_string()),
            ),
        };
        let result = register_native_provider(NativeProviderRegistrationCommand {
            runtime_url: runtime_url.to_string(),
            bearer_token: bearer_token.clone(),
            timeout_ms: QUEUE_HTTP_TIMEOUT_MS,
            id: Some(COMPUTER_PROVIDER_ID.to_string()),
            subsystem: "computer".to_string(),
            name: COMPUTER_PROVIDER_NAME.to_string(),
            status: Some(status.to_string()),
            capabilities: vec![
                "capabilities".to_string(),
                "listApps".to_string(),
                "listWindows".to_string(),
                "getAppState".to_string(),
                "click".to_string(),
                "performSecondaryAction".to_string(),
                "scroll".to_string(),
                "drag".to_string(),
                "typeText".to_string(),
                "pressKey".to_string(),
                "hotkey".to_string(),
                "pasteText".to_string(),
                "setValue".to_string(),
            ],
            message,
        });
        result.error.is_none() && result.http_status.is_some_and(|status| status < 300)
    }

    fn post_completion(
        runtime_url: &str,
        bearer_token: &Option<String>,
        action_id: &str,
        completion: ActionCompletion,
    ) {
        let (result_json, error_message, status) = match completion {
            ActionCompletion::Completed { result_json } => (
                Some(result_json),
                None,
                pebble_rust_host::NativeActionCompletionStatus::Completed,
            ),
            ActionCompletion::Failed { error_message } => (
                None,
                Some(error_message),
                pebble_rust_host::NativeActionCompletionStatus::Failed,
            ),
        };
        let result = update_native_action(NativeActionUpdateCommand {
            runtime_url: runtime_url.to_string(),
            bearer_token: bearer_token.clone(),
            timeout_ms: UPDATE_HTTP_TIMEOUT_MS,
            action_id: action_id.to_string(),
            status,
            result_json,
            error_message,
        });
        if let Some(error) = result.error {
            // The action stays "running" runtime-side; surfacing here is the
            // only signal since the worker has no renderer channel.
            eprintln!("computer-use provider: failed to post completion for {action_id}: {error}");
        }
    }

    fn sleep_unless_stopped(stop: &Arc<AtomicBool>, duration: Duration) {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(100));
        }
    }
}
