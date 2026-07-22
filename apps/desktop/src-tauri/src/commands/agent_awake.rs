use serde::Deserialize;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const AGENT_AWAKE_STATUS_STALE_AFTER_MS: i64 = 2 * 60 * 60 * 1000;
const MAX_AGENT_AWAKE_STATUSES: usize = 512;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAwakeSyncInput {
    enabled: bool,
    statuses: Vec<AgentAwakeStatus>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentAwakeStatus {
    state: String,
    received_at: i64,
    observed_in_current_runtime: bool,
}

#[derive(Clone, Debug, Default)]
struct WorkerInput {
    generation: u64,
    shutdown: bool,
    desired: AgentAwakeSyncInput,
}

pub struct AgentAwakeState {
    shared: Arc<(Mutex<WorkerInput>, Condvar)>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Default for AgentAwakeState {
    fn default() -> Self {
        let shared = Arc::new((Mutex::new(WorkerInput::default()), Condvar::new()));
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("pebble-agent-awake".to_string())
            .spawn(move || run_worker(worker_shared))
            .expect("failed to start agent awake worker");
        Self {
            shared,
            worker: Mutex::new(Some(worker)),
        }
    }
}

impl AgentAwakeState {
    fn sync(&self, input: AgentAwakeSyncInput) -> Result<(), String> {
        if input.statuses.len() > MAX_AGENT_AWAKE_STATUSES {
            return Err("agent awake status input exceeds the entry limit".to_string());
        }
        let (lock, wake) = &*self.shared;
        let mut state = lock
            .lock()
            .map_err(|_| "agent awake state lock is poisoned".to_string())?;
        state.generation = state.generation.wrapping_add(1);
        state.desired = input;
        wake.notify_one();
        Ok(())
    }

    pub fn shutdown(&self) {
        let (lock, wake) = &*self.shared;
        if let Ok(mut state) = lock.lock() {
            state.shutdown = true;
            state.generation = state.generation.wrapping_add(1);
            wake.notify_one();
        }
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(handle) = worker.take() {
                let _ = handle.join();
            }
        }
    }
}

impl Drop for AgentAwakeState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[tauri::command]
pub fn agent_awake_sync(
    state: tauri::State<'_, AgentAwakeState>,
    input: AgentAwakeSyncInput,
) -> Result<(), String> {
    state.sync(input)
}

fn run_worker(shared: Arc<(Mutex<WorkerInput>, Condvar)>) {
    let mut controller = AgentAwakeController::new(NativeAwakeBackend::default());
    loop {
        let (generation, desired) = {
            let (lock, _) = &*shared;
            let state = match lock.lock() {
                Ok(state) => state,
                Err(_) => break,
            };
            if state.shutdown {
                break;
            }
            (state.generation, state.desired.clone())
        };

        let now = epoch_millis();
        let decision = evaluate_awake_policy(&desired, now);
        controller.set_active(decision.should_inhibit);

        let (lock, wake) = &*shared;
        let state = match lock.lock() {
            Ok(state) => state,
            Err(_) => break,
        };
        if state.shutdown {
            break;
        }
        if state.generation != generation {
            continue;
        }
        if let Some(wait_ms) = decision.next_reconcile_after_ms {
            let _ = wake.wait_timeout(state, Duration::from_millis(wait_ms));
        } else {
            drop(wake.wait(state));
        }
    }
    controller.set_active(false);
}

#[derive(Debug, PartialEq, Eq)]
struct AwakeDecision {
    should_inhibit: bool,
    next_reconcile_after_ms: Option<u64>,
}

fn evaluate_awake_policy(input: &AgentAwakeSyncInput, now: i64) -> AwakeDecision {
    if !input.enabled {
        return AwakeDecision {
            should_inhibit: false,
            next_reconcile_after_ms: None,
        };
    }
    let mut earliest_expiry = None;
    let mut should_inhibit = false;
    for status in &input.statuses {
        if !status.observed_in_current_runtime || status.state != "working" {
            continue;
        }
        let expiry = status
            .received_at
            .saturating_add(AGENT_AWAKE_STATUS_STALE_AFTER_MS);
        if now <= expiry {
            should_inhibit = true;
            earliest_expiry =
                Some(earliest_expiry.map_or(expiry, |current: i64| current.min(expiry)));
        }
    }
    AwakeDecision {
        should_inhibit,
        // The boundary itself remains fresh; reconcile one millisecond after it.
        next_reconcile_after_ms: earliest_expiry.map(|expiry| {
            expiry
                .saturating_sub(now)
                .saturating_add(1)
                .try_into()
                .unwrap_or(u64::MAX)
        }),
    }
}

trait AwakeBackend {
    fn start(&mut self) -> Result<(), String>;
    fn stop(&mut self);
}

struct AgentAwakeController<B: AwakeBackend> {
    backend: B,
    active: bool,
}

impl<B: AwakeBackend> AgentAwakeController<B> {
    fn new(backend: B) -> Self {
        Self {
            backend,
            active: false,
        }
    }

    fn set_active(&mut self, active: bool) {
        if active == self.active {
            return;
        }
        if active {
            match self.backend.start() {
                Ok(()) => self.active = true,
                Err(error) => eprintln!("[agent-awake] failed to start native assertion: {error}"),
            }
        } else {
            self.backend.stop();
            self.active = false;
        }
    }
}

#[derive(Default)]
struct NativeAwakeBackend {
    child: Option<Child>,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl AwakeBackend for NativeAwakeBackend {
    fn start(&mut self) -> Result<(), String> {
        if self.child.is_some() {
            return Ok(());
        }
        let (program, args) = native_assertion_command();
        let child = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("failed to spawn {program}: {error}"))?;
        self.child = Some(child);
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(target_os = "macos")]
fn native_assertion_command() -> (&'static str, &'static [&'static str]) {
    ("/usr/bin/caffeinate", &["-d", "-i", "-s"])
}

#[cfg(target_os = "linux")]
fn native_assertion_command() -> (&'static str, &'static [&'static str]) {
    (
        "systemd-inhibit",
        &[
            "--what=idle:sleep:handle-lid-switch",
            "--who=Pebble",
            "--why=Agents are working",
            "--mode=block",
            "sleep",
            "infinity",
        ],
    )
}

#[cfg(target_os = "windows")]
impl AwakeBackend for NativeAwakeBackend {
    fn start(&mut self) -> Result<(), String> {
        use windows::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
        };
        let result = unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED)
        };
        if result.0 == 0 {
            return Err("SetThreadExecutionState returned zero".to_string());
        }
        Ok(())
    }

    fn stop(&mut self) {
        use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
        let _ = unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
impl AwakeBackend for NativeAwakeBackend {
    fn start(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn stop(&mut self) {}
}

fn epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn working(received_at: i64) -> AgentAwakeStatus {
        AgentAwakeStatus {
            state: "working".to_string(),
            received_at,
            observed_in_current_runtime: true,
        }
    }

    #[test]
    fn fresh_current_runtime_work_activates_until_the_two_hour_boundary() {
        let input = AgentAwakeSyncInput {
            enabled: true,
            statuses: vec![working(1_000)],
        };
        let at_boundary = evaluate_awake_policy(&input, 1_000 + AGENT_AWAKE_STATUS_STALE_AFTER_MS);
        assert!(at_boundary.should_inhibit);
        assert_eq!(at_boundary.next_reconcile_after_ms, Some(1));
        assert!(
            !evaluate_awake_policy(&input, 1_001 + AGENT_AWAKE_STATUS_STALE_AFTER_MS)
                .should_inhibit
        );
    }

    #[test]
    fn disabled_non_working_and_replayed_statuses_do_not_activate() {
        let mut replayed = working(1_000);
        replayed.observed_in_current_runtime = false;
        let mut done = working(1_000);
        done.state = "done".to_string();
        assert!(
            !evaluate_awake_policy(
                &AgentAwakeSyncInput {
                    enabled: true,
                    statuses: vec![replayed, done],
                },
                1_000,
            )
            .should_inhibit
        );
        assert!(
            !evaluate_awake_policy(
                &AgentAwakeSyncInput {
                    enabled: false,
                    statuses: vec![working(1_000)],
                },
                1_000,
            )
            .should_inhibit
        );
    }

    #[derive(Default)]
    struct CountingBackend {
        starts: usize,
        stops: usize,
    }

    impl AwakeBackend for CountingBackend {
        fn start(&mut self) -> Result<(), String> {
            self.starts += 1;
            Ok(())
        }

        fn stop(&mut self) {
            self.stops += 1;
        }
    }

    #[test]
    fn controller_start_and_stop_are_idempotent() {
        let mut controller = AgentAwakeController::new(CountingBackend::default());
        controller.set_active(true);
        controller.set_active(true);
        controller.set_active(false);
        controller.set_active(false);
        assert_eq!(controller.backend.starts, 1);
        assert_eq!(controller.backend.stops, 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_uses_process_scoped_display_and_system_assertions() {
        assert_eq!(
            native_assertion_command(),
            ("/usr/bin/caffeinate", &["-d", "-i", "-s"][..])
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_uses_logind_inhibition_without_power_plan_mutation() {
        let (program, args) = native_assertion_command();
        assert_eq!(program, "systemd-inhibit");
        assert!(args.contains(&"--what=idle:sleep:handle-lid-switch"));
        assert!(!args
            .iter()
            .any(|arg| arg.contains("powercfg") || arg.contains("pmset")));
    }
}
