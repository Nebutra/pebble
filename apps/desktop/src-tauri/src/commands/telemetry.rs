use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;
use uuid::Uuid;

const POSTHOG_HOST: &str = "https://us.i.posthog.com/capture/";
const TRANSPORT_TIMEOUT: Duration = Duration::from_secs(10);
const CONSENT_MUTATION_CEILING: usize = 5;
const EVENTS: &[&str] = &[
    "app_opened",
    "repo_added",
    "add_repo_setup_step_action",
    "add_repo_existing_workspaces_detected",
    "add_repo_default_checkout_handoff",
    "add_repo_nested_scan_result",
    "add_repo_nested_import_action",
    "add_repo_nested_import_result",
    "workspace_created",
    "workspace_create_failed",
    "setup_script_prompt_shown",
    "setup_script_prompt_action",
    "agent_started",
    "agent_prompt_sent",
    "agent_error",
    "agent_hook_install_failed",
    "agent_hook_unattributed",
    "settings_changed",
    "native_chat_toggled",
    "native_chat_message_sent",
    "pebble_cli_feature_tip_shown",
    "pebble_cli_feature_tip_setup_clicked",
    "pebble_cli_feature_tip_setup_result",
    "cmd_j_palette_feature_tip_shown",
    "cmd_j_palette_feature_tip_acknowledged",
    "feature_wall_opened",
    "feature_wall_closed",
    "feature_wall_tile_focused",
    "feature_wall_tile_clicked",
    "feature_wall_group_selected",
    "feature_wall_feature_selected",
    "feature_wall_docs_clicked",
    "onboarding_started",
    "onboarding_step_viewed",
    "onboarding_step_completed",
    "onboarding_step_skipped",
    "onboarding_tour_outcome",
    "onboarding_step4_path_clicked",
    "onboarding_step4_path_failed",
    "onboarding_task_sources_snapshot",
    "onboarding_windows_terminal_snapshot",
    "onboarding_completed",
    "onboarding_dismissed",
    "onboarding_agent_picked",
    "onboarding_ghostty_discovered",
    "onboarding_ghostty_import_clicked",
    "onboarding_ghostty_import_failed",
    "onboarding_feature_setup_toggled",
    "onboarding_feature_setup_run",
    "onboarding_feature_setup_terminal_opened",
    "onboarding_feature_setup_terminal_interacted",
    "activation_checklist_item_completed",
    "contextual_tour_shown",
    "contextual_tour_outcome",
    "setup_guide_opened",
    "setup_guide_closed",
    "setup_guide_step_completed",
    "terminal_pane_split",
    "smart_sort_class_distribution",
    "smart_sort_class_1_promotion",
    "smart_to_recent_switch",
];
static CONSENT_MUTATIONS: AtomicUsize = AtomicUsize::new(0);
static EVENT_BUDGET: OnceLock<Mutex<EventBudget>> = OnceLock::new();

struct EventBucket {
    tokens: f64,
    capacity: f64,
    last_refill: Instant,
}

#[derive(Default)]
struct EventBudget {
    buckets: std::collections::HashMap<String, EventBucket>,
    session_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TelemetryState {
    opted_in: Option<bool>,
    install_id: String,
    existed_before_telemetry_release: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "effective", rename_all = "snake_case")]
pub enum ConsentState {
    Enabled,
    Disabled { reason: DisabledReason },
    PendingBanner,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DisabledReason {
    DoNotTrack,
    PebbleDisabled,
    Ci,
    UserOptOut,
}

#[tauri::command]
pub async fn telemetry_track(
    app: tauri::AppHandle,
    name: String,
    props: Value,
) -> Result<(), String> {
    validate_renderer_event(&name, &props)?;
    let state = load_or_create_state(&app)?;
    if resolve_consent(&state).effective_enabled() {
        capture(&app, &state, &name, props).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn telemetry_set_opt_in(app: tauri::AppHandle, opted_in: bool) -> Result<(), String> {
    consume_mutation_token()?;
    let mut state = load_or_create_state(&app)?;
    let pending_banner = state.existed_before_telemetry_release && state.opted_in.is_none();
    let via = if pending_banner && !opted_in {
        "first_launch_banner"
    } else {
        "settings"
    };
    state.opted_in = Some(opted_in);
    persist_state(&app, &state)?;

    if opted_in {
        if pending_banner {
            capture(&app, &state, "app_opened", json!({ "nth_repo_added": 0 })).await?;
        }
        capture(&app, &state, "telemetry_opted_in", json!({ "via": via })).await?;
    } else {
        // Why: the explicit opt-out signal is the sole capture allowed against
        // the newly-disabled preference, matching Electron's consent transition.
        capture(&app, &state, "telemetry_opted_out", json!({ "via": via })).await?;
    }
    Ok(())
}

#[tauri::command]
pub fn telemetry_get_consent_state(app: tauri::AppHandle) -> Result<ConsentState, String> {
    Ok(resolve_consent(&load_or_create_state(&app)?))
}

#[tauri::command]
pub async fn telemetry_acknowledge_banner(app: tauri::AppHandle) -> Result<(), String> {
    let mut state = load_or_create_state(&app)?;
    if !state.existed_before_telemetry_release || state.opted_in.is_some() {
        return Err("telemetry banner is not pending".into());
    }
    consume_mutation_token()?;
    state.opted_in = Some(true);
    persist_state(&app, &state)?;
    capture(&app, &state, "app_opened", json!({ "nth_repo_added": 0 })).await
}

impl ConsentState {
    fn effective_enabled(&self) -> bool {
        matches!(self, Self::Enabled)
    }
}

fn resolve_consent(state: &TelemetryState) -> ConsentState {
    if env_truthy("DO_NOT_TRACK") {
        return ConsentState::Disabled {
            reason: DisabledReason::DoNotTrack,
        };
    }
    if env_truthy("PEBBLE_TELEMETRY_DISABLED") {
        return ConsentState::Disabled {
            reason: DisabledReason::PebbleDisabled,
        };
    }
    const CI_VARS: &[&str] = &[
        "CI",
        "GITHUB_ACTIONS",
        "GITLAB_CI",
        "CIRCLECI",
        "TRAVIS",
        "BUILDKITE",
        "JENKINS_URL",
        "TEAMCITY_VERSION",
    ];
    if CI_VARS
        .iter()
        .any(|name| std::env::var(name).is_ok_and(|value| !value.is_empty()))
    {
        return ConsentState::Disabled {
            reason: DisabledReason::Ci,
        };
    }
    match state.opted_in {
        Some(true) => ConsentState::Enabled,
        Some(false) => ConsentState::Disabled {
            reason: DisabledReason::UserOptOut,
        },
        None => ConsentState::PendingBanner,
    }
}

fn env_truthy(name: &str) -> bool {
    std::env::var(name)
        .is_ok_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true"))
}

fn consume_mutation_token() -> Result<(), String> {
    let previous = CONSENT_MUTATIONS.fetch_add(1, Ordering::Relaxed);
    if previous >= CONSENT_MUTATION_CEILING {
        CONSENT_MUTATIONS.fetch_sub(1, Ordering::Relaxed);
        return Err("telemetry consent mutation rate limit reached".into());
    }
    Ok(())
}

fn validate_renderer_event(name: &str, props: &Value) -> Result<(), String> {
    if !EVENTS.contains(&name) || !props.is_object() {
        return Err("invalid telemetry event".into());
    }
    if matches!(
        name,
        "app_starred_pebble"
            | "star_nag_outcome"
            | "feature_interaction_usage_bucket_reached"
            | "telemetry_opted_in"
            | "telemetry_opted_out"
    ) {
        return Err("telemetry event is not renderer-owned".into());
    }
    Ok(())
}

async fn capture(
    app: &tauri::AppHandle,
    state: &TelemetryState,
    name: &str,
    props: Value,
) -> Result<(), String> {
    let Some((channel, key)) = production_transport() else {
        return Ok(());
    };
    if !consume_event_token(name) {
        return Ok(());
    }
    let consent = resolve_consent(state);
    let explicit_user_opt_out = matches!(
        consent,
        ConsentState::Disabled {
            reason: DisabledReason::UserOptOut
        }
    ) && name == "telemetry_opted_out";
    if !consent.effective_enabled() && !explicit_user_opt_out {
        return Ok(());
    }
    let mut properties = Map::new();
    properties.insert(
        "app_version".into(),
        Value::String(app.package_info().version.to_string()),
    );
    properties.insert(
        "platform".into(),
        Value::String(std::env::consts::OS.into()),
    );
    properties.insert("arch".into(), Value::String(std::env::consts::ARCH.into()));
    properties.insert(
        "os_release".into(),
        Value::String(sysinfo::System::kernel_version().unwrap_or_else(|| "unknown".into())),
    );
    properties.insert("install_id".into(), Value::String(state.install_id.clone()));
    properties.insert(
        "distinct_id".into(),
        Value::String(state.install_id.clone()),
    );
    properties.insert("session_id".into(), Value::String(session_id()));
    properties.insert("pebble_channel".into(), Value::String(channel.into()));
    properties.insert("$process_person_profile".into(), Value::Bool(false));
    properties.extend(props.as_object().cloned().unwrap_or_default());
    let response = reqwest::Client::builder()
        .timeout(TRANSPORT_TIMEOUT)
        .build()
        .map_err(|err| format!("telemetry transport setup failed: {err}"))?
        .post(POSTHOG_HOST)
        .json(&json!({
            "api_key": key, "event": name, "properties": properties
        }))
        .send()
        .await
        .map_err(|err| format!("telemetry transport failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "telemetry transport returned {}",
            response.status()
        ));
    }
    Ok(())
}

fn production_transport() -> Option<(&'static str, &'static str)> {
    let channel = option_env!("PEBBLE_BUILD_IDENTITY")?;
    let key = option_env!("PEBBLE_POSTHOG_WRITE_KEY")?;
    if matches!(channel, "stable" | "rc") && !key.is_empty() {
        Some((channel, key))
    } else {
        None
    }
}

fn consume_event_token(name: &str) -> bool {
    let budget = EVENT_BUDGET.get_or_init(|| Mutex::new(EventBudget::default()));
    let mut budget = budget
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if budget.session_count >= 1_000 {
        return false;
    }
    let now = Instant::now();
    let capacity = if name == "agent_error" { 20.0 } else { 30.0 };
    let bucket = budget
        .buckets
        .entry(name.to_string())
        .or_insert(EventBucket {
            tokens: capacity,
            capacity,
            last_refill: now,
        });
    let elapsed = now.duration_since(bucket.last_refill);
    if elapsed > Duration::ZERO {
        bucket.tokens =
            (bucket.tokens + elapsed.as_secs_f64() * bucket.capacity / 60.0).min(bucket.capacity);
        bucket.last_refill = now;
    }
    if bucket.tokens < 1.0 {
        return false;
    }
    bucket.tokens -= 1.0;
    budget.session_count += 1;
    true
}

fn session_id() -> String {
    use std::sync::OnceLock;
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| Uuid::new_v4().to_string()).clone()
}

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("telemetry-state.json"))
}

fn load_or_create_state(app: &tauri::AppHandle) -> Result<TelemetryState, String> {
    let path = state_path(app)?;
    if let Ok(raw) = fs::read_to_string(&path) {
        return serde_json::from_str(&raw).map_err(|err| format!("invalid telemetry state: {err}"));
    }
    let state = initial_state(path.parent().ok_or("telemetry state path has no parent")?)?;
    persist_state(app, &state)?;
    Ok(state)
}

fn initial_state(base: &Path) -> Result<TelemetryState, String> {
    let settings_path = base.join("settings-store/settings.json");
    let existing_settings = settings_path.exists();
    if let Ok(raw) = fs::read_to_string(&settings_path) {
        let root: Value = serde_json::from_str(&raw)
            .map_err(|err| format!("invalid native settings document: {err}"))?;
        if let Some(telemetry) = root.get("telemetry") {
            if let Ok(state) = serde_json::from_value::<TelemetryState>(telemetry.clone()) {
                if !state.install_id.is_empty() {
                    return Ok(state);
                }
            }
        }
    }
    Ok(TelemetryState {
        opted_in: if existing_settings { None } else { Some(true) },
        install_id: Uuid::new_v4().to_string(),
        existed_before_telemetry_release: existing_settings,
    })
}

fn persist_state(app: &tauri::AppHandle, state: &TelemetryState) -> Result<(), String> {
    let path = state_path(app)?;
    let parent = path.parent().ok_or("telemetry state path has no parent")?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let temporary = temporary_path(&path);
    let bytes = serde_json::to_vec_pretty(state).map_err(|err| err.to_string())?;
    fs::write(&temporary, bytes).map_err(|err| err.to_string())?;
    fs::rename(&temporary, &path).map_err(|err| {
        let _ = fs::remove_file(&temporary);
        err.to_string()
    })
}

fn temporary_path(path: &Path) -> PathBuf {
    path.with_extension(format!("{}.tmp", Uuid::new_v4()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn clean_environment() -> MutexGuard<'static, ()> {
        let guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::remove_var("DO_NOT_TRACK");
        std::env::remove_var("PEBBLE_TELEMETRY_DISABLED");
        for name in [
            "CI",
            "GITHUB_ACTIONS",
            "GITLAB_CI",
            "CIRCLECI",
            "TRAVIS",
            "BUILDKITE",
            "JENKINS_URL",
            "TEAMCITY_VERSION",
        ] {
            std::env::remove_var(name);
        }
        guard
    }

    fn state(opted_in: Option<bool>) -> TelemetryState {
        TelemetryState {
            opted_in,
            install_id: Uuid::new_v4().to_string(),
            existed_before_telemetry_release: true,
        }
    }

    #[test]
    fn user_consent_states_match_electron_contract() {
        let _environment = clean_environment();
        assert_eq!(resolve_consent(&state(Some(true))), ConsentState::Enabled);
        assert_eq!(resolve_consent(&state(None)), ConsentState::PendingBanner);
        assert_eq!(
            resolve_consent(&state(Some(false))),
            ConsentState::Disabled {
                reason: DisabledReason::UserOptOut
            }
        );
    }

    #[test]
    fn environment_kill_switches_override_stored_opt_in() {
        let _environment = clean_environment();
        std::env::set_var("DO_NOT_TRACK", " TRUE ");
        assert_eq!(
            resolve_consent(&state(Some(true))),
            ConsentState::Disabled {
                reason: DisabledReason::DoNotTrack
            }
        );
        std::env::remove_var("DO_NOT_TRACK");
        std::env::set_var("PEBBLE_TELEMETRY_DISABLED", "1");
        assert_eq!(
            resolve_consent(&state(Some(true))),
            ConsentState::Disabled {
                reason: DisabledReason::PebbleDisabled
            }
        );
        std::env::remove_var("PEBBLE_TELEMETRY_DISABLED");
    }

    #[test]
    fn renderer_cannot_emit_main_owned_or_unknown_events() {
        assert!(validate_renderer_event("settings_changed", &json!({})).is_ok());
        assert!(validate_renderer_event("telemetry_opted_in", &json!({})).is_err());
        assert!(validate_renderer_event("invented", &json!({})).is_err());
        assert!(validate_renderer_event("settings_changed", &json!("bad")).is_err());
    }

    #[test]
    fn initial_state_adopts_existing_native_telemetry_identity_and_consent() {
        let directory = tempfile::tempdir().unwrap();
        let settings_directory = directory.path().join("settings-store");
        fs::create_dir_all(&settings_directory).unwrap();
        fs::write(
            settings_directory.join("settings.json"),
            r#"{"telemetry":{"optedIn":false,"installId":"existing-install","existedBeforeTelemetryRelease":true}}"#,
        )
        .unwrap();

        let loaded = initial_state(directory.path()).unwrap();
        assert_eq!(loaded.opted_in, Some(false));
        assert_eq!(loaded.install_id, "existing-install");
        assert!(loaded.existed_before_telemetry_release);
    }
}
