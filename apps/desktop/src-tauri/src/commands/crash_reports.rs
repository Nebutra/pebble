use std::{
    any::Any,
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::Manager;
use uuid::Uuid;

use super::diagnostics::{
    collect_crash_diagnostic_bundle_attachment, create_feedback_multipart_form,
    CrashFeedbackIdentity, CrashReportDiagnosticBundle, DiagnosticsState,
    FeedbackDiagnosticBundleAttachment,
};

const CRASH_REPORTS_FILE: &str = "crash-reports.json";
// Mutations append one line here instead of rewriting the whole snapshot; replayed over
// the snapshot on load and folded back in when the journal grows past MAX_JOURNAL_ENTRIES.
const CRASH_REPORTS_JOURNAL_FILE: &str = "crash-reports.log.ndjson";
const MAX_JOURNAL_ENTRIES: usize = 64;
const FEEDBACK_API_URL: &str = "https://pebble.nebutra.com/v1/feedback";
const MAX_REPORTS: usize = 5;
const MAX_BREADCRUMBS: usize = 30;
const MAX_BREADCRUMB_NAME_LENGTH: usize = 80;
const MAX_STRING_DETAIL_LENGTH: usize = 240;
const MAX_STACK_DETAIL_LENGTH: usize = 4_000;
const MAX_FORMATTED_REPORT_LENGTH: usize = 64_000;
const RENDERER_ERROR_DEDUPE_MS: u128 = 10 * 60 * 1000;
const MAX_RENDERER_ERROR_KEY_AGE_MS: u128 = RENDERER_ERROR_DEDUPE_MS * 2;
const RELATED_CRASH_WINDOW_MS: i128 = 5_000;
const SECONDARY_CANNOT_UNWIND_WINDOW: Duration = Duration::from_secs(5);
const CANNOT_UNWIND_REASON: &str = "panic in a function that cannot unwind";
const FEEDBACK_REQUEST_TIMEOUT_SECONDS: u64 = 10;
const TAURI_ELECTRON_VERSION_SENTINEL: &str = "tauri";
const FORMATTED_REPORT_TRUNCATION_SUFFIX: &str =
    "\n\n[Crash report truncated to fit feedback endpoint limits.]";
static PANIC_HOOK_RECORDING: AtomicBool = AtomicBool::new(false);
static RECENT_NATIVE_PANIC: OnceLock<Mutex<Option<RecentNativePanic>>> = OnceLock::new();

struct RecentNativePanic {
    recorded_at: Instant,
    thread_name: String,
}

#[derive(Default)]
pub struct CrashReportsState {
    breadcrumbs: Mutex<Vec<CrashReportBreadcrumb>>,
    recent_renderer_error_report_keys: Mutex<HashMap<String, u128>>,
    submitted_report_ids: Mutex<Vec<String>>,
    in_flight_submissions: Mutex<HashSet<String>>,
    file_lock: Mutex<()>,
}

pub fn install_native_panic_hook(app: tauri::AppHandle) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if !PANIC_HOOK_RECORDING.swap(true, Ordering::AcqRel) {
            let thread_name = std::thread::current()
                .name()
                .unwrap_or("unnamed")
                .to_string();
            let location = info
                .location()
                .map(|value| (value.file(), value.line(), value.column()));
            let (reason, mut details) =
                native_panic_record(info.payload(), Some(&thread_name), location);
            super::native_session_recovery::append_active_session_diagnostics(&app, &mut details);
            if should_record_native_panic(&reason, &thread_name) {
                if let Err(error) = record_native_process_failure(
                    &app,
                    "tauri-host",
                    &format!("rust-panic: {reason}"),
                    None,
                    details,
                ) {
                    eprintln!("[crash-reporting] failed to persist Rust panic: {error}");
                }
            }
            PANIC_HOOK_RECORDING.store(false, Ordering::Release);
        }
        previous(info);
    }));
}

fn should_record_native_panic(reason: &str, thread_name: &str) -> bool {
    let now = Instant::now();
    let recent = RECENT_NATIVE_PANIC.get_or_init(|| Mutex::new(None));
    let Ok(mut recent) = recent.lock() else {
        return true;
    };
    if is_secondary_cannot_unwind(reason, thread_name, recent.as_ref(), now) {
        return false;
    }
    *recent = Some(RecentNativePanic {
        recorded_at: now,
        thread_name: thread_name.to_string(),
    });
    true
}

fn is_secondary_cannot_unwind(
    reason: &str,
    thread_name: &str,
    recent: Option<&RecentNativePanic>,
    now: Instant,
) -> bool {
    reason == CANNOT_UNWIND_REASON
        && recent.is_some_and(|recent| {
            recent.thread_name == thread_name
                && now.saturating_duration_since(recent.recorded_at)
                    <= SECONDARY_CANNOT_UNWIND_WINDOW
        })
}

pub(crate) fn record_native_startup_failure(app: &tauri::AppHandle, component: &str, error: &str) {
    let mut details = Map::new();
    details.insert(
        "startup_component".to_string(),
        Value::String(sanitize_crash_report_string(
            component,
            MAX_STRING_DETAIL_LENGTH,
        )),
    );
    super::native_session_recovery::append_active_session_diagnostics(app, &mut details);
    if let Err(persist_error) = record_native_process_failure(
        app,
        "tauri-host",
        &format!(
            "native-startup-failure: {}",
            sanitize_crash_report_string(error, MAX_STRING_DETAIL_LENGTH)
        ),
        None,
        details,
    ) {
        eprintln!("[crash-reporting] failed to persist native startup failure: {persist_error}");
    }
}

fn native_panic_record(
    payload: &(dyn Any + Send),
    thread_name: Option<&str>,
    location: Option<(&str, u32, u32)>,
) -> (String, Map<String, Value>) {
    let mut details = Map::new();
    details.insert(
        "thread".to_string(),
        Value::String(thread_name.unwrap_or("unnamed").to_string()),
    );
    if let Some((file, line, column)) = location {
        details.insert(
            "location".to_string(),
            Value::String(format!("{file}:{line}:{column}")),
        );
    }
    (panic_payload_message(payload), details)
}

fn panic_payload_message(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return sanitize_crash_report_string(message, MAX_STRING_DETAIL_LENGTH);
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return sanitize_crash_report_string(message, MAX_STRING_DETAIL_LENGTH);
    }
    "non-string panic payload".to_string()
}

#[cfg(target_os = "macos")]
pub fn record_web_content_process_termination(webview: &tauri::Webview) {
    record_native_webview_process_failure(
        webview.app_handle().clone(),
        webview.label().to_string(),
        webview.url().ok().map(|value| value.to_string()),
        "web-content-process-terminated".to_string(),
    );
}

pub fn record_native_webview_process_failure(
    app: tauri::AppHandle,
    label: String,
    url: Option<String>,
    reason: String,
) {
    // Why: WebKit invokes this hook on the UI thread after its content process
    // dies; crash-store I/O must not delay WebView recovery or window input.
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = record_native_webview_process_failure_blocking(&app, label, url, reason)
        {
            eprintln!("[crash-reporting] failed to record WebView process failure: {error}");
        }
    });
}

fn record_native_webview_process_failure_blocking(
    app: &tauri::AppHandle,
    label: String,
    url: Option<String>,
    reason: String,
) -> Result<(), String> {
    let state = app.state::<CrashReportsState>();
    let reason = sanitize_crash_report_string(&reason, MAX_STRING_DETAIL_LENGTH);
    let key = format!("web-content-process-failed:{label}:{reason}");
    if is_recent_renderer_error_duplicate(&state, &key)? {
        return Ok(());
    }
    let breadcrumbs = lock_state(&state.breadcrumbs)?.clone();
    let mut details = Map::new();
    details.insert("webview_label".to_string(), Value::String(label.clone()));
    if let Some(url) = url {
        details.insert(
            "url".to_string(),
            Value::String(sanitize_crash_report_string(&url, MAX_STRING_DETAIL_LENGTH)),
        );
    }
    let source = web_content_crash_source(&label);
    record_report(
        app,
        &state,
        CrashReportCreateInput {
            source: source.to_string(),
            process_type: "web-content".to_string(),
            reason,
            exit_code: None,
            app_version: app.package_info().version.to_string(),
            platform: current_node_platform(),
            os_release: current_os_release(),
            arch: current_node_arch(),
            electron_version: TAURI_ELECTRON_VERSION_SENTINEL.to_string(),
            chrome_version: "WebKit".to_string(),
            details,
            breadcrumbs: (!breadcrumbs.is_empty()).then_some(breadcrumbs),
        },
    )?;
    Ok(())
}

fn web_content_crash_source(label: &str) -> &'static str {
    if label.starts_with("browser-") {
        "child"
    } else {
        "renderer"
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportRecord {
    id: String,
    created_at: String,
    status: String,
    source: String,
    process_type: String,
    reason: String,
    exit_code: Option<i64>,
    app_version: String,
    platform: String,
    os_release: String,
    arch: String,
    electron_version: String,
    chrome_version: String,
    details: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    breadcrumbs: Option<Vec<CrashReportBreadcrumb>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportBreadcrumb {
    created_at: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Map<String, Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportRendererErrorInput {
    boundary_id: String,
    surface: String,
    error_name: String,
    error_message: String,
    error_stack: Option<String>,
    component_stack: Option<String>,
    active_view: Option<String>,
    active_modal: Option<Value>,
    active_tab_type: Option<String>,
    active_right_sidebar_tab: Option<String>,
    has_active_worktree: Option<bool>,
    app_version: String,
    chrome_version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportRendererErrorResult {
    ok: bool,
    report: Option<CrashReportRecord>,
    deduped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportBreadcrumbInput {
    name: String,
    data: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportIdInput {
    report_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportTextInput {
    report_id: Option<String>,
    notes: Option<String>,
    app_version: String,
    chrome_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportSubmitInput {
    report_id: Option<String>,
    notes: Option<String>,
    include_diagnostic_logs: Option<bool>,
    submit_anonymously: Option<bool>,
    github_login: Option<String>,
    github_email: Option<String>,
    app_version: String,
    chrome_version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportSubmitResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    report: Option<CrashReportRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic_bundle: Option<CrashReportDiagnosticBundle>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashReportFile {
    reports: Vec<CrashReportRecord>,
}

// Internal on-disk journal delta — never part of the renderer contract, so its shape is
// free to change. `op` tags the variant; unknown/corrupt lines are ignored on replay.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum CrashReportJournalEntry {
    // A newly recorded report, prepended then capped exactly like record_report.
    Insert {
        report: CrashReportRecord,
    },
    // One or more status assignments (target transition plus related-crash dismissals).
    SetStatus {
        changes: Vec<CrashReportStatusChange>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashReportStatusChange {
    id: String,
    status: String,
}

#[derive(Debug)]
struct CrashReportCreateInput {
    source: String,
    process_type: String,
    reason: String,
    exit_code: Option<i64>,
    app_version: String,
    platform: String,
    os_release: String,
    arch: String,
    electron_version: String,
    chrome_version: String,
    details: Map<String, Value>,
    breadcrumbs: Option<Vec<CrashReportBreadcrumb>>,
}

// Why: sync commands run on the Tauri main thread; the crash-report store does
// snapshot/journal file I/O (and spawns `uname`), so bodies run in spawn_blocking
// and re-fetch managed state from the app handle inside the blocking task.
#[tauri::command]
pub async fn crash_reports_get_latest_pending(
    app: tauri::AppHandle,
) -> Result<Option<CrashReportRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<CrashReportsState>();
        let reports = read_reports_locked(&app, &state)?;
        let submitted = lock_state(&state.submitted_report_ids)?;
        Ok(reports
            .into_iter()
            .find(|report| report.status == "pending" && !submitted.contains(&report.id)))
    })
    .await
    .map_err(|error| format!("Crash report task failed: {error}"))?
}

#[tauri::command]
pub async fn crash_reports_get_latest_report(
    app: tauri::AppHandle,
) -> Result<Option<CrashReportRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<CrashReportsState>();
        let reports = read_reports_locked(&app, &state)?;
        let submitted = lock_state(&state.submitted_report_ids)?;
        Ok(reports.into_iter().find(|report| {
            (report.status == "pending" || report.status == "dismissed")
                && !submitted.contains(&report.id)
        }))
    })
    .await
    .map_err(|error| format!("Crash report task failed: {error}"))?
}

#[tauri::command]
pub async fn crash_reports_dismiss(
    app: tauri::AppHandle,
    input: CrashReportIdInput,
) -> Result<Option<CrashReportRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<CrashReportsState>();
        if lock_state(&state.in_flight_submissions)?.contains(&input.report_id) {
            return get_report_by_id_locked(&app, &state, &input.report_id);
        }
        if lock_state(&state.submitted_report_ids)?.contains(&input.report_id) {
            return Ok(
                get_report_by_id_locked(&app, &state, &input.report_id)?.map(|report| {
                    CrashReportRecord {
                        status: "sent".to_string(),
                        ..report
                    }
                }),
            );
        }
        transition_report_status(&app, &state, &input.report_id, "pending", "dismissed")
    })
    .await
    .map_err(|error| format!("Crash report task failed: {error}"))?
}

#[tauri::command]
pub fn crash_reports_record_breadcrumb(
    state: tauri::State<CrashReportsState>,
    input: CrashReportBreadcrumbInput,
) -> Result<(), String> {
    if let Some(breadcrumb) = sanitize_breadcrumb(input) {
        let mut breadcrumbs = lock_state(&state.breadcrumbs)?;
        breadcrumbs.push(breadcrumb);
        if breadcrumbs.len() > MAX_BREADCRUMBS {
            let remove_count = breadcrumbs.len() - MAX_BREADCRUMBS;
            breadcrumbs.drain(0..remove_count);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn crash_reports_record_renderer_error(
    app: tauri::AppHandle,
    input: CrashReportRendererErrorInput,
) -> Result<CrashReportRendererErrorResult, String> {
    tauri::async_runtime::spawn_blocking(move || record_renderer_error_blocking(&app, input))
        .await
        .map_err(|error| format!("Crash report task failed: {error}"))?
}

fn record_renderer_error_blocking(
    app: &tauri::AppHandle,
    input: CrashReportRendererErrorInput,
) -> Result<CrashReportRendererErrorResult, String> {
    let state = app.state::<CrashReportsState>();
    let normalized = normalize_renderer_error_input(input)?;
    let key = renderer_error_report_key(&normalized);
    if is_recent_renderer_error_duplicate(&state, &key)? {
        return Ok(CrashReportRendererErrorResult {
            ok: true,
            report: None,
            deduped: true,
            error: None,
        });
    }

    let breadcrumbs = lock_state(&state.breadcrumbs)?.clone();
    let report = record_report(
        app,
        &state,
        CrashReportCreateInput {
            source: "renderer".to_string(),
            process_type: "react-render".to_string(),
            reason: "react-error-boundary".to_string(),
            exit_code: None,
            app_version: normalized.app_version,
            platform: current_node_platform(),
            os_release: current_os_release(),
            arch: current_node_arch(),
            electron_version: TAURI_ELECTRON_VERSION_SENTINEL.to_string(),
            chrome_version: normalized.chrome_version,
            details: normalized.details,
            breadcrumbs: if breadcrumbs.is_empty() {
                None
            } else {
                Some(breadcrumbs)
            },
        },
    )?;

    Ok(CrashReportRendererErrorResult {
        ok: true,
        report: Some(report),
        deduped: false,
        error: None,
    })
}

#[tauri::command]
pub async fn crash_reports_format(
    app: tauri::AppHandle,
    input: CrashReportTextInput,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<CrashReportsState>();
        let report = get_requested_report_locked(&app, &state, input.report_id.as_deref())?;
        Ok(match report {
            Some(report) => format_crash_report_text(&report, input.notes.as_deref(), None),
            None => format_uncaptured_crash_report_text(
                input.notes.as_deref(),
                &input.app_version,
                input.chrome_version.as_deref(),
                None,
            ),
        })
    })
    .await
    .map_err(|error| format!("Crash report task failed: {error}"))?
}

#[tauri::command]
pub async fn crash_reports_submit(
    app: tauri::AppHandle,
    state: tauri::State<'_, CrashReportsState>,
    _diagnostics_state: tauri::State<'_, DiagnosticsState>,
    input: CrashReportSubmitInput,
) -> Result<CrashReportSubmitResult, String> {
    let report = get_requested_report_locked(&app, &state, input.report_id.as_deref())?;
    let diagnostic_upload = collect_crash_diagnostic_bundle_attachment(
        &app,
        input.include_diagnostic_logs,
        &input.app_version,
    );
    let diagnostic_bundle = diagnostic_upload.diagnostic_bundle.clone();
    let feedback = match &report {
        Some(report) => {
            format_crash_report_text(report, input.notes.as_deref(), Some(&diagnostic_bundle))
        }
        None => format_uncaptured_crash_report_text(
            input.notes.as_deref(),
            &input.app_version,
            input.chrome_version.as_deref(),
            Some(&diagnostic_bundle),
        ),
    };

    if let Some(report) = &report {
        if report.status != "pending" && report.status != "dismissed" {
            return Ok(CrashReportSubmitResult {
                ok: true,
                status: None,
                error: None,
                report: Some(report.clone()),
                diagnostic_bundle: Some(diagnostic_bundle.clone()),
            });
        }
        if lock_state(&state.submitted_report_ids)?.contains(&report.id) {
            return Ok(CrashReportSubmitResult {
                ok: true,
                status: None,
                error: None,
                report: Some(CrashReportRecord {
                    status: "sent".to_string(),
                    ..report.clone()
                }),
                diagnostic_bundle: Some(diagnostic_bundle.clone()),
            });
        }
        if !mark_submission_started(&state, &report.id)? {
            return Ok(CrashReportSubmitResult {
                ok: false,
                status: None,
                error: Some("Crash report submission already in progress.".to_string()),
                report: Some(report.clone()),
                diagnostic_bundle: Some(diagnostic_bundle.clone()),
            });
        }
    }

    let result = post_crash_feedback(
        &input,
        feedback,
        diagnostic_upload.feedback_diagnostic_bundle,
    )
    .await;
    if let Some(report) = &report {
        mark_submission_finished(&state, &report.id)?;
    }

    match result {
        Ok(()) => {
            let sent_report = if let Some(report) = report {
                remember_submitted_report_id(&state, &report.id)?;
                let from_status = if report.status == "dismissed" {
                    "dismissed"
                } else {
                    "pending"
                };
                transition_report_status(&app, &state, &report.id, from_status, "sent")?.or(Some(
                    CrashReportRecord {
                        status: "sent".to_string(),
                        ..report
                    },
                ))
            } else {
                None
            };
            Ok(CrashReportSubmitResult {
                ok: true,
                status: None,
                error: None,
                report: sent_report,
                diagnostic_bundle: Some(diagnostic_bundle.clone()),
            })
        }
        Err((status, error)) => Ok(CrashReportSubmitResult {
            ok: false,
            status,
            error: Some(error),
            report,
            diagnostic_bundle: Some(diagnostic_bundle.clone()),
        }),
    }
}

fn normalize_renderer_error_input(
    input: CrashReportRendererErrorInput,
) -> Result<NormalizedRendererErrorInput, String> {
    let boundary_id = required_string(input.boundary_id, 120, "Invalid renderer error report.")?;
    let surface = required_string(input.surface, 80, "Invalid renderer error report.")?;
    if !is_react_error_boundary_surface(&surface) {
        return Err("Invalid renderer error report.".to_string());
    }
    let error_name = optional_string(input.error_name, 120).unwrap_or_else(|| "Error".to_string());
    let error_message = optional_string(input.error_message, 1_000)
        .unwrap_or_else(|| "Unknown render error".to_string());

    let mut details = Map::new();
    details.insert(
        "boundary_id".to_string(),
        Value::String(boundary_id.clone()),
    );
    details.insert("surface".to_string(), Value::String(surface.clone()));
    details.insert("error_name".to_string(), Value::String(error_name.clone()));
    details.insert(
        "error_message".to_string(),
        Value::String(error_message.clone()),
    );
    insert_optional_string(&mut details, "error_stack", input.error_stack, 8_000);
    insert_optional_string(
        &mut details,
        "component_stack",
        input.component_stack,
        8_000,
    );
    insert_optional_string(&mut details, "active_view", input.active_view, 80);
    if let Some(active_modal) = normalize_nullable_string(input.active_modal, 80) {
        details.insert("active_modal".to_string(), active_modal);
    }
    insert_optional_string(&mut details, "active_tab_type", input.active_tab_type, 80);
    insert_optional_string(
        &mut details,
        "right_sidebar_tab",
        input.active_right_sidebar_tab,
        80,
    );
    if let Some(has_active_worktree) = input.has_active_worktree {
        details.insert(
            "has_active_worktree".to_string(),
            Value::Bool(has_active_worktree),
        );
    }

    Ok(NormalizedRendererErrorInput {
        boundary_id,
        surface,
        error_name,
        error_message,
        component_stack: details
            .get("component_stack")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        app_version: optional_string(input.app_version, 120)
            .unwrap_or_else(|| "unknown".to_string()),
        chrome_version: input
            .chrome_version
            .and_then(|value| optional_string(value, 120))
            .unwrap_or_else(|| "unknown".to_string()),
        details: sanitize_details(details),
    })
}

#[derive(Debug)]
struct NormalizedRendererErrorInput {
    boundary_id: String,
    surface: String,
    error_name: String,
    error_message: String,
    component_stack: Option<String>,
    app_version: String,
    chrome_version: String,
    details: Map<String, Value>,
}

fn record_report(
    app: &tauri::AppHandle,
    state: &CrashReportsState,
    input: CrashReportCreateInput,
) -> Result<CrashReportRecord, String> {
    let store = crash_report_store(app)?;
    let _lock = lock_state(&state.file_lock)?;
    let report = CrashReportRecord {
        id: Uuid::new_v4().to_string(),
        created_at: current_iso_timestamp(),
        status: "pending".to_string(),
        source: input.source,
        process_type: input.process_type,
        reason: input.reason,
        exit_code: input.exit_code,
        app_version: input.app_version,
        platform: input.platform,
        os_release: input.os_release,
        arch: input.arch,
        electron_version: input.electron_version,
        chrome_version: input.chrome_version,
        details: sanitize_details(input.details),
        breadcrumbs: sanitize_breadcrumbs(input.breadcrumbs),
    };
    // O(1)-in-store-size append; the snapshot is compacted lazily when the journal fills.
    append_journal_entry(
        &store,
        CrashReportJournalEntry::Insert {
            report: report.clone(),
        },
    )?;
    Ok(report)
}

pub(crate) fn record_native_process_failure(
    app: &tauri::AppHandle,
    process_type: &str,
    reason: &str,
    exit_code: Option<i32>,
    details: Map<String, Value>,
) -> Result<(), String> {
    let state = app.state::<CrashReportsState>();
    let breadcrumbs = lock_state(&state.breadcrumbs)?.clone();
    record_report(
        app,
        &state,
        CrashReportCreateInput {
            source: "native".to_string(),
            process_type: process_type.to_string(),
            reason: reason.to_string(),
            exit_code: exit_code.map(i64::from),
            app_version: app.package_info().version.to_string(),
            platform: current_node_platform(),
            os_release: current_os_release(),
            arch: current_node_arch(),
            electron_version: TAURI_ELECTRON_VERSION_SENTINEL.to_string(),
            chrome_version: "unknown".to_string(),
            details,
            breadcrumbs: (!breadcrumbs.is_empty()).then_some(breadcrumbs),
        },
    )?;
    Ok(())
}

fn read_reports_locked(
    app: &tauri::AppHandle,
    state: &CrashReportsState,
) -> Result<Vec<CrashReportRecord>, String> {
    let store = crash_report_store(app)?;
    let _lock = lock_state(&state.file_lock)?;
    read_reports(&store)
}

fn get_report_by_id_locked(
    app: &tauri::AppHandle,
    state: &CrashReportsState,
    id: &str,
) -> Result<Option<CrashReportRecord>, String> {
    Ok(read_reports_locked(app, state)?
        .into_iter()
        .find(|report| report.id == id))
}

fn get_requested_report_locked(
    app: &tauri::AppHandle,
    state: &CrashReportsState,
    report_id: Option<&str>,
) -> Result<Option<CrashReportRecord>, String> {
    match report_id {
        Some(id) if !id.trim().is_empty() => get_report_by_id_locked(app, state, id.trim()),
        _ => Ok(None),
    }
}

fn transition_report_status(
    app: &tauri::AppHandle,
    state: &CrashReportsState,
    id: &str,
    from: &str,
    status: &str,
) -> Result<Option<CrashReportRecord>, String> {
    let store = crash_report_store(app)?;
    let _lock = lock_state(&state.file_lock)?;
    let mut reports = read_reports(&store)?;
    let anchor = reports.iter().find(|report| report.id == id).cloned();
    let mut result = None;
    let mut changes = Vec::new();
    for report in &mut reports {
        if report.id == id {
            if report.status == from {
                report.status = status.to_string();
                changes.push(CrashReportStatusChange {
                    id: report.id.clone(),
                    status: report.status.clone(),
                });
            }
            result = Some(report.clone());
            continue;
        }
        if let Some(anchor) = &anchor {
            if anchor.status == from && is_related_crash_event(anchor, report) {
                report.status = "dismissed".to_string();
                changes.push(CrashReportStatusChange {
                    id: report.id.clone(),
                    status: report.status.clone(),
                });
            }
        }
    }
    // Skip a disk write when nothing transitioned so idempotent calls stay free.
    if !changes.is_empty() {
        append_journal_entry(&store, CrashReportJournalEntry::SetStatus { changes })?;
    }
    Ok(result)
}

struct CrashReportStore {
    snapshot: PathBuf,
    journal: PathBuf,
}

fn crash_report_store(app: &tauri::AppHandle) -> Result<CrashReportStore, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve Pebble app data directory: {error}"))?;
    Ok(CrashReportStore {
        snapshot: dir.join(CRASH_REPORTS_FILE),
        journal: dir.join(CRASH_REPORTS_JOURNAL_FILE),
    })
}

// Load = compacted snapshot + replayed journal; compacts opportunistically when the
// journal has grown, so an idle-then-reopen run heals fragmentation without a mutation.
fn read_reports(store: &CrashReportStore) -> Result<Vec<CrashReportRecord>, String> {
    let mut reports = read_snapshot(&store.snapshot)?;
    let entries = read_journal_entries(&store.journal)?;
    for entry in &entries {
        replay_journal_entry(&mut reports, entry);
    }
    if entries.len() > MAX_JOURNAL_ENTRIES {
        compact_store(store, &reports)?;
    }
    Ok(reports)
}

fn read_snapshot(path: &Path) -> Result<Vec<CrashReportRecord>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Could not read Pebble crash reports: {error}"))?;
    let file: CrashReportFile = serde_json::from_str(&contents)
        .map_err(|error| format!("Could not parse Pebble crash reports: {error}"))?;
    Ok(file.reports.into_iter().take(MAX_REPORTS).collect())
}

// Corrupt or partially-written lines (e.g. a crash mid-append) are dropped rather than
// surfaced as errors — crash reporting must never itself crash the app.
fn read_journal_entries(path: &Path) -> Result<Vec<CrashReportJournalEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(_) => return Ok(Vec::new()),
    };
    Ok(contents
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<CrashReportJournalEntry>(line).ok())
        .collect())
}

fn replay_journal_entry(reports: &mut Vec<CrashReportRecord>, entry: &CrashReportJournalEntry) {
    match entry {
        CrashReportJournalEntry::Insert { report } => {
            reports.insert(0, report.clone());
            reports.truncate(MAX_REPORTS);
        }
        CrashReportJournalEntry::SetStatus { changes } => {
            for change in changes {
                if let Some(report) = reports.iter_mut().find(|report| report.id == change.id) {
                    report.status = change.status.clone();
                }
            }
        }
    }
}

fn append_journal_entry(
    store: &CrashReportStore,
    entry: CrashReportJournalEntry,
) -> Result<(), String> {
    ensure_store_dir(store)?;
    let line = serde_json::to_string(&entry)
        .map_err(|error| format!("Could not encode Pebble crash report journal: {error}"))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&store.journal)
        .map_err(|error| format!("Could not open Pebble crash report journal: {error}"))?;
    use std::io::Write;
    file.write_all(format!("{line}\n").as_bytes())
        .map_err(|error| format!("Could not append Pebble crash report journal: {error}"))?;
    Ok(())
}

// Rewrite the snapshot atomically (tmp + rename) then drop the journal, matching the
// original crash-report durability guarantee for the compacted state.
fn compact_store(store: &CrashReportStore, reports: &[CrashReportRecord]) -> Result<(), String> {
    write_snapshot(&store.snapshot, reports)?;
    if store.journal.exists() {
        fs::remove_file(&store.journal)
            .map_err(|error| format!("Could not truncate Pebble crash report journal: {error}"))?;
    }
    Ok(())
}

fn ensure_store_dir(store: &CrashReportStore) -> Result<(), String> {
    let parent = store
        .snapshot
        .parent()
        .ok_or_else(|| "Could not resolve Pebble crash report directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Pebble crash report directory: {error}"))
}

fn write_snapshot(path: &Path, reports: &[CrashReportRecord]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve Pebble crash report directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Pebble crash report directory: {error}"))?;
    let tmp_path = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        Uuid::new_v4()
    ));
    let contents = serde_json::to_string_pretty(&CrashReportFile {
        reports: reports.to_vec(),
    })
    .map_err(|error| format!("Could not encode Pebble crash reports: {error}"))?;
    fs::write(&tmp_path, format!("{contents}\n"))
        .map_err(|error| format!("Could not write Pebble crash reports: {error}"))?;
    fs::rename(&tmp_path, path)
        .map_err(|error| format!("Could not replace Pebble crash reports: {error}"))?;
    Ok(())
}

async fn post_crash_feedback(
    input: &CrashReportSubmitInput,
    feedback: String,
    diagnostic_bundle: Option<FeedbackDiagnosticBundleAttachment>,
) -> Result<(), (Option<u16>, String)> {
    let anonymous = input.submit_anonymously.unwrap_or(false);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FEEDBACK_REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| (None, error.to_string()))?;
    let request = client.post(FEEDBACK_API_URL);
    let response = if let Some(diagnostic_bundle) = diagnostic_bundle {
        let form = create_feedback_multipart_form(
            feedback,
            CrashFeedbackIdentity {
                app_version: &input.app_version,
                github_login: input.github_login.as_deref(),
                github_email: input.github_email.as_deref(),
                submit_anonymously: anonymous,
            },
            diagnostic_bundle,
        )
        .map_err(|error| (None, error))?;
        request
            .multipart(form)
            .send()
            .await
            .map_err(|error| (None, error.to_string()))?
    } else {
        let body = json!({
            "feedback": feedback,
            "submissionType": "crash",
            "githubLogin": if anonymous { None } else { input.github_login.clone() },
            "githubEmail": if anonymous { None } else { input.github_email.clone() },
            "appVersion": input.app_version,
            "platform": current_node_platform(),
            "osRelease": current_os_release(),
            "arch": current_node_arch(),
        });
        request
            .json(&body)
            .send()
            .await
            .map_err(|error| (None, error.to_string()))?
    };
    if response.status().is_success() {
        Ok(())
    } else {
        Err((
            Some(response.status().as_u16()),
            format!("status {}", response.status().as_u16()),
        ))
    }
}

fn mark_submission_started(state: &CrashReportsState, report_id: &str) -> Result<bool, String> {
    let mut submissions = lock_state(&state.in_flight_submissions)?;
    if submissions.contains(report_id) {
        return Ok(false);
    }
    submissions.insert(report_id.to_string());
    Ok(true)
}

fn mark_submission_finished(state: &CrashReportsState, report_id: &str) -> Result<(), String> {
    lock_state(&state.in_flight_submissions)?.remove(report_id);
    Ok(())
}

fn remember_submitted_report_id(state: &CrashReportsState, report_id: &str) -> Result<(), String> {
    let mut submitted = lock_state(&state.submitted_report_ids)?;
    submitted.retain(|id| id != report_id);
    submitted.push(report_id.to_string());
    while submitted.len() > 256 {
        submitted.remove(0);
    }
    Ok(())
}

fn is_recent_renderer_error_duplicate(
    state: &CrashReportsState,
    key: &str,
) -> Result<bool, String> {
    let now = current_time_millis();
    let mut keys = lock_state(&state.recent_renderer_error_report_keys)?;
    keys.retain(|_, seen_at| now.saturating_sub(*seen_at) <= MAX_RENDERER_ERROR_KEY_AGE_MS);
    if now.saturating_sub(*keys.get(key).unwrap_or(&0)) < RENDERER_ERROR_DEDUPE_MS {
        return Ok(true);
    }
    keys.insert(key.to_string(), now);
    while keys.len() > 256 {
        if let Some(oldest) = keys
            .iter()
            .min_by_key(|(_, seen_at)| **seen_at)
            .map(|(key, _)| key.clone())
        {
            keys.remove(&oldest);
        } else {
            break;
        }
    }
    Ok(false)
}

fn renderer_error_report_key(input: &NormalizedRendererErrorInput) -> String {
    json!({
        "boundaryId": input.boundary_id,
        "surface": input.surface,
        "errorName": input.error_name,
        "errorMessage": input.error_message,
        "componentStack": input.component_stack,
    })
    .to_string()
    .chars()
    .take(12_000)
    .collect()
}

fn is_related_crash_event(anchor: &CrashReportRecord, candidate: &CrashReportRecord) -> bool {
    if anchor.id == candidate.id || candidate.status != "pending" {
        return false;
    }
    let anchor_time = parse_iso_millis(&anchor.created_at);
    let candidate_time = parse_iso_millis(&candidate.created_at);
    match (anchor_time, candidate_time) {
        (Some(anchor_time), Some(candidate_time)) => {
            (anchor_time - candidate_time).abs() <= RELATED_CRASH_WINDOW_MS
                && anchor.reason == candidate.reason
                && anchor.exit_code == candidate.exit_code
                && anchor.app_version == candidate.app_version
                && anchor.platform == candidate.platform
        }
        _ => false,
    }
}

fn sanitize_breadcrumb(input: CrashReportBreadcrumbInput) -> Option<CrashReportBreadcrumb> {
    let name = optional_string(input.name, MAX_BREADCRUMB_NAME_LENGTH)?;
    Some(CrashReportBreadcrumb {
        created_at: current_iso_timestamp(),
        name,
        data: input.data.and_then(sanitize_breadcrumb_data),
    })
}

fn sanitize_breadcrumbs(
    breadcrumbs: Option<Vec<CrashReportBreadcrumb>>,
) -> Option<Vec<CrashReportBreadcrumb>> {
    let sanitized: Vec<CrashReportBreadcrumb> = breadcrumbs?
        .into_iter()
        .rev()
        .take(MAX_BREADCRUMBS)
        .filter(|breadcrumb| {
            !breadcrumb.name.trim().is_empty() && !breadcrumb.created_at.trim().is_empty()
        })
        .map(|breadcrumb| CrashReportBreadcrumb {
            created_at: sanitize_crash_report_string(
                &breadcrumb.created_at,
                MAX_STRING_DETAIL_LENGTH,
            ),
            name: sanitize_crash_report_string(&breadcrumb.name, MAX_STRING_DETAIL_LENGTH)
                .chars()
                .take(MAX_BREADCRUMB_NAME_LENGTH)
                .collect(),
            data: breadcrumb
                .data
                .map(sanitize_details)
                .filter(|data| !data.is_empty()),
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if sanitized.is_empty() {
        None
    } else {
        Some(sanitized)
    }
}

fn sanitize_breadcrumb_data(value: Value) -> Option<Map<String, Value>> {
    match value {
        Value::Object(map) => {
            let sanitized = sanitize_details(map);
            if sanitized.is_empty() {
                None
            } else {
                Some(sanitized)
            }
        }
        _ => None,
    }
}

fn sanitize_details(details: Map<String, Value>) -> Map<String, Value> {
    details
        .into_iter()
        .filter_map(|(key, value)| sanitize_detail_value(&key, value).map(|value| (key, value)))
        .collect()
}

fn sanitize_detail_value(key: &str, value: Value) -> Option<Value> {
    match value {
        Value::String(value) => Some(Value::String(sanitize_crash_report_string(
            &value,
            max_detail_string_length_for_key(key),
        ))),
        Value::Number(_) | Value::Bool(_) | Value::Null => Some(value),
        _ => None,
    }
}

fn sanitize_crash_report_string(value: &str, max_length: usize) -> String {
    let mut sanitized = value.to_string();
    let replacements = [
        (r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b", "[redacted-secret]"),
        (r"\bsk-[A-Za-z0-9_-]{20,}\b", "[redacted-secret]"),
        (
            r"[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@",
            "[redacted-credential]@",
        ),
        (
            r"(?i)\b(token|api[_-]?key|secret|password)=([^&\s]+)",
            "$1=[redacted]",
        ),
        (r#"/(?:Users|home)/[^\s"'`<>\n\r)]+"#, "[redacted-path]"),
        (r#"[A-Za-z]:\\[^\s"'`<>\n\r)]+"#, "[redacted-path]"),
        (
            r#"\\\\[^\\\s"'`<>\n\r)]+\\[^\s"'`<>\n\r)]+"#,
            "[redacted-path]",
        ),
    ];
    for (pattern, replacement) in replacements {
        if let Ok(regex) = Regex::new(pattern) {
            sanitized = regex.replace_all(&sanitized, replacement).to_string();
        }
    }
    truncate_chars(&sanitized, max_length)
}

fn max_detail_string_length_for_key(key: &str) -> usize {
    if key.eq_ignore_ascii_case("stack")
        || key.to_ascii_lowercase().ends_with("_stack")
        || key.eq_ignore_ascii_case("component_stack")
        || key.eq_ignore_ascii_case("error_stack")
    {
        MAX_STACK_DETAIL_LENGTH
    } else {
        MAX_STRING_DETAIL_LENGTH
    }
}

fn format_crash_report_text(
    report: &CrashReportRecord,
    notes: Option<&str>,
    diagnostic_bundle: Option<&CrashReportDiagnosticBundle>,
) -> String {
    let mut lines = vec![
        "[Crash Report]".to_string(),
        String::new(),
        format!("Report ID: {}", report.id),
        format!("Created: {}", report.created_at),
        format!("Status: {}", report.status),
        format!("Source: {}", report.source),
        format!("Process: {}", report.process_type),
        format!("Reason: {}", report.reason),
        format!(
            "Exit code: {}",
            report
                .exit_code
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ),
        format!("App version: {}", report.app_version),
        format!(
            "Platform: {} {} {}",
            report.platform, report.os_release, report.arch
        ),
        format_desktop_shell_line(&report.electron_version),
        format!("Chrome: {}", report.chrome_version),
    ];
    append_diagnostic_bundle_lines(&mut lines, diagnostic_bundle);
    if !report.details.is_empty() {
        lines.push(String::new());
        lines.push("Details:".to_string());
        for (key, value) in &report.details {
            lines.push(format!("- {key}: {}", detail_value_to_string(value)));
        }
    }
    if let Some(breadcrumbs) = &report.breadcrumbs {
        if !breadcrumbs.is_empty() {
            lines.push(String::new());
            lines.push("Recent activity:".to_string());
            for breadcrumb in breadcrumbs {
                lines.push(format_breadcrumb_line(breadcrumb));
            }
        }
    }
    append_notes(&mut lines, notes);
    truncate_formatted_report(&lines.join("\n"))
}

fn format_uncaptured_crash_report_text(
    notes: Option<&str>,
    app_version: &str,
    chrome_version: Option<&str>,
    diagnostic_bundle: Option<&CrashReportDiagnosticBundle>,
) -> String {
    let mut lines = vec![
        "[Crash Report]".to_string(),
        String::new(),
        "Report ID: not captured".to_string(),
        format!("Created: {}", current_iso_timestamp()),
        "Status: uncaptured".to_string(),
        "Source: user-reported".to_string(),
        "Process: unknown".to_string(),
        "Reason: no captured crash report".to_string(),
        "Exit code: unknown".to_string(),
        format!(
            "App version: {}",
            sanitize_crash_report_string(app_version, 120)
        ),
        format!(
            "Platform: {} {} {}",
            current_node_platform(),
            current_os_release(),
            current_node_arch()
        ),
        format_desktop_shell_line(TAURI_ELECTRON_VERSION_SENTINEL),
        format!(
            "Chrome: {}",
            chrome_version
                .map(|value| sanitize_crash_report_string(value, 120))
                .unwrap_or_else(|| "unknown".to_string())
        ),
        String::new(),
        "Details:".to_string(),
        "- captured_crash_report: false".to_string(),
        "- report_source: help_menu".to_string(),
    ];
    append_diagnostic_bundle_lines(&mut lines, diagnostic_bundle);
    append_notes(&mut lines, notes);
    truncate_formatted_report(&lines.join("\n"))
}

fn append_diagnostic_bundle_lines(
    lines: &mut Vec<String>,
    diagnostic_bundle: Option<&CrashReportDiagnosticBundle>,
) {
    if let Some(diagnostic_bundle) = diagnostic_bundle {
        lines.push(String::new());
        lines.push("Diagnostic log:".to_string());
        match diagnostic_bundle.status() {
            "attached" => {
                lines.push("- Status: attached".to_string());
                if let Some(bundle_submission_id) = diagnostic_bundle.bundle_submission_id() {
                    lines.push(format!(
                        "- Bundle submission ID: {}",
                        sanitize_crash_report_string(
                            bundle_submission_id,
                            MAX_STRING_DETAIL_LENGTH
                        )
                    ));
                }
            }
            "uploaded" => {
                lines.push("- Status: uploaded".to_string());
                if let Some(ticket_id) = diagnostic_bundle.ticket_id() {
                    lines.push(format!(
                        "- Ticket ID: {}",
                        sanitize_crash_report_string(ticket_id, MAX_STRING_DETAIL_LENGTH)
                    ));
                }
                if let Some(bundle_submission_id) = diagnostic_bundle.bundle_submission_id() {
                    lines.push(format!(
                        "- Bundle submission ID: {}",
                        sanitize_crash_report_string(
                            bundle_submission_id,
                            MAX_STRING_DETAIL_LENGTH
                        )
                    ));
                }
            }
            _ => {
                lines.push("- Status: not uploaded".to_string());
                if let Some(reason) = diagnostic_bundle.reason() {
                    lines.push(format!(
                        "- Reason: {}",
                        sanitize_crash_report_string(reason, MAX_STRING_DETAIL_LENGTH)
                    ));
                }
            }
        }
        if let Some(span_count) = diagnostic_bundle.span_count() {
            lines.push(format!("- Spans: {span_count}"));
        }
        if let Some(bytes) = diagnostic_bundle.bytes() {
            lines.push(format!("- Bytes: {bytes}"));
        }
    }
}

fn format_desktop_shell_line(electron_version: &str) -> String {
    if electron_version == TAURI_ELECTRON_VERSION_SENTINEL {
        "Desktop shell: Tauri".to_string()
    } else {
        format!("Electron: {electron_version}")
    }
}

fn append_notes(lines: &mut Vec<String>, notes: Option<&str>) {
    if let Some(notes) =
        notes.and_then(|value| optional_string(value.to_string(), MAX_STRING_DETAIL_LENGTH))
    {
        lines.push(String::new());
        lines.push("User notes:".to_string());
        lines.push(notes);
    }
}

fn format_breadcrumb_line(breadcrumb: &CrashReportBreadcrumb) -> String {
    let suffix = breadcrumb
        .data
        .as_ref()
        .filter(|data| !data.is_empty())
        .map(|data| {
            format!(
                " ({})",
                data.iter()
                    .map(|(key, value)| format!("{key}={}", detail_value_to_string(value)))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .unwrap_or_default();
    format!("- {}: {}{}", breadcrumb.created_at, breadcrumb.name, suffix)
}

fn detail_value_to_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => "null".to_string(),
        _ => String::new(),
    }
}

fn truncate_formatted_report(text: &str) -> String {
    if text.chars().count() <= MAX_FORMATTED_REPORT_LENGTH {
        return text.to_string();
    }
    let budget = MAX_FORMATTED_REPORT_LENGTH - FORMATTED_REPORT_TRUNCATION_SUFFIX.chars().count();
    format!(
        "{}{FORMATTED_REPORT_TRUNCATION_SUFFIX}",
        truncate_chars(text, budget).trim_end()
    )
}

fn insert_optional_string(
    map: &mut Map<String, Value>,
    key: &str,
    value: Option<String>,
    max: usize,
) {
    if let Some(value) = value.and_then(|value| optional_string(value, max)) {
        map.insert(key.to_string(), Value::String(value));
    }
}

fn normalize_nullable_string(value: Option<Value>, max: usize) -> Option<Value> {
    match value {
        Some(Value::Null) => Some(Value::Null),
        Some(Value::String(value)) => optional_string(value, max).map(Value::String),
        _ => None,
    }
}

fn required_string(value: String, max: usize, error: &str) -> Result<String, String> {
    optional_string(value, max).ok_or_else(|| error.to_string())
}

fn optional_string(value: String, max: usize) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(truncate_chars(trimmed, max))
    }
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    format!("{}...", value.chars().take(max).collect::<String>())
}

fn is_react_error_boundary_surface(surface: &str) -> bool {
    matches!(
        surface,
        "app-root"
            | "web-root"
            | "workspace-shell"
            | "sidebar"
            | "terminal-workbench"
            | "right-sidebar"
            | "page"
            | "modal"
            | "overlay"
            | "rich-markdown-editor"
    )
}

fn current_iso_timestamp() -> String {
    let now: DateTime<Utc> = SystemTime::now().into();
    now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse_iso_millis(value: &str) -> Option<i128> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis() as i128)
}

fn current_time_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn current_node_platform() -> String {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
    .to_string()
}

fn current_node_arch() -> String {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
    .to_string()
}

fn current_os_release() -> String {
    #[cfg(windows)]
    {
        command_stdout("cmd", &["/C", "ver"]).unwrap_or_else(|| "unknown".to_string())
    }
    #[cfg(not(windows))]
    {
        command_stdout("uname", &["-r"]).unwrap_or_else(|| "unknown".to_string())
    }
}

fn command_stdout(command: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(command).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    optional_string(text, 120)
}

fn lock_state<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Pebble crash report state lock was poisoned.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_main_and_browser_web_content_crashes() {
        assert_eq!(web_content_crash_source("main"), "renderer");
        assert_eq!(web_content_crash_source("browser-page-1"), "child");
    }

    #[test]
    fn sanitizes_secrets_and_paths() {
        let value = sanitize_crash_report_string(
            "token=abc123 /Users/alice/project ghp_123456789012345678901234",
            240,
        );
        assert!(value.contains("token=[redacted]"));
        assert!(value.contains("[redacted-path]"));
        assert!(value.contains("[redacted-secret]"));
    }

    #[test]
    fn rejects_unknown_renderer_surfaces() {
        let input = CrashReportRendererErrorInput {
            boundary_id: "right-sidebar".to_string(),
            surface: "unknown".to_string(),
            error_name: "Error".to_string(),
            error_message: "boom".to_string(),
            error_stack: None,
            component_stack: None,
            active_view: None,
            active_modal: None,
            active_tab_type: None,
            active_right_sidebar_tab: None,
            has_active_worktree: None,
            app_version: "1.0.0".to_string(),
            chrome_version: Some("1".to_string()),
        };
        assert!(normalize_renderer_error_input(input).is_err());
    }

    fn temp_store(tag: &str) -> CrashReportStore {
        let dir = std::env::temp_dir().join(format!(
            "pebble-crash-store-{}-{}-{}",
            tag,
            std::process::id(),
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create temp store dir");
        CrashReportStore {
            snapshot: dir.join(CRASH_REPORTS_FILE),
            journal: dir.join(CRASH_REPORTS_JOURNAL_FILE),
        }
    }

    fn sample_report(id: &str) -> CrashReportRecord {
        CrashReportRecord {
            id: id.to_string(),
            created_at: "2024-01-01T00:00:00.000Z".to_string(),
            status: "pending".to_string(),
            source: "renderer".to_string(),
            process_type: "react-render".to_string(),
            reason: "react-error-boundary".to_string(),
            exit_code: None,
            app_version: "1.0.0".to_string(),
            platform: "darwin".to_string(),
            os_release: "test".to_string(),
            arch: "arm64".to_string(),
            electron_version: TAURI_ELECTRON_VERSION_SENTINEL.to_string(),
            chrome_version: "unknown".to_string(),
            details: Map::new(),
            breadcrumbs: None,
        }
    }

    #[test]
    fn formats_tauri_shell_without_claiming_electron() {
        assert_eq!(
            format_desktop_shell_line(TAURI_ELECTRON_VERSION_SENTINEL),
            "Desktop shell: Tauri"
        );
        assert_eq!(format_desktop_shell_line("42.3.3"), "Electron: 42.3.3");
    }

    #[test]
    fn sanitizes_rust_panic_payloads_before_persistence() {
        let borrowed: &(dyn Any + Send) = &"token=secret\nline two";
        assert_eq!(
            panic_payload_message(borrowed),
            "token=[redacted]\nline two"
        );
        let owned: &(dyn Any + Send) = &"owned panic".to_string();
        assert_eq!(panic_payload_message(owned), "owned panic");
        let numeric: &(dyn Any + Send) = &42_u32;
        assert_eq!(panic_payload_message(numeric), "non-string panic payload");
        let (reason, details) = native_panic_record(
            borrowed,
            Some("tauri-main"),
            Some(("packages/product-core/main.rs", 42, 7)),
        );
        assert_eq!(reason, "token=[redacted]\nline two");
        assert_eq!(details["thread"], "tauri-main");
        assert_eq!(details["location"], "packages/product-core/main.rs:42:7");
    }

    #[test]
    fn suppresses_only_the_immediate_same_thread_cannot_unwind_cascade() {
        let now = Instant::now();
        let recent = RecentNativePanic {
            recorded_at: now,
            thread_name: "main".to_string(),
        };
        assert!(is_secondary_cannot_unwind(
            CANNOT_UNWIND_REASON,
            "main",
            Some(&recent),
            now + Duration::from_millis(10)
        ));
        assert!(!is_secondary_cannot_unwind(
            "specific setup failure",
            "main",
            Some(&recent),
            now + Duration::from_millis(10)
        ));
        assert!(!is_secondary_cannot_unwind(
            CANNOT_UNWIND_REASON,
            "worker",
            Some(&recent),
            now + Duration::from_millis(10)
        ));
        assert!(!is_secondary_cannot_unwind(
            CANNOT_UNWIND_REASON,
            "main",
            Some(&recent),
            now + SECONDARY_CANNOT_UNWIND_WINDOW + Duration::from_millis(1)
        ));
    }

    #[test]
    fn appends_without_rewriting_snapshot() {
        let store = temp_store("append");
        append_journal_entry(
            &store,
            CrashReportJournalEntry::Insert {
                report: sample_report("a"),
            },
        )
        .expect("append insert");
        // The snapshot must stay untouched by an append — only the journal grows.
        assert!(!store.snapshot.exists());
        assert!(store.journal.exists());
        let reports = read_reports(&store).expect("read after append");
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].id, "a");
    }

    #[test]
    fn replays_journal_over_snapshot_after_reopen() {
        let store = temp_store("replay");
        write_snapshot(&store.snapshot, &[sample_report("base")]).expect("seed snapshot");
        append_journal_entry(
            &store,
            CrashReportJournalEntry::Insert {
                report: sample_report("newer"),
            },
        )
        .expect("append insert");
        append_journal_entry(
            &store,
            CrashReportJournalEntry::SetStatus {
                changes: vec![CrashReportStatusChange {
                    id: "base".to_string(),
                    status: "dismissed".to_string(),
                }],
            },
        )
        .expect("append status");

        // Simulate a fresh process: read from paths only.
        let reopened = CrashReportStore {
            snapshot: store.snapshot.clone(),
            journal: store.journal.clone(),
        };
        let reports = read_reports(&reopened).expect("read after reopen");
        assert_eq!(reports.len(), 2);
        assert_eq!(reports[0].id, "newer");
        assert_eq!(reports[1].id, "base");
        assert_eq!(reports[1].status, "dismissed");
    }

    #[test]
    fn ignores_corrupt_trailing_journal_line() {
        let store = temp_store("corrupt");
        append_journal_entry(
            &store,
            CrashReportJournalEntry::Insert {
                report: sample_report("good"),
            },
        )
        .expect("append insert");
        // Mimic a crash mid-append leaving a truncated JSON line.
        let mut existing = fs::read_to_string(&store.journal).expect("read journal");
        existing.push_str("{\"op\":\"insert\",\"report\":{\"id\":\"tru");
        fs::write(&store.journal, existing).expect("write corrupt journal");

        let reports = read_reports(&store).expect("read past corruption");
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].id, "good");
    }

    #[test]
    fn compacts_when_journal_exceeds_bound() {
        let store = temp_store("compact");
        write_snapshot(&store.snapshot, &[sample_report("base")]).expect("seed snapshot");
        // One extra past the bound so read_reports triggers compaction.
        for index in 0..=MAX_JOURNAL_ENTRIES {
            append_journal_entry(
                &store,
                CrashReportJournalEntry::SetStatus {
                    changes: vec![CrashReportStatusChange {
                        id: "base".to_string(),
                        status: if index % 2 == 0 { "dismissed" } else { "sent" }.to_string(),
                    }],
                },
            )
            .expect("append status");
        }

        let reports = read_reports(&store).expect("read triggers compaction");
        assert_eq!(reports.len(), 1);
        // Last write wins; MAX_JOURNAL_ENTRIES (64) is even → final status "dismissed".
        assert_eq!(reports[0].status, "dismissed");
        // Journal is folded into the snapshot and removed.
        assert!(!store.journal.exists());
        assert!(store.snapshot.exists());
        // The compacted snapshot alone reproduces the same state.
        let after = read_reports(&store).expect("read after compaction");
        assert_eq!(after[0].status, "dismissed");
    }
}
