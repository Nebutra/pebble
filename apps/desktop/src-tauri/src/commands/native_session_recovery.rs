use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sysinfo::{Pid, System};
use tauri::Manager;
use uuid::Uuid;

const SESSION_FILE: &str = "tauri-session.json";
const SESSION_MARKER_SCHEMA_VERSION: u32 = 2;

#[derive(Default)]
pub struct NativeSessionState {
    active: Mutex<Option<NativeSessionMarker>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSessionMarker {
    #[serde(default = "legacy_schema_version")]
    schema_version: u32,
    session_id: String,
    pid: u32,
    #[serde(default)]
    process_started_at_epoch_seconds: Option<u64>,
    #[serde(default)]
    executable_name: String,
    #[serde(default)]
    launch_kind: String,
    app_version: String,
    started_at: String,
    last_stage: String,
    #[serde(default)]
    stage_updated_at: String,
    #[serde(default)]
    native_quit_requested: bool,
    #[serde(default)]
    exit_requested: bool,
    #[serde(default)]
    exit_requested_at: Option<String>,
    clean: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProcessObservation {
    alive: bool,
    identity_matches: bool,
    observed_started_at_epoch_seconds: Option<u64>,
    observed_executable_name: Option<String>,
}

pub fn begin(app: &tauri::AppHandle) -> Result<(), String> {
    if session_recovery_disabled(
        cfg!(debug_assertions),
        std::env::var_os("PEBBLE_PARITY_CAPTURE_PATH").is_some(),
        std::env::var_os("PEBBLE_FUNCTIONAL_GATE_EVIDENCE_PATH").is_some(),
        std::env::var_os("PEBBLE_NATIVE_SESSION_RECOVERY_DISABLED").is_some(),
    ) {
        return Ok(());
    }
    let path = session_path(app)?;
    if let Some(previous) = read_marker(&path) {
        recover_previous_session(app, &previous)?;
    }
    let now = Utc::now().to_rfc3339();
    let marker = NativeSessionMarker {
        schema_version: SESSION_MARKER_SCHEMA_VERSION,
        session_id: Uuid::new_v4().to_string(),
        pid: std::process::id(),
        process_started_at_epoch_seconds: current_process_started_at_epoch_seconds(),
        executable_name: current_executable_name(),
        launch_kind: "desktop-release".to_string(),
        app_version: app.package_info().version.to_string(),
        started_at: now.clone(),
        last_stage: "setup-started".to_string(),
        stage_updated_at: now,
        native_quit_requested: false,
        exit_requested: false,
        exit_requested_at: None,
        clean: false,
    };
    write_marker(&path, &marker)?;
    let state = app.state::<NativeSessionState>();
    *state
        .active
        .lock()
        .map_err(|_| "native session state lock was poisoned".to_string())? = Some(marker);
    Ok(())
}

fn session_recovery_disabled(
    debug_build: bool,
    parity_capture: bool,
    functional_gate: bool,
    explicit_harness_disable: bool,
) -> bool {
    // Why: automated shells are terminated by their harness and must never
    // create markers that a later run can mistake for a production crash.
    debug_build || parity_capture || functional_gate || explicit_harness_disable
}

pub fn record_stage(app: &tauri::AppHandle, stage: &str) -> Result<(), String> {
    let state = app.state::<NativeSessionState>();
    let mut active = state
        .active
        .lock()
        .map_err(|_| "native session state lock was poisoned".to_string())?;
    let Some(marker) = active.as_mut() else {
        return Ok(());
    };
    marker.last_stage = stage.to_string();
    marker.stage_updated_at = Utc::now().to_rfc3339();
    write_marker(&session_path(app)?, marker)
}

pub fn append_active_session_diagnostics(app: &tauri::AppHandle, details: &mut Map<String, Value>) {
    let state = app.state::<NativeSessionState>();
    // Why: this runs from the panic hook; never wait on a lock that the
    // panicking thread may already hold while updating the session marker.
    let Ok(active) = state.active.try_lock() else {
        details.insert(
            "native_session_snapshot_unavailable".to_string(),
            Value::String("state-lock-busy".to_string()),
        );
        return;
    };
    let Some(marker) = active.as_ref() else {
        return;
    };
    append_marker_diagnostics(marker, details);
}

fn append_marker_diagnostics(marker: &NativeSessionMarker, details: &mut Map<String, Value>) {
    details.insert(
        "native_session_id".to_string(),
        Value::String(marker.session_id.clone()),
    );
    details.insert(
        "native_session_last_stage".to_string(),
        Value::String(marker.last_stage.clone()),
    );
    details.insert(
        "native_session_stage_updated_at".to_string(),
        Value::String(marker.stage_updated_at_value().to_string()),
    );
}

pub fn mark_clean(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<NativeSessionState>();
    let mut active = state
        .active
        .lock()
        .map_err(|_| "native session state lock was poisoned".to_string())?;
    let Some(marker) = active.as_mut() else {
        return Ok(());
    };
    marker.clean = true;
    marker.last_stage = "clean-exit".to_string();
    marker.stage_updated_at = Utc::now().to_rfc3339();
    write_marker(&session_path(app)?, marker)
}

pub fn mark_exit_requested(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<NativeSessionState>();
    let mut active = state
        .active
        .lock()
        .map_err(|_| "native session state lock was poisoned".to_string())?;
    let Some(marker) = active.as_mut() else {
        return Ok(());
    };
    // Why: a platform can tear down its event loop before RunEvent::Exit;
    // persist user/system intent so the next launch does not report a false crash.
    marker.exit_requested = true;
    marker.last_stage = "exit-requested".to_string();
    let now = Utc::now().to_rfc3339();
    marker.stage_updated_at = now.clone();
    marker.exit_requested_at = Some(now);
    write_marker(&session_path(app)?, marker)
}

pub fn mark_native_quit_requested(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<NativeSessionState>();
    let mut active = state
        .active
        .lock()
        .map_err(|_| "native session state lock was poisoned".to_string())?;
    let Some(marker) = active.as_mut() else {
        return Ok(());
    };
    marker.native_quit_requested = true;
    marker.last_stage = "native-quit-requested".to_string();
    marker.stage_updated_at = Utc::now().to_rfc3339();
    write_marker(&session_path(app)?, marker)
}

fn recover_previous_session(
    app: &tauri::AppHandle,
    previous: &NativeSessionMarker,
) -> Result<(), String> {
    let observation = observe_process(previous);
    if !should_recover_previous_session(previous, &observation) {
        return Ok(());
    }
    let details = recovery_details(previous, observation);
    super::crash_reports::record_native_process_failure(
        app,
        "tauri-host",
        "previous-native-abnormal-exit",
        None,
        details,
    )
}

fn recovery_details(
    previous: &NativeSessionMarker,
    observation: ProcessObservation,
) -> Map<String, Value> {
    let mut details = Map::new();
    details.insert(
        "recovery_evidence_kind".to_string(),
        Value::String("unclean-native-session-marker".to_string()),
    );
    details.insert(
        "recovery_detected_at".to_string(),
        Value::String(Utc::now().to_rfc3339()),
    );
    details.insert(
        "recovery_process_pid".to_string(),
        Value::from(std::process::id()),
    );
    details.insert(
        "recovery_executable_name".to_string(),
        Value::String(current_executable_name()),
    );
    details.insert(
        "recovery_observed_pid_alive".to_string(),
        Value::Bool(observation.alive),
    );
    details.insert(
        "recovery_observed_process_identity_matches".to_string(),
        Value::Bool(observation.identity_matches),
    );
    details.insert(
        "previous_session_marker_schema_version".to_string(),
        Value::from(previous.schema_version),
    );
    details.insert(
        "previous_session_id".to_string(),
        Value::String(previous.session_id.clone()),
    );
    details.insert(
        "previous_session_pid".to_string(),
        Value::from(previous.pid),
    );
    details.insert(
        "previous_session_started_at".to_string(),
        Value::String(previous.started_at.clone()),
    );
    details.insert(
        "previous_session_last_stage".to_string(),
        Value::String(previous.last_stage.clone()),
    );
    details.insert(
        "previous_session_stage_updated_at".to_string(),
        Value::String(previous.stage_updated_at_value().to_string()),
    );
    details.insert(
        "previous_session_app_version".to_string(),
        Value::String(previous.app_version.clone()),
    );
    details.insert(
        "previous_session_clean".to_string(),
        Value::Bool(previous.clean),
    );
    details.insert(
        "previous_session_native_quit_requested".to_string(),
        Value::Bool(previous.native_quit_requested),
    );
    details.insert(
        "previous_session_exit_requested".to_string(),
        Value::Bool(previous.exit_requested),
    );
    insert_optional_detail(
        &mut details,
        "previous_session_exit_requested_at",
        previous.exit_requested_at.as_deref(),
    );
    if let Some(value) = previous.process_started_at_epoch_seconds {
        details.insert(
            "previous_session_process_started_at_epoch_seconds".to_string(),
            Value::from(value),
        );
    }
    if let Some(value) = observation.observed_started_at_epoch_seconds {
        details.insert(
            "recovery_observed_process_started_at_epoch_seconds".to_string(),
            Value::from(value),
        );
    }
    insert_optional_detail(
        &mut details,
        "recovery_observed_executable_name",
        observation.observed_executable_name.as_deref(),
    );
    insert_optional_detail(
        &mut details,
        "previous_session_executable_name",
        Some(&previous.executable_name),
    );
    insert_optional_detail(
        &mut details,
        "previous_session_launch_kind",
        Some(&previous.launch_kind),
    );
    details
}

fn should_recover_previous_session(
    previous: &NativeSessionMarker,
    observation: &ProcessObservation,
) -> bool {
    !previous.clean && !previous.exit_requested && !observation.identity_matches
}

fn observe_process(marker: &NativeSessionMarker) -> ProcessObservation {
    let system = System::new_all();
    let process = system.process(Pid::from_u32(marker.pid));
    let observed_started_at_epoch_seconds = process.map(|value| value.start_time());
    let observed_executable_name = process.and_then(|value| {
        value
            .exe()
            .and_then(|path| path.file_name())
            .map(|value| value.to_string_lossy().into_owned())
    });
    let start_time_matches = match (
        marker.process_started_at_epoch_seconds,
        observed_started_at_epoch_seconds,
    ) {
        (Some(expected), Some(observed)) => expected == observed,
        (None, Some(_)) => true,
        _ => false,
    };
    let executable_matches = marker.executable_name.trim().is_empty()
        || observed_executable_name
            .as_ref()
            .is_none_or(|observed| observed == &marker.executable_name);
    ProcessObservation {
        alive: process.is_some(),
        identity_matches: start_time_matches && executable_matches,
        observed_started_at_epoch_seconds,
        observed_executable_name,
    }
}

fn current_process_started_at_epoch_seconds() -> Option<u64> {
    System::new_all()
        .process(Pid::from_u32(std::process::id()))
        .map(|process| process.start_time())
}

fn current_executable_name() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|value| value.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "unknown".to_string())
}

fn insert_optional_detail(details: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        details.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn legacy_schema_version() -> u32 {
    1
}

impl NativeSessionMarker {
    fn stage_updated_at_value(&self) -> &str {
        if self.stage_updated_at.trim().is_empty() {
            &self.started_at
        } else {
            &self.stage_updated_at
        }
    }
}

fn session_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(SESSION_FILE))
}

fn read_marker(path: &Path) -> Option<NativeSessionMarker> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn write_marker(path: &Path, marker: &NativeSessionMarker) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "native session path has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(marker).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_round_trips_with_the_last_native_stage() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join(SESSION_FILE);
        let marker = NativeSessionMarker {
            schema_version: SESSION_MARKER_SCHEMA_VERSION,
            session_id: "session-1".to_string(),
            pid: 42,
            process_started_at_epoch_seconds: Some(100),
            executable_name: "Pebble".to_string(),
            launch_kind: "desktop-release".to_string(),
            app_version: "0.1.0".to_string(),
            started_at: "2026-07-18T00:00:00Z".to_string(),
            last_stage: "window-configured".to_string(),
            stage_updated_at: "2026-07-18T00:00:01Z".to_string(),
            native_quit_requested: true,
            exit_requested: false,
            exit_requested_at: None,
            clean: false,
        };
        write_marker(&path, &marker).expect("write marker");
        let restored = read_marker(&path).expect("read marker");
        assert_eq!(restored.session_id, "session-1");
        assert_eq!(restored.last_stage, "window-configured");
        assert!(restored.native_quit_requested);
        assert!(!restored.clean);
    }

    #[test]
    fn panic_diagnostics_identify_the_active_native_startup_stage() {
        let marker = NativeSessionMarker {
            schema_version: SESSION_MARKER_SCHEMA_VERSION,
            session_id: "session-panic".to_string(),
            pid: 42,
            process_started_at_epoch_seconds: Some(100),
            executable_name: "Pebble".to_string(),
            launch_kind: "desktop-release".to_string(),
            app_version: "0.1.0".to_string(),
            started_at: "2026-07-19T00:00:00Z".to_string(),
            last_stage: "native-quit-hook-installing".to_string(),
            stage_updated_at: "2026-07-19T00:00:01Z".to_string(),
            native_quit_requested: false,
            exit_requested: false,
            exit_requested_at: None,
            clean: false,
        };
        let mut details = Map::new();
        append_marker_diagnostics(&marker, &mut details);
        assert_eq!(details["native_session_id"], "session-panic");
        assert_eq!(
            details["native_session_last_stage"],
            "native-quit-hook-installing"
        );
        assert_eq!(
            details["native_session_stage_updated_at"],
            "2026-07-19T00:00:01Z"
        );
    }

    #[test]
    fn expected_termination_is_not_reported_as_a_crash() {
        let mut marker = NativeSessionMarker {
            schema_version: SESSION_MARKER_SCHEMA_VERSION,
            session_id: "session-1".to_string(),
            pid: 42,
            process_started_at_epoch_seconds: Some(100),
            executable_name: "Pebble".to_string(),
            launch_kind: "desktop-release".to_string(),
            app_version: "0.1.0".to_string(),
            started_at: "2026-07-18T00:00:00Z".to_string(),
            last_stage: "ready".to_string(),
            stage_updated_at: "2026-07-18T00:00:01Z".to_string(),
            native_quit_requested: false,
            exit_requested: false,
            exit_requested_at: None,
            clean: false,
        };
        assert!(should_recover_previous_session(
            &marker,
            &ProcessObservation {
                alive: false,
                identity_matches: false,
                observed_started_at_epoch_seconds: None,
                observed_executable_name: None,
            }
        ));
        marker.exit_requested = true;
        assert!(!should_recover_previous_session(
            &marker,
            &ProcessObservation {
                alive: false,
                identity_matches: false,
                observed_started_at_epoch_seconds: None,
                observed_executable_name: None,
            }
        ));
    }

    #[test]
    fn legacy_marker_without_exit_intent_remains_recoverable() {
        let marker: NativeSessionMarker = serde_json::from_str(
            r#"{"sessionId":"session-1","pid":42,"appVersion":"0.1.0","startedAt":"2026-07-18T00:00:00Z","lastStage":"ready","clean":false}"#,
        )
        .expect("legacy marker");
        assert_eq!(marker.schema_version, 1);
        assert!(!marker.exit_requested);
        assert_eq!(marker.stage_updated_at_value(), marker.started_at);
        assert!(should_recover_previous_session(
            &marker,
            &ProcessObservation {
                alive: false,
                identity_matches: false,
                observed_started_at_epoch_seconds: None,
                observed_executable_name: None,
            }
        ));
    }

    #[test]
    fn current_process_is_detected_as_alive() {
        let marker = NativeSessionMarker {
            schema_version: SESSION_MARKER_SCHEMA_VERSION,
            session_id: "current".to_string(),
            pid: std::process::id(),
            process_started_at_epoch_seconds: current_process_started_at_epoch_seconds(),
            executable_name: current_executable_name(),
            launch_kind: "test".to_string(),
            app_version: "test".to_string(),
            started_at: Utc::now().to_rfc3339(),
            last_stage: "test".to_string(),
            stage_updated_at: Utc::now().to_rfc3339(),
            native_quit_requested: false,
            exit_requested: false,
            exit_requested_at: None,
            clean: false,
        };
        let observation = observe_process(&marker);
        assert!(observation.alive);
        assert!(observation.identity_matches);
    }

    #[test]
    fn functional_gate_does_not_participate_in_native_session_recovery() {
        assert!(session_recovery_disabled(false, false, true, false));
        assert!(session_recovery_disabled(true, false, false, false));
        assert!(session_recovery_disabled(false, false, false, true));
        assert!(!session_recovery_disabled(false, false, false, false));
    }

    #[test]
    fn reused_pid_is_recovered_but_matching_process_identity_is_not() {
        let marker: NativeSessionMarker = serde_json::from_str(
            r#"{"schemaVersion":2,"sessionId":"session-1","pid":42,"processStartedAtEpochSeconds":100,"appVersion":"0.1.0","startedAt":"2026-07-18T00:00:00Z","lastStage":"ready","clean":false}"#,
        )
        .expect("marker");
        assert!(should_recover_previous_session(
            &marker,
            &ProcessObservation {
                alive: true,
                identity_matches: false,
                observed_started_at_epoch_seconds: Some(200),
                observed_executable_name: Some("Pebble".to_string()),
            }
        ));
        assert!(!should_recover_previous_session(
            &marker,
            &ProcessObservation {
                alive: true,
                identity_matches: true,
                observed_started_at_epoch_seconds: Some(100),
                observed_executable_name: Some("Pebble".to_string()),
            }
        ));
    }

    #[test]
    fn recovery_details_explain_the_marker_only_diagnosis() {
        let marker: NativeSessionMarker = serde_json::from_str(
            r#"{"schemaVersion":2,"sessionId":"session-1","pid":42,"processStartedAtEpochSeconds":100,"executableName":"Pebble","launchKind":"desktop-release","appVersion":"0.1.0","startedAt":"2026-07-18T00:00:00Z","lastStage":"ready","stageUpdatedAt":"2026-07-18T00:00:01Z","clean":false}"#,
        )
        .expect("marker");
        let details = recovery_details(
            &marker,
            ProcessObservation {
                alive: false,
                identity_matches: false,
                observed_started_at_epoch_seconds: None,
                observed_executable_name: None,
            },
        );
        assert_eq!(
            details.get("recovery_evidence_kind"),
            Some(&Value::String("unclean-native-session-marker".into()))
        );
        assert_eq!(details.get("previous_session_pid"), Some(&Value::from(42)));
        assert_eq!(
            details.get("previous_session_stage_updated_at"),
            Some(&Value::String("2026-07-18T00:00:01Z".into()))
        );
        assert_eq!(
            details.get("recovery_observed_process_identity_matches"),
            Some(&Value::Bool(false))
        );
    }
}
