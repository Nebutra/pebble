//! Native computer-use provider lifecycle. Every desktop platform drains the
//! Go action queue; platform modules own only execution and permission policy.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

pub const MACOS_PROVIDER_ID: &str = "computer:tauri-macos-native";
pub const MACOS_PROVIDER_NAME: &str = "macos-native-helper";

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_reason: Option<String>,
}

#[derive(Default)]
pub struct ComputerUseProviderState {
    stop_flag: Mutex<Option<Arc<AtomicBool>>>,
}

impl ComputerUseProviderState {
    fn install_worker(&self) -> Result<Option<Arc<AtomicBool>>, String> {
        let mut slot = self
            .stop_flag
            .lock()
            .map_err(|_| "computer-use provider state was poisoned".to_string())?;
        if slot
            .as_ref()
            .is_some_and(|existing| !existing.load(Ordering::SeqCst))
        {
            return Ok(None);
        }
        let stop = Arc::new(AtomicBool::new(false));
        *slot = Some(stop.clone());
        Ok(Some(stop))
    }

    fn stop_worker(&self) {
        if let Some(stop) = self.stop_flag.lock().ok().and_then(|mut slot| slot.take()) {
            stop.store(true, Ordering::SeqCst);
        }
    }

    fn clear_finished_worker(&self, finished: &Arc<AtomicBool>) {
        if let Ok(mut slot) = self.stop_flag.lock() {
            if slot
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, finished))
            {
                *slot = None;
            }
        }
    }
}

#[tauri::command]
pub async fn start_computer_use_provider(
    app: AppHandle,
    state: State<'_, ComputerUseProviderState>,
    input: ComputerUseProviderStartCommand,
) -> Result<ComputerUseProviderStartResult, String> {
    if !cfg!(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "windows"
    )) {
        return Ok(ComputerUseProviderStartResult {
            supported: false,
            platform: std::env::consts::OS,
            provider_id: None,
            unsupported_reason: Some(
                "native computer-use execution is unavailable on this platform".to_string(),
            ),
        });
    }
    let Some(stop) = state.install_worker()? else {
        return Ok(supported_result());
    };
    spawn_worker(app, input, stop);
    Ok(supported_result())
}

#[tauri::command]
pub fn stop_computer_use_provider(app: AppHandle) {
    let state = app.state::<ComputerUseProviderState>();
    state.stop_worker();
}

fn supported_result() -> ComputerUseProviderStartResult {
    ComputerUseProviderStartResult {
        supported: true,
        platform: std::env::consts::OS,
        provider_id: Some(provider_id()),
        unsupported_reason: None,
    }
}

fn default_runtime_url() -> String {
    pebble_rust_host::DEFAULT_RUNTIME_URL.to_string()
}

// Why: queue HTTP, platform accessibility and screenshots all block; one
// blocking worker preserves action order without stalling Tauri's event loop.
#[cfg(target_os = "macos")]
fn spawn_worker(app: AppHandle, input: ComputerUseProviderStartCommand, stop: Arc<AtomicBool>) {
    let finished = stop.clone();
    tauri::async_runtime::spawn_blocking(move || {
        macos_worker::run(app.clone(), input, stop);
        app.state::<ComputerUseProviderState>()
            .clear_finished_worker(&finished);
    });
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn spawn_worker(app: AppHandle, input: ComputerUseProviderStartCommand, stop: Arc<AtomicBool>) {
    let finished = stop.clone();
    tauri::async_runtime::spawn_blocking(move || {
        desktop_worker::run(app.clone(), input, stop);
        app.state::<ComputerUseProviderState>()
            .clear_finished_worker(&finished);
    });
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn spawn_worker(_app: AppHandle, _input: ComputerUseProviderStartCommand, _stop: Arc<AtomicBool>) {}

#[cfg(target_os = "macos")]
fn provider_id() -> &'static str {
    MACOS_PROVIDER_ID
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn provider_id() -> &'static str {
    super::computer_use_desktop_script::DESKTOP_PROVIDER_ID
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn provider_id() -> &'static str {
    "computer:tauri-unsupported"
}

#[cfg(test)]
mod tests {
    use super::ComputerUseProviderState;
    use std::sync::atomic::Ordering;

    #[test]
    fn running_worker_is_idempotent_and_finished_worker_can_restart() {
        let state = ComputerUseProviderState::default();
        let first = state.install_worker().unwrap().unwrap();
        assert!(state.install_worker().unwrap().is_none());
        state.clear_finished_worker(&first);
        assert!(state.install_worker().unwrap().is_some());
    }

    #[test]
    fn stop_releases_slot_and_old_worker_cannot_clear_replacement() {
        let state = ComputerUseProviderState::default();
        let first = state.install_worker().unwrap().unwrap();
        state.stop_worker();
        assert!(first.load(Ordering::SeqCst));
        let replacement = state.install_worker().unwrap().unwrap();
        state.clear_finished_worker(&first);
        assert!(state.install_worker().unwrap().is_none());
        state.clear_finished_worker(&replacement);
        assert!(state.install_worker().unwrap().is_some());
    }
}

#[cfg(target_os = "macos")]
mod macos_worker {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use tauri::AppHandle;

    use super::super::computer_permissions::{
        computer_use_helper_executable, computer_use_missing_permissions,
    };
    use super::super::computer_use_action_translation::{
        execute_claimed_action, permission_denied_completion, ActionCompletion,
        ClaimedComputerAction,
    };
    use super::super::computer_use_helper_socket::HelperSocketExecutor;
    use super::super::computer_use_provider_queue::{run_provider_loop, ProviderRegistration};
    use super::{ComputerUseProviderStartCommand, MACOS_PROVIDER_ID, MACOS_PROVIDER_NAME};

    const PERMISSION_CACHE_TTL: Duration = Duration::from_secs(15);

    struct PermissionCache {
        checked_at: Option<Instant>,
        missing: Result<Vec<String>, String>,
    }

    pub fn run(app: AppHandle, input: ComputerUseProviderStartCommand, stop: Arc<AtomicBool>) {
        let helper = computer_use_helper_executable(&app);
        let registration = ProviderRegistration {
            id: MACOS_PROVIDER_ID,
            name: MACOS_PROVIDER_NAME,
            status: if helper.is_some() {
                "ready"
            } else {
                "degraded"
            },
            message: helper
                .is_none()
                .then(|| "Pebble Computer Use.app was not found".to_string()),
        };
        let mut executor = helper.map(HelperSocketExecutor::new);
        let mut permissions = PermissionCache {
            checked_at: None,
            missing: Ok(Vec::new()),
        };
        run_provider_loop(input, stop, registration, |action| {
            run_action(&app, &mut executor, &mut permissions, action)
        });
    }

    fn run_action(
        app: &AppHandle,
        executor: &mut Option<HelperSocketExecutor>,
        cache: &mut PermissionCache,
        action: &ClaimedComputerAction,
    ) -> ActionCompletion {
        let Some(executor) = executor.as_mut() else {
            return ActionCompletion::Failed {
                error_message: "accessibility_error: Pebble Computer Use.app was not found".into(),
            };
        };
        let fresh = cache
            .checked_at
            .is_some_and(|checked| checked.elapsed() < PERMISSION_CACHE_TTL);
        if !fresh {
            cache.missing = computer_use_missing_permissions(app);
            cache.checked_at = Some(Instant::now());
        }
        match &cache.missing {
            Ok(missing) if missing.is_empty() => execute_claimed_action(executor, action),
            Ok(missing) => permission_denied_completion(missing),
            Err(reason) => ActionCompletion::Failed {
                error_message: format!("permission_denied: could not verify permissions: {reason}"),
            },
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
mod desktop_worker {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    use tauri::AppHandle;

    use super::super::computer_use_action_translation::{execute_claimed_action, ActionCompletion};
    use super::super::computer_use_desktop_bridge::resolve_desktop_script;
    use super::super::computer_use_desktop_script::{
        DesktopScriptExecutor, DESKTOP_PROVIDER_ID, DESKTOP_PROVIDER_NAME,
    };
    use super::super::computer_use_provider_queue::{run_provider_loop, ProviderRegistration};
    use super::ComputerUseProviderStartCommand;

    pub fn run(app: AppHandle, input: ComputerUseProviderStartCommand, stop: Arc<AtomicBool>) {
        let script = resolve_desktop_script(&app);
        let registration = ProviderRegistration {
            id: DESKTOP_PROVIDER_ID,
            name: DESKTOP_PROVIDER_NAME,
            status: if script.is_some() {
                "ready"
            } else {
                "degraded"
            },
            message: script
                .is_none()
                .then(|| "desktop computer-use provider script was not found".to_string()),
        };
        let mut executor = script.map(DesktopScriptExecutor::new);
        run_provider_loop(input, stop, registration, |action| {
            executor.as_mut().map_or_else(
                || ActionCompletion::Failed {
                    error_message:
                        "accessibility_error: desktop computer-use provider script was not found"
                            .into(),
                },
                |executor| execute_claimed_action(executor, action),
            )
        });
    }
}
