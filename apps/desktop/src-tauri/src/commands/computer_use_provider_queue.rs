use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use pebble_rust_host::{
    poll_native_actions, register_native_provider, update_native_action, NativeActionPollCommand,
    NativeActionUpdateCommand, NativeProviderRegistrationCommand, RuntimeResourceGetResult,
};

use super::computer_use_action_translation::{
    parse_claimed_actions, ActionCompletion, ClaimedComputerAction, COMPUTER_ACTION_KIND_PREFIX,
};
use super::computer_use_provider::ComputerUseProviderStartCommand;

const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(900);
const RUNTIME_ERROR_BACKOFF: Duration = Duration::from_secs(5);
const CLAIM_LIMIT: usize = 8;
const QUEUE_HTTP_TIMEOUT_MS: u64 = 10_000;
const UPDATE_HTTP_TIMEOUT_MS: u64 = 30_000;

pub struct ProviderRegistration {
    pub id: &'static str,
    pub name: &'static str,
    pub status: &'static str,
    pub message: Option<String>,
}

trait ProviderQueueRuntime {
    fn register(&mut self, command: NativeProviderRegistrationCommand) -> RuntimeResourceGetResult;
    fn poll(&mut self, command: NativeActionPollCommand) -> RuntimeResourceGetResult;
    fn update(&mut self, command: NativeActionUpdateCommand) -> RuntimeResourceGetResult;
}

struct NativeProviderQueueRuntime;

impl ProviderQueueRuntime for NativeProviderQueueRuntime {
    fn register(&mut self, command: NativeProviderRegistrationCommand) -> RuntimeResourceGetResult {
        register_native_provider(command)
    }

    fn poll(&mut self, command: NativeActionPollCommand) -> RuntimeResourceGetResult {
        poll_native_actions(command)
    }

    fn update(&mut self, command: NativeActionUpdateCommand) -> RuntimeResourceGetResult {
        update_native_action(command)
    }
}

pub fn run_provider_loop(
    input: ComputerUseProviderStartCommand,
    stop: Arc<AtomicBool>,
    registration: ProviderRegistration,
    mut run_action: impl FnMut(&ClaimedComputerAction) -> ActionCompletion,
) {
    run_provider_loop_with_runtime(
        input,
        stop,
        registration,
        &mut NativeProviderQueueRuntime,
        &mut run_action,
        sleep_unless_stopped,
    );
}

fn run_provider_loop_with_runtime(
    input: ComputerUseProviderStartCommand,
    stop: Arc<AtomicBool>,
    registration: ProviderRegistration,
    runtime: &mut impl ProviderQueueRuntime,
    run_action: &mut impl FnMut(&ClaimedComputerAction) -> ActionCompletion,
    mut wait: impl FnMut(&Arc<AtomicBool>, Duration),
) {
    let runtime_url = input.runtime_url;
    let bearer_token = input.bearer_token;
    let mut registered = false;
    while !stop.load(Ordering::SeqCst) {
        if !registered {
            registered = register_provider(runtime, &runtime_url, &bearer_token, &registration);
            if !registered {
                wait(&stop, RUNTIME_ERROR_BACKOFF);
                continue;
            }
        }
        let claim = runtime.poll(NativeActionPollCommand {
            runtime_url: runtime_url.clone(),
            bearer_token: bearer_token.clone(),
            timeout_ms: QUEUE_HTTP_TIMEOUT_MS,
            kind_prefix: Some(COMPUTER_ACTION_KIND_PREFIX.to_string()),
            limit: CLAIM_LIMIT,
            targets: Vec::new(),
        });
        if claim.error.is_some() || !claim.http_status.is_some_and(|status| status < 300) {
            registered = false;
            wait(&stop, RUNTIME_ERROR_BACKOFF);
            continue;
        }
        let actions = match parse_claimed_actions(claim.body.as_deref().unwrap_or("null")) {
            Ok(actions) => actions,
            Err(_) => {
                wait(&stop, RUNTIME_ERROR_BACKOFF);
                continue;
            }
        };
        if actions.is_empty() {
            wait(&stop, IDLE_POLL_INTERVAL);
            continue;
        }
        for action in &actions {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            if !post_completion(
                runtime,
                &runtime_url,
                &bearer_token,
                &action.id,
                run_action(action),
            ) {
                // A failed completion can mean the runtime restarted and the
                // provider lease vanished. Re-register before claiming again.
                registered = false;
                break;
            }
        }
    }
}

fn register_provider(
    runtime: &mut impl ProviderQueueRuntime,
    runtime_url: &str,
    bearer_token: &Option<String>,
    registration: &ProviderRegistration,
) -> bool {
    let result = runtime.register(NativeProviderRegistrationCommand {
        runtime_url: runtime_url.to_string(),
        bearer_token: bearer_token.clone(),
        timeout_ms: QUEUE_HTTP_TIMEOUT_MS,
        id: Some(registration.id.to_string()),
        subsystem: "computer".to_string(),
        name: registration.name.to_string(),
        status: Some(registration.status.to_string()),
        capabilities: vec![
            "capabilities".into(),
            "listApps".into(),
            "listWindows".into(),
            "getAppState".into(),
            "click".into(),
            "performSecondaryAction".into(),
            "scroll".into(),
            "drag".into(),
            "typeText".into(),
            "pressKey".into(),
            "hotkey".into(),
            "pasteText".into(),
            "setValue".into(),
        ],
        message: registration.message.clone(),
    });
    result.error.is_none() && result.http_status.is_some_and(|status| status < 300)
}

fn post_completion(
    runtime: &mut impl ProviderQueueRuntime,
    runtime_url: &str,
    bearer_token: &Option<String>,
    action_id: &str,
    completion: ActionCompletion,
) -> bool {
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
    let result = runtime.update(NativeActionUpdateCommand {
        runtime_url: runtime_url.to_string(),
        bearer_token: bearer_token.clone(),
        timeout_ms: UPDATE_HTTP_TIMEOUT_MS,
        action_id: action_id.to_string(),
        status,
        result_json,
        error_message,
    });
    if let Some(error) = result.error {
        eprintln!("computer-use provider: failed to post completion for {action_id}: {error}");
        return false;
    }
    result.http_status.is_some_and(|status| status < 300)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    use pebble_rust_host::{
        NativeActionPollCommand, NativeActionUpdateCommand, NativeProviderRegistrationCommand,
        RuntimeResourceGetResult, RuntimeTransportState,
    };

    use super::{
        run_provider_loop_with_runtime, ActionCompletion, ComputerUseProviderStartCommand,
        ProviderQueueRuntime, ProviderRegistration,
    };

    #[derive(Default)]
    struct ScriptedRuntime {
        registrations: usize,
        polls: VecDeque<RuntimeResourceGetResult>,
        updates: VecDeque<RuntimeResourceGetResult>,
        updated_ids: Vec<String>,
    }

    impl ProviderQueueRuntime for ScriptedRuntime {
        fn register(
            &mut self,
            _command: NativeProviderRegistrationCommand,
        ) -> RuntimeResourceGetResult {
            self.registrations += 1;
            ok(None)
        }

        fn poll(&mut self, _command: NativeActionPollCommand) -> RuntimeResourceGetResult {
            self.polls.pop_front().unwrap_or_else(|| ok(Some("null")))
        }

        fn update(&mut self, command: NativeActionUpdateCommand) -> RuntimeResourceGetResult {
            self.updated_ids.push(command.action_id);
            self.updates.pop_front().unwrap_or_else(|| ok(None))
        }
    }

    fn ok(body: Option<&str>) -> RuntimeResourceGetResult {
        RuntimeResourceGetResult {
            runtime_url: "http://runtime.test".to_string(),
            request_path: "/v1/computer/actions".to_string(),
            transport: RuntimeTransportState::Connected,
            http_status: Some(200),
            body: body.map(str::to_string),
            error: None,
        }
    }

    fn failed_status() -> RuntimeResourceGetResult {
        RuntimeResourceGetResult {
            runtime_url: "http://runtime.test".to_string(),
            request_path: "/v1/computer/actions".to_string(),
            transport: RuntimeTransportState::HttpError,
            http_status: Some(503),
            body: None,
            error: None,
        }
    }

    fn input() -> ComputerUseProviderStartCommand {
        ComputerUseProviderStartCommand {
            runtime_url: "http://runtime.test".to_string(),
            bearer_token: Some("token".to_string()),
        }
    }

    fn registration() -> ProviderRegistration {
        ProviderRegistration {
            id: "computer:test",
            name: "test",
            status: "ready",
            message: None,
        }
    }

    #[test]
    fn executes_and_completes_claimed_actions_serially() {
        let stop = Arc::new(AtomicBool::new(false));
        let mut runtime = ScriptedRuntime {
            polls: VecDeque::from([ok(Some(
                r#"[{"id":"first","kind":"computer.click"},{"id":"second","kind":"computer.scroll"}]"#,
            ))]),
            ..Default::default()
        };
        let mut executed = Vec::new();
        let stop_after_batch = stop.clone();

        run_provider_loop_with_runtime(
            input(),
            stop,
            registration(),
            &mut runtime,
            &mut |action| {
                executed.push(action.id.clone());
                if action.id == "second" {
                    stop_after_batch.store(true, Ordering::SeqCst);
                }
                ActionCompletion::Completed {
                    result_json: "{}".to_string(),
                }
            },
            |_, _| {},
        );

        assert_eq!(executed, ["first", "second"]);
        assert_eq!(runtime.updated_ids, ["first", "second"]);
        assert_eq!(runtime.registrations, 1);
    }

    #[test]
    fn stop_interrupts_the_remaining_claimed_batch() {
        let stop = Arc::new(AtomicBool::new(false));
        let mut runtime = ScriptedRuntime {
            polls: VecDeque::from([ok(Some(
                r#"[{"id":"first","kind":"computer.click"},{"id":"second","kind":"computer.scroll"}]"#,
            ))]),
            ..Default::default()
        };
        let mut executed = Vec::new();
        let stop_during_first = stop.clone();

        run_provider_loop_with_runtime(
            input(),
            stop,
            registration(),
            &mut runtime,
            &mut |action| {
                executed.push(action.id.clone());
                stop_during_first.store(true, Ordering::SeqCst);
                ActionCompletion::Completed {
                    result_json: "{}".to_string(),
                }
            },
            |_, _| {},
        );

        assert_eq!(executed, ["first"]);
        assert_eq!(runtime.updated_ids, ["first"]);
    }

    #[test]
    fn poll_and_completion_failures_require_registration_again() {
        let stop = Arc::new(AtomicBool::new(false));
        let mut runtime = ScriptedRuntime {
            polls: VecDeque::from([
                failed_status(),
                ok(Some(r#"[{"id":"action","kind":"computer.click"}]"#)),
                ok(Some("null")),
            ]),
            updates: VecDeque::from([failed_status()]),
            ..Default::default()
        };
        let stop_after_reregistration = stop.clone();
        let waits = AtomicUsize::new(0);

        run_provider_loop_with_runtime(
            input(),
            stop,
            registration(),
            &mut runtime,
            &mut |_| ActionCompletion::Completed {
                result_json: "{}".to_string(),
            },
            move |_, _| {
                if waits.fetch_add(1, Ordering::SeqCst) == 1 {
                    stop_after_reregistration.store(true, Ordering::SeqCst);
                }
            },
        );

        assert_eq!(runtime.registrations, 3);
        assert_eq!(runtime.updated_ids, ["action"]);
    }
}

fn sleep_unless_stopped(stop: &Arc<AtomicBool>, duration: Duration) {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(100));
    }
}
