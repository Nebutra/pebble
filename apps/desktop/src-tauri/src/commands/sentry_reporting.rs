mod renderer_stack;

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use chrono::{DateTime, Utc};
use sentry::protocol::{Attachment, Breadcrumb, Event, Exception, Level, User, Value};
use tauri::Manager;

use super::crash_reports::{CrashReportBreadcrumb, CrashReportRecord};
use super::diagnostics::SentryDiagnosticAttachment;

const SENTRY_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
const SENTRY_TRACE_SAMPLE_RATE: f32 = 0.05;
const SENTRY_SERVER_NAME: &str = "pebble-desktop";
const MAX_MANUAL_NOTE_LENGTH: usize = 4_000;
const SAFE_DETAIL_KEYS: &[&str] = &[
    "active_modal",
    "active_tab_type",
    "active_view",
    "boundary_id",
    "component_stack",
    "error_message",
    "error_name",
    "has_active_worktree",
    "location",
    "previous_session_app_version",
    "previous_session_clean",
    "previous_session_exit_requested",
    "previous_session_last_stage",
    "previous_session_launch_kind",
    "previous_session_native_quit_requested",
    "previous_session_stage_updated_at",
    "previous_session_started_at",
    "recovery_evidence_kind",
    "right_sidebar_tab",
    "startup_component",
    "thread",
    "webview_label",
];

pub struct SentryReportingState {
    automatic_capture_enabled: AtomicBool,
    ready: AtomicBool,
    session_active: AtomicBool,
    startup_transaction: Mutex<Option<sentry::Transaction>>,
}

impl Default for SentryReportingState {
    fn default() -> Self {
        Self {
            automatic_capture_enabled: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            session_active: AtomicBool::new(false),
            startup_transaction: Mutex::new(None),
        }
    }
}

pub struct ManualCrashSubmission<'a> {
    pub report: Option<&'a CrashReportRecord>,
    pub notes: Option<&'a str>,
    pub submit_anonymously: bool,
    pub github_login: Option<&'a str>,
    pub github_email: Option<&'a str>,
    pub app_version: &'a str,
    pub chrome_version: Option<&'a str>,
}

pub fn init_client() -> sentry::ClientInitGuard {
    sentry::init(client_options())
}

fn client_options() -> sentry::ClientOptions {
    sentry::ClientOptions {
        dsn: configured_dsn(),
        release: Some(release_name().into()),
        environment: configured_channel().map(Into::into),
        // Why: the context integration otherwise reports the user's machine hostname.
        server_name: Some(SENTRY_SERVER_NAME.into()),
        auto_session_tracking: false,
        attach_stacktrace: true,
        send_default_pii: false,
        traces_sample_rate: SENTRY_TRACE_SAMPLE_RATE,
        shutdown_timeout: SENTRY_FLUSH_TIMEOUT,
        ..Default::default()
    }
}

pub fn sync_initial_consent(app: &tauri::AppHandle) {
    let enabled = super::telemetry::automatic_capture_enabled(app).unwrap_or(false);
    set_automatic_capture(app, enabled);
}

pub fn set_automatic_capture(app: &tauri::AppHandle, requested: bool) {
    let state = app.state::<SentryReportingState>();
    let enabled = requested && client_is_enabled();
    state
        .automatic_capture_enabled
        .store(enabled, Ordering::Release);

    if enabled {
        start_session_if_needed(&state);
        start_startup_transaction_if_needed(&state);
    } else {
        discard_startup_transaction(&state);
        end_session_if_needed(&state);
    }
}

pub fn mark_ready(app: &tauri::AppHandle) {
    let state = app.state::<SentryReportingState>();
    state.ready.store(true, Ordering::Release);
    if state.automatic_capture_enabled.load(Ordering::Acquire) {
        finish_startup_transaction(&state);
    } else {
        discard_startup_transaction(&state);
    }
}

pub fn shutdown(app: &tauri::AppHandle) {
    let state = app.state::<SentryReportingState>();
    state
        .automatic_capture_enabled
        .store(false, Ordering::Release);
    discard_startup_transaction(&state);
    end_session_if_needed(&state);
    if let Some(client) = sentry::Hub::main().client() {
        let _ = client.flush(Some(SENTRY_FLUSH_TIMEOUT));
    }
}

pub fn capture_automatic_report(app: &tauri::AppHandle, report: &CrashReportRecord) {
    let state = app.state::<SentryReportingState>();
    if !state.automatic_capture_enabled.load(Ordering::Acquire) || !client_is_enabled() {
        return;
    }
    sentry::Hub::main().capture_event(event_from_report(report, false));
}

pub fn submit_manual_crash(
    input: ManualCrashSubmission<'_>,
    diagnostic: Option<SentryDiagnosticAttachment>,
) -> Result<(), String> {
    let client = sentry::Hub::main()
        .client()
        .filter(|client| client.is_enabled())
        .ok_or_else(|| "Sentry crash submission is not configured for this build.".to_string())?;
    let mut event = manual_event(input);
    if let Some(diagnostic) = diagnostic.as_ref() {
        add_diagnostic_metadata(&mut event, diagnostic);
    }
    let attachment = diagnostic.map(sentry_attachment);
    // Why: reviewed reports can describe an older crash and must not mutate the
    // current automatic release-health session or inherit its scope data.
    let hub = Arc::new(sentry::Hub::new(
        Some(client.clone()),
        Arc::new(sentry::Scope::default()),
    ));
    hub.with_scope(
        |scope| {
            if let Some(attachment) = attachment {
                scope.add_attachment(attachment);
            }
        },
        || {
            hub.capture_event(event);
        },
    );
    if client.flush(Some(SENTRY_FLUSH_TIMEOUT)) {
        Ok(())
    } else {
        Err("Sentry crash submission timed out.".to_string())
    }
}

fn manual_event(input: ManualCrashSubmission<'_>) -> Event<'static> {
    let mut event = input.report.map_or_else(
        || Event {
            level: Level::Error,
            message: Some("User-submitted uncaptured Pebble crash".to_string()),
            dist: configured_dist().map(Into::into),
            fingerprint: Cow::Owned(vec![Cow::Owned("pebble-uncaptured-crash".to_string())]),
            tags: {
                let mut tags = base_tags("manual", "uncaptured", input.app_version);
                tags.insert("submission".to_string(), "manual".to_string());
                tags
            },
            ..Default::default()
        },
        |report| event_from_report(report, true),
    );
    if let Some(notes) = input.notes.and_then(non_empty) {
        event.extra.insert(
            "user_notes".to_string(),
            Value::String(truncate(notes, MAX_MANUAL_NOTE_LENGTH)),
        );
    }
    if !input.submit_anonymously {
        let username = input.github_login.and_then(non_empty).map(str::to_string);
        let email = input.github_email.and_then(non_empty).map(str::to_string);
        if username.is_some() || email.is_some() {
            event.user = Some(User {
                username,
                email,
                ..Default::default()
            });
        }
    }
    if let Some(chrome_version) = input.chrome_version.and_then(non_empty) {
        event
            .tags
            .insert("webview_version".to_string(), chrome_version.to_string());
    }
    event
}

fn event_from_report(report: &CrashReportRecord, manual: bool) -> Event<'static> {
    let mut tags = base_tags(&report.source, &report.process_type, &report.app_version);
    tags.insert("reason".to_string(), report.reason.clone());
    tags.insert("arch".to_string(), report.arch.clone());
    tags.insert("os_release".to_string(), report.os_release.clone());
    tags.insert(
        "submission".to_string(),
        if manual { "manual" } else { "automatic" }.into(),
    );
    tags.insert("crash_report_id".to_string(), report.id.clone());
    let stacktrace = report
        .details
        .get("error_stack")
        .and_then(Value::as_str)
        .and_then(renderer_stack::parse_renderer_stack);
    let exception_type = report
        .details
        .get("error_name")
        .and_then(Value::as_str)
        .unwrap_or(&report.reason)
        .to_string();
    let exception_value = report
        .details
        .get("error_message")
        .and_then(Value::as_str)
        .unwrap_or(&report.reason)
        .to_string();
    Event {
        level: report_level(report),
        platform: if matches!(report.source.as_str(), "renderer" | "child") {
            Cow::Borrowed("javascript")
        } else {
            Cow::Borrowed("rust")
        },
        timestamp: parse_timestamp(&report.created_at),
        dist: configured_dist().map(Into::into),
        fingerprint: Cow::Owned(vec![
            Cow::Owned("pebble-crash".to_string()),
            Cow::Owned(report.source.clone()),
            Cow::Owned(report.process_type.clone()),
            Cow::Owned(report.reason.clone()),
            Cow::Owned(
                report
                    .details
                    .get("boundary_id")
                    .and_then(Value::as_str)
                    .unwrap_or("none")
                    .to_string(),
            ),
        ]),
        exception: vec![Exception {
            ty: exception_type,
            value: Some(exception_value),
            stacktrace,
            ..Default::default()
        }]
        .into(),
        breadcrumbs: sentry_breadcrumbs(report.breadcrumbs.as_deref()).into(),
        tags,
        extra: safe_details(&report.details),
        ..Default::default()
    }
}

fn start_session_if_needed(state: &SentryReportingState) {
    if !state.session_active.swap(true, Ordering::AcqRel) {
        sentry::Hub::main().start_session();
    }
}

fn end_session_if_needed(state: &SentryReportingState) {
    if state.session_active.swap(false, Ordering::AcqRel) {
        sentry::Hub::main().end_session();
    }
}

fn start_startup_transaction_if_needed(state: &SentryReportingState) {
    if state.ready.load(Ordering::Acquire) {
        return;
    }
    let Ok(mut slot) = lock_transaction(&state.startup_transaction) else {
        return;
    };
    if slot.is_some() {
        return;
    }
    let transaction = sentry::Hub::main().start_transaction(sentry::TransactionContext::new(
        "pebble.desktop.startup",
        "app.start",
    ));
    transaction.set_tag("platform", std::env::consts::OS);
    transaction.set_tag("arch", std::env::consts::ARCH);
    if let Some(dist) = configured_dist() {
        transaction.set_tag("dist", dist);
    }
    *slot = Some(transaction);
}

fn finish_startup_transaction(state: &SentryReportingState) {
    if let Ok(mut slot) = lock_transaction(&state.startup_transaction) {
        if let Some(transaction) = slot.take() {
            transaction.finish();
        }
    }
}

fn discard_startup_transaction(state: &SentryReportingState) {
    if let Ok(mut slot) = lock_transaction(&state.startup_transaction) {
        let _ = slot.take();
    }
}

fn lock_transaction(
    mutex: &Mutex<Option<sentry::Transaction>>,
) -> Result<MutexGuard<'_, Option<sentry::Transaction>>, String> {
    mutex
        .lock()
        .map_err(|_| "Sentry startup transaction state is unavailable.".to_string())
}

fn client_is_enabled() -> bool {
    sentry::Hub::main()
        .client()
        .is_some_and(|client| client.is_enabled())
}

fn configured_dsn() -> Option<sentry::types::Dsn> {
    let dsn = option_env!("PEBBLE_SENTRY_DSN")?;
    if configured_channel().is_none() || dsn.trim().is_empty() {
        return None;
    }
    dsn.parse().ok()
}

fn configured_channel() -> Option<&'static str> {
    option_env!("PEBBLE_BUILD_IDENTITY").filter(|value| matches!(*value, "stable" | "rc"))
}

fn configured_dist() -> Option<&'static str> {
    option_env!("PEBBLE_SENTRY_DIST").filter(|value| !value.trim().is_empty())
}

fn release_name() -> String {
    format!("pebble@{}", env!("CARGO_PKG_VERSION"))
}

fn sentry_attachment(input: SentryDiagnosticAttachment) -> Attachment {
    Attachment {
        buffer: input.content.into_bytes(),
        filename: format!("pebble-diagnostics-{}.ndjson", input.bundle_submission_id),
        content_type: Some("application/x-ndjson".to_string()),
        ..Default::default()
    }
}

fn add_diagnostic_metadata(event: &mut Event<'static>, diagnostic: &SentryDiagnosticAttachment) {
    event.extra.insert(
        "diagnostic_bundle_bytes".to_string(),
        Value::from(diagnostic.bytes as u64),
    );
    event.extra.insert(
        "diagnostic_bundle_span_count".to_string(),
        Value::from(diagnostic.span_count as u64),
    );
}

fn sentry_breadcrumbs(input: Option<&[CrashReportBreadcrumb]>) -> Vec<Breadcrumb> {
    input
        .unwrap_or_default()
        .iter()
        .map(|breadcrumb| Breadcrumb {
            timestamp: parse_timestamp(&breadcrumb.created_at),
            category: Some(breadcrumb.name.clone()),
            data: breadcrumb
                .data
                .clone()
                .unwrap_or_default()
                .into_iter()
                .collect(),
            ..Default::default()
        })
        .collect()
}

fn safe_details(details: &serde_json::Map<String, Value>) -> BTreeMap<String, Value> {
    details
        .iter()
        .filter(|(key, _)| SAFE_DETAIL_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn base_tags(source: &str, process_type: &str, app_version: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("source".to_string(), source.to_string()),
        ("process_type".to_string(), process_type.to_string()),
        ("app_version".to_string(), app_version.to_string()),
        ("platform".to_string(), std::env::consts::OS.to_string()),
    ])
}

fn report_level(report: &CrashReportRecord) -> Level {
    if report.source == "native" && report.process_type == "tauri-host" {
        Level::Fatal
    } else {
        Level::Error
    }
}

fn parse_timestamp(value: &str) -> std::time::SystemTime {
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.with_timezone(&Utc).into())
        .unwrap_or_else(|_| std::time::SystemTime::now())
}

fn non_empty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_report() -> CrashReportRecord {
        CrashReportRecord {
            id: "report-1".to_string(),
            created_at: "2026-07-24T00:00:00Z".to_string(),
            status: "pending".to_string(),
            source: "renderer".to_string(),
            process_type: "react-render".to_string(),
            reason: "react-error-boundary".to_string(),
            exit_code: None,
            app_version: "1.4.124-rc.8".to_string(),
            platform: "darwin".to_string(),
            os_release: "25.5.0".to_string(),
            arch: "arm64".to_string(),
            electron_version: "tauri".to_string(),
            chrome_version: "WebKit".to_string(),
            details: serde_json::json!({
                "boundary_id": "app.root",
                "error_name": "TypeError",
                "error_message": "render failed",
                "error_stack": "at renderApp (tauri://localhost/assets/renderer.js:10:22)",
            })
            .as_object()
            .unwrap()
            .clone(),
            breadcrumbs: None,
        }
    }

    #[test]
    fn safe_details_drop_paths_and_command_content() {
        let details = serde_json::json!({
            "boundary_id": "app.root",
            "cwd": "/private/repo",
            "command_output": "secret",
            "error_message": "render failed"
        })
        .as_object()
        .unwrap()
        .clone();
        let safe = safe_details(&details);
        assert_eq!(
            safe.get("boundary_id"),
            Some(&Value::String("app.root".into()))
        );
        assert_eq!(
            safe.get("error_message"),
            Some(&Value::String("render failed".into()))
        );
        assert!(!safe.contains_key("cwd"));
        assert!(!safe.contains_key("command_output"));
    }

    #[test]
    fn reporting_state_can_toggle_without_restart() {
        let state = SentryReportingState::default();
        assert!(!state.automatic_capture_enabled.load(Ordering::Acquire));
        state
            .automatic_capture_enabled
            .store(true, Ordering::Release);
        assert!(state.automatic_capture_enabled.load(Ordering::Acquire));
    }

    #[test]
    fn client_uses_generic_server_name_instead_of_device_hostname() {
        assert_eq!(
            client_options().server_name.as_deref(),
            Some(SENTRY_SERVER_NAME)
        );
    }

    #[test]
    fn report_events_keep_stable_grouping_and_release_tags() {
        let event = event_from_report(&sample_report(), false);
        let fingerprint = event
            .fingerprint
            .iter()
            .map(|value| value.as_ref())
            .collect::<Vec<_>>();
        assert_eq!(
            fingerprint,
            vec![
                "pebble-crash",
                "renderer",
                "react-render",
                "react-error-boundary",
                "app.root"
            ]
        );
        assert_eq!(
            event.tags.get("submission").map(String::as_str),
            Some("automatic")
        );
        assert_eq!(
            event.tags.get("crash_report_id").map(String::as_str),
            Some("report-1")
        );
        assert_eq!(event.platform.as_ref(), "javascript");
    }

    #[test]
    fn manual_submission_includes_identity_only_when_requested() {
        let report = sample_report();
        let anonymous = manual_event(ManualCrashSubmission {
            report: Some(&report),
            notes: Some("reviewed"),
            submit_anonymously: true,
            github_login: Some("octocat"),
            github_email: Some("octocat@example.com"),
            app_version: "1.4.124-rc.8",
            chrome_version: Some("WebKit"),
        });
        assert!(anonymous.user.is_none());

        let identified = manual_event(ManualCrashSubmission {
            report: Some(&report),
            notes: None,
            submit_anonymously: false,
            github_login: Some("octocat"),
            github_email: Some("octocat@example.com"),
            app_version: "1.4.124-rc.8",
            chrome_version: None,
        });
        let user = identified.user.expect("manual identity");
        assert_eq!(user.username.as_deref(), Some("octocat"));
        assert_eq!(user.email.as_deref(), Some("octocat@example.com"));
    }

    #[test]
    fn diagnostic_attachment_and_event_metadata_match() {
        let diagnostic = SentryDiagnosticAttachment {
            bundle_submission_id: "bundle-1".to_string(),
            content: "{\"kind\":\"span\"}\n".to_string(),
            bytes: 17,
            span_count: 3,
        };
        let attachment = sentry_attachment(diagnostic.clone());
        assert_eq!(attachment.filename, "pebble-diagnostics-bundle-1.ndjson");
        assert_eq!(
            attachment.content_type.as_deref(),
            Some("application/x-ndjson")
        );
        assert_eq!(attachment.buffer, diagnostic.content.as_bytes());

        let mut event = event_from_report(&sample_report(), true);
        add_diagnostic_metadata(&mut event, &diagnostic);
        assert_eq!(
            event.extra.get("diagnostic_bundle_bytes"),
            Some(&Value::from(17_u64))
        );
        assert_eq!(
            event.extra.get("diagnostic_bundle_span_count"),
            Some(&Value::from(3_u64))
        );
    }
}
