#[cfg(target_os = "macos")]
use std::sync::{Mutex, TryLockError};
#[cfg(any(target_os = "macos", test))]
use std::{
    collections::{HashMap, VecDeque},
    time::{Duration, Instant},
};

#[cfg(any(target_os = "macos", test))]
use serde_json::{Map, Value};
#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(target_os = "macos")]
use super::crash_reports;

#[cfg(any(target_os = "macos", test))]
const RECOVERY_WINDOW: Duration = Duration::from_secs(60);
#[cfg(any(target_os = "macos", test))]
const MAX_RECOVERY_ATTEMPTS: usize = 2;

#[derive(Default)]
pub struct WebContentProcessRecoveryState {
    #[cfg(target_os = "macos")]
    budget: Mutex<RecoveryBudget>,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
struct RecoveryBudget {
    attempts_by_webview: HashMap<String, VecDeque<Instant>>,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecoveryDecision {
    Reload,
    ReloadWithoutThrottle,
    RateLimited,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq, Eq)]
enum RecoveryOutcome {
    ReloadDispatched {
        throttle_guard: &'static str,
    },
    ReloadDispatchFailed {
        error: String,
        throttle_guard: &'static str,
    },
    RateLimited,
}

#[cfg(any(target_os = "macos", test))]
impl RecoveryBudget {
    fn reserve(&mut self, label: &str, now: Instant) -> RecoveryDecision {
        // Why: a persistent WebKit/page failure must not turn native recovery
        // into an unbounded reload loop or retain dead browser-tab labels.
        self.attempts_by_webview.retain(|_, attempts| {
            attempts.retain(|attempt| now.saturating_duration_since(*attempt) < RECOVERY_WINDOW);
            !attempts.is_empty()
        });

        let attempts = self
            .attempts_by_webview
            .entry(label.to_string())
            .or_default();
        if attempts.len() >= MAX_RECOVERY_ATTEMPTS {
            return RecoveryDecision::RateLimited;
        }
        attempts.push_back(now);
        RecoveryDecision::Reload
    }
}

#[cfg(any(target_os = "macos", test))]
impl RecoveryOutcome {
    fn crash_report_details(self) -> Map<String, Value> {
        let (result, attempted, throttle_guard, error) = match self {
            Self::ReloadDispatched { throttle_guard } => {
                ("reload-dispatched", true, throttle_guard, None)
            }
            Self::ReloadDispatchFailed {
                error,
                throttle_guard,
            } => ("reload-dispatch-failed", true, throttle_guard, Some(error)),
            Self::RateLimited => ("rate-limited", false, "exhausted", None),
        };
        let mut details = Map::new();
        details.insert(
            "web_content_recovery_action".to_string(),
            Value::String("reload-current-page".to_string()),
        );
        details.insert(
            "web_content_recovery_attempted".to_string(),
            Value::Bool(attempted),
        );
        details.insert(
            "web_content_recovery_result".to_string(),
            Value::String(result.to_string()),
        );
        details.insert(
            "web_content_recovery_throttle_guard".to_string(),
            Value::String(throttle_guard.to_string()),
        );
        if let Some(error) = error {
            details.insert(
                "web_content_recovery_error".to_string(),
                Value::String(error),
            );
        }
        details
    }
}

#[cfg(any(target_os = "macos", test))]
fn attempt_recovery(
    decision: RecoveryDecision,
    reload: impl FnOnce() -> Result<(), String>,
) -> RecoveryOutcome {
    let throttle_guard = match decision {
        RecoveryDecision::Reload => "reserved",
        RecoveryDecision::ReloadWithoutThrottle => "unavailable",
        RecoveryDecision::RateLimited => return RecoveryOutcome::RateLimited,
    };
    match reload() {
        Ok(()) => RecoveryOutcome::ReloadDispatched { throttle_guard },
        Err(error) => RecoveryOutcome::ReloadDispatchFailed {
            error,
            throttle_guard,
        },
    }
}

#[cfg(target_os = "macos")]
pub fn recover_after_termination(webview: &tauri::Webview) {
    let state = webview.state::<WebContentProcessRecoveryState>();
    let decision = match state.budget.try_lock() {
        Ok(mut budget) => budget.reserve(webview.label(), Instant::now()),
        // Why: a dead content process leaves no usable UI, so recovery must
        // proceed even if the crash-loop guard is temporarily unavailable.
        Err(TryLockError::WouldBlock | TryLockError::Poisoned(_)) => {
            RecoveryDecision::ReloadWithoutThrottle
        }
    };
    let outcome = attempt_recovery(decision, || {
        webview
            .reload()
            .map_err(|error| format!("Could not reload terminated WebView: {error}"))
    });
    crash_reports::record_web_content_process_termination(webview, outcome.crash_report_details());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_repeated_recovery_for_each_webview() {
        let mut budget = RecoveryBudget::default();
        let now = Instant::now();

        assert_eq!(budget.reserve("main", now), RecoveryDecision::Reload);
        assert_eq!(budget.reserve("main", now), RecoveryDecision::Reload);
        assert_eq!(budget.reserve("main", now), RecoveryDecision::RateLimited);
        assert_eq!(
            budget.reserve("browser-tab-1", now),
            RecoveryDecision::Reload
        );
    }

    #[test]
    fn restores_recovery_budget_after_the_window_expires() {
        let mut budget = RecoveryBudget::default();
        let now = Instant::now();
        assert_eq!(budget.reserve("main", now), RecoveryDecision::Reload);
        assert_eq!(budget.reserve("main", now), RecoveryDecision::Reload);

        assert_eq!(
            budget.reserve("main", now + RECOVERY_WINDOW),
            RecoveryDecision::Reload
        );
    }

    #[test]
    fn rate_limited_recovery_does_not_reload() {
        let outcome = attempt_recovery(RecoveryDecision::RateLimited, || {
            panic!("rate-limited recovery must not dispatch a reload")
        });

        assert_eq!(outcome, RecoveryOutcome::RateLimited);
        let details = outcome.crash_report_details();
        assert_eq!(details["web_content_recovery_attempted"], false);
        assert_eq!(details["web_content_recovery_result"], "rate-limited");
    }

    #[test]
    fn dispatches_reload_when_the_throttle_guard_is_unavailable() {
        let reload_called = std::cell::Cell::new(false);
        let outcome = attempt_recovery(RecoveryDecision::ReloadWithoutThrottle, || {
            reload_called.set(true);
            Ok(())
        });

        assert!(reload_called.get());
        let details = outcome.crash_report_details();
        assert_eq!(details["web_content_recovery_result"], "reload-dispatched");
        assert_eq!(
            details["web_content_recovery_throttle_guard"],
            "unavailable"
        );
    }

    #[test]
    fn records_reload_dispatch_failures() {
        let outcome = attempt_recovery(RecoveryDecision::Reload, || {
            Err("dispatcher unavailable".to_string())
        });

        let details = outcome.crash_report_details();
        assert_eq!(
            details["web_content_recovery_result"],
            "reload-dispatch-failed"
        );
        assert_eq!(
            details["web_content_recovery_error"],
            "dispatcher unavailable"
        );
    }
}
