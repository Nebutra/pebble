use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::{SecondsFormat, Utc};
use regex::Regex;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::Manager;
use uuid::Uuid;

const TRACE_FILE_NAME: &str = "main.trace.ndjson";
const CRASH_REPORTS_FILE: &str = "crash-reports.json";
const PREVIEW_DIRECTORY_NAME: &str = "pebble-diagnostic-bundle-previews";
const DEFAULT_MAX_FILES: usize = 10;
const MAX_BUNDLE_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_LOOKBACK_MINUTES: u64 = 30;
const CRASH_REPORT_LOG_LOOKBACK_MINUTES: u64 = 3 * 24 * 60;
const MAX_PENDING_BUNDLES: usize = 8;
const PENDING_BUNDLE_TTL_MS: u128 = 15 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_SECONDS: u64 = 10;
const UPLOAD_REQUEST_TIMEOUT_SECONDS: u64 = 30;
const DIAGNOSTIC_BUNDLE_CONTENT_TYPE: &str = "application/x-ndjson";

#[derive(Default)]
pub struct DiagnosticsState {
    pending_bundles: Mutex<HashMap<String, PendingDiagnosticBundle>>,
}

#[derive(Debug, Clone)]
struct PendingDiagnosticBundle {
    payload: String,
    bytes: usize,
    span_count: usize,
    preview_file_path: PathBuf,
    created_at_ms: u128,
    preview_opened: bool,
}

#[derive(Debug, Clone)]
struct CollectedDiagnosticBundle {
    bundle_submission_id: String,
    payload: String,
    bytes: usize,
    span_count: usize,
}

#[derive(Debug, Clone)]
pub struct FeedbackDiagnosticBundleAttachment {
    pub bundle_submission_id: String,
    pub content: String,
    pub bytes: usize,
    pub span_count: usize,
}

#[derive(Debug, Clone)]
pub struct CrashDiagnosticBundleAttachment {
    pub diagnostic_bundle: CrashReportDiagnosticBundle,
    pub feedback_diagnostic_bundle: Option<FeedbackDiagnosticBundleAttachment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportDiagnosticBundle {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ticket_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bundle_submission_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    span_count: Option<usize>,
}

impl CrashReportDiagnosticBundle {
    pub fn status(&self) -> &str {
        &self.status
    }

    pub fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }

    pub fn ticket_id(&self) -> Option<&str> {
        self.ticket_id.as_deref()
    }

    pub fn bundle_submission_id(&self) -> Option<&str> {
        self.bundle_submission_id.as_deref()
    }

    pub fn bytes(&self) -> Option<usize> {
        self.bytes
    }

    pub fn span_count(&self) -> Option<usize> {
        self.span_count
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsCollectInput {
    lookback_minutes: Option<u64>,
    app_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsBundleIdInput {
    bundle_submission_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsDeleteInput {
    ticket_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsStatusPayload {
    local_file_enabled: bool,
    bundle_enabled: bool,
    trace_file_path: String,
    trace_family_size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    disabled_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsBundlePayload {
    bundle_submission_id: String,
    bytes: usize,
    span_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum DiagnosticsUploadPayload {
    Ticket {
        #[serde(rename = "ticketId")]
        ticket_id: String,
    },
    Canceled {
        canceled: bool,
    },
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    token: String,
    upload_url: String,
    max_bytes: usize,
}

#[derive(Debug, Deserialize)]
struct UploadResponse {
    ticket_id: String,
}

// Why: sync commands run on the Tauri main thread; trace-file reads and
// process spawns below can block for seconds, so bodies run in spawn_blocking.
#[tauri::command]
pub async fn diagnostics_get_status(
    app: tauri::AppHandle,
) -> Result<DiagnosticsStatusPayload, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_diagnostics_status(&app))
        .await
        .map_err(|error| format!("Diagnostics status task failed: {error}"))?
}

#[tauri::command]
pub async fn diagnostics_collect_bundle(
    app: tauri::AppHandle,
    state: tauri::State<'_, DiagnosticsState>,
    input: DiagnosticsCollectInput,
) -> Result<DiagnosticsBundlePayload, String> {
    let (bundle, preview_file_path) = tauri::async_runtime::spawn_blocking(move || {
        let status = resolve_diagnostics_status(&app)?;
        if !status.bundle_enabled {
            return Err("creating review files is disabled".to_string());
        }
        let lookback_minutes = normalize_lookback_minutes(input.lookback_minutes);
        let bundle = collect_diagnostic_bundle(&app, &input.app_version, lookback_minutes)?;
        let preview_file_path = write_bundle_preview_file(&bundle)?;
        Ok((bundle, preview_file_path))
    })
    .await
    .map_err(|error| format!("Diagnostics collect task failed: {error}"))??;
    remember_pending_bundle(&state, &bundle, preview_file_path)?;
    Ok(to_bundle_payload(&bundle))
}

#[tauri::command]
pub async fn diagnostics_open_bundle_preview(
    state: tauri::State<'_, DiagnosticsState>,
    input: DiagnosticsBundleIdInput,
) -> Result<(), String> {
    let preview_file_path = get_pending_preview_file_path(&state, &input.bundle_submission_id)?;
    let opened =
        tauri::async_runtime::spawn_blocking(move || open_with_system_default(&preview_file_path))
            .await
            .map_err(|error| format!("Diagnostics preview task failed: {error}"))?;
    if !opened {
        return Err("could not open review file".to_string());
    }
    if let Some(pending) = lock_state(&state.pending_bundles)?.get_mut(&input.bundle_submission_id)
    {
        pending.preview_opened = true;
    }
    Ok(())
}

#[tauri::command]
pub fn diagnostics_discard_bundle_preview(
    state: tauri::State<DiagnosticsState>,
    input: DiagnosticsBundleIdInput,
) -> Result<(), String> {
    delete_pending_bundle(&state, &input.bundle_submission_id)
}

#[tauri::command]
pub async fn diagnostics_upload_bundle(
    app: tauri::AppHandle,
    state: tauri::State<'_, DiagnosticsState>,
    input: DiagnosticsBundleIdInput,
) -> Result<DiagnosticsUploadPayload, String> {
    let pending = get_pending_bundle_for_upload(&state, &input.bundle_submission_id)?;
    if !resolve_diagnostics_status(&app)?.bundle_enabled {
        return Err("sending diagnostics is disabled".to_string());
    }
    if !confirm_bundle_upload(&pending) {
        return Ok(DiagnosticsUploadPayload::Canceled { canceled: true });
    }

    let pending = get_pending_bundle_for_upload(&state, &input.bundle_submission_id)?;
    if !resolve_diagnostics_status(&app)?.bundle_enabled {
        return Err("sending diagnostics is disabled".to_string());
    }
    let token_endpoint = resolve_diagnostic_token_endpoint()
        .ok_or_else(|| "sending diagnostics is not configured for this build".to_string())?;
    let ticket_id = upload_diagnostic_bundle(&token_endpoint, &pending).await?;
    delete_pending_bundle(&state, &input.bundle_submission_id)?;
    Ok(DiagnosticsUploadPayload::Ticket { ticket_id })
}

#[tauri::command]
pub async fn diagnostics_delete_bundle(input: DiagnosticsDeleteInput) -> Result<(), String> {
    if !is_bundle_identifier(&input.ticket_id) {
        return Err("ticketId has invalid format".to_string());
    }
    let token_endpoint = resolve_diagnostic_token_endpoint()
        .ok_or_else(|| "diagnostic upload endpoint is not configured for this build".to_string())?;
    delete_remote_diagnostic_bundle(&token_endpoint, &input.ticket_id).await
}

pub fn collect_crash_diagnostic_bundle_attachment(
    app: &tauri::AppHandle,
    include_diagnostic_logs: Option<bool>,
    app_version: &str,
) -> CrashDiagnosticBundleAttachment {
    if include_diagnostic_logs == Some(false) {
        return skipped_crash_diagnostic_bundle();
    }

    match resolve_diagnostics_status(app) {
        Ok(status) if status.bundle_enabled => {}
        Ok(status) => {
            return not_uploaded_crash_diagnostic_bundle(
                status
                    .disabled_reason
                    .as_deref()
                    .unwrap_or("diagnostic bundle collection is disabled"),
            );
        }
        Err(error) => return not_uploaded_crash_diagnostic_bundle(&error),
    }

    match collect_diagnostic_bundle(app, app_version, CRASH_REPORT_LOG_LOOKBACK_MINUTES) {
        Ok(bundle) => CrashDiagnosticBundleAttachment {
            diagnostic_bundle: attached_crash_diagnostic_bundle(&bundle),
            feedback_diagnostic_bundle: Some(FeedbackDiagnosticBundleAttachment {
                bundle_submission_id: bundle.bundle_submission_id,
                content: bundle.payload,
                bytes: bundle.bytes,
                span_count: bundle.span_count,
            }),
        },
        Err(error) => not_uploaded_crash_diagnostic_bundle(&error),
    }
}

fn resolve_diagnostics_status(app: &tauri::AppHandle) -> Result<DiagnosticsStatusPayload, String> {
    let consent = resolve_observability_consent();
    let trace_file_path = trace_file_path(app)?;
    let trace_family_size = if consent.local_file_enabled {
        get_rotated_family_size(&trace_file_path)
    } else {
        0
    };
    Ok(DiagnosticsStatusPayload {
        local_file_enabled: consent.local_file_enabled,
        bundle_enabled: consent.bundle_enabled,
        trace_file_path: trace_file_path.to_string_lossy().into_owned(),
        trace_family_size,
        disabled_reason: consent.disabled_reason.map(str::to_string),
    })
}

struct ObservabilityConsent {
    local_file_enabled: bool,
    bundle_enabled: bool,
    disabled_reason: Option<&'static str>,
}

fn resolve_observability_consent() -> ObservabilityConsent {
    if in_ci() {
        return ObservabilityConsent {
            local_file_enabled: false,
            bundle_enabled: false,
            disabled_reason: Some("ci"),
        };
    }
    if env_on("PEBBLE_DIAGNOSTICS_DISABLED") {
        return ObservabilityConsent {
            local_file_enabled: false,
            bundle_enabled: false,
            disabled_reason: Some("pebble_diagnostics_disabled"),
        };
    }
    if env_on("DO_NOT_TRACK") || env_on("PEBBLE_TELEMETRY_DISABLED") {
        return ObservabilityConsent {
            local_file_enabled: true,
            bundle_enabled: false,
            disabled_reason: Some(if env_on("DO_NOT_TRACK") {
                "do_not_track"
            } else {
                "pebble_telemetry_disabled"
            }),
        };
    }
    ObservabilityConsent {
        local_file_enabled: true,
        bundle_enabled: true,
        disabled_reason: None,
    }
}

fn env_on(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            normalized == "1" || normalized == "true"
        })
        .unwrap_or(false)
}

fn in_ci() -> bool {
    [
        "CI",
        "GITHUB_ACTIONS",
        "GITLAB_CI",
        "CIRCLECI",
        "TRAVIS",
        "BUILDKITE",
        "JENKINS_URL",
        "TEAMCITY_VERSION",
    ]
    .iter()
    .any(|name| {
        std::env::var(name)
            .map(|value| !value.is_empty())
            .unwrap_or(false)
    })
}

fn collect_diagnostic_bundle(
    app: &tauri::AppHandle,
    app_version: &str,
    lookback_minutes: u64,
) -> Result<CollectedDiagnosticBundle, String> {
    let bundle_submission_id = create_bundle_submission_id();
    let header = json!({
        "type": "bundle-header",
        "bundle_submission_id": bundle_submission_id,
        "app_version": sanitize_bundle_string(app_version),
        "platform": current_node_platform(),
        "arch": current_node_arch(),
        "os_release": current_os_release(),
        "pebble_channel": resolve_diagnostic_pebble_channel(),
        "collected_at": current_iso_timestamp(),
        "schema_version": 1,
    });
    let mut builder = BundlePayloadBuilder::new(header)?;
    append_trace_family_records(&mut builder, &trace_file_path(app)?, lookback_minutes)?;
    append_tauri_diagnostic_records(app, &mut builder)?;
    let payload = builder.finish();
    Ok(CollectedDiagnosticBundle {
        bundle_submission_id,
        bytes: payload.as_bytes().len(),
        span_count: builder.record_count(),
        payload,
    })
}

struct BundlePayloadBuilder {
    lines: Vec<String>,
    bytes: usize,
    record_count: usize,
}

impl BundlePayloadBuilder {
    fn new(header: Value) -> Result<Self, String> {
        let header_line = serde_json::to_string(&header)
            .map_err(|error| format!("Could not encode diagnostic bundle: {error}"))?;
        let bytes = header_line.as_bytes().len() + 1;
        Ok(Self {
            lines: vec![header_line],
            bytes,
            record_count: 0,
        })
    }

    fn push_record(&mut self, record: Value) -> Result<(), String> {
        let redacted = redact_value(record, true);
        let line = serde_json::to_string(&redacted)
            .map_err(|error| format!("Could not encode diagnostic bundle: {error}"))?;
        let line_bytes = line.as_bytes().len() + 1;
        if line_bytes > MAX_BUNDLE_BYTES.saturating_sub(self.lines[0].as_bytes().len() + 1) {
            return Ok(());
        }
        if self.bytes + line_bytes > MAX_BUNDLE_BYTES {
            return Ok(());
        }
        self.lines.push(line);
        self.bytes += line_bytes;
        self.record_count += 1;
        Ok(())
    }

    fn record_count(&self) -> usize {
        self.record_count
    }

    fn finish(&self) -> String {
        format!("{}\n", self.lines.join("\n"))
    }
}

fn append_trace_family_records(
    builder: &mut BundlePayloadBuilder,
    trace_file_path: &Path,
    lookback_minutes: u64,
) -> Result<(), String> {
    let cutoff_nanos =
        (current_time_millis().saturating_sub(u128::from(lookback_minutes) * 60_000)) * 1_000_000;
    for path in list_rotated_files(trace_file_path) {
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.len() > 50 * 1024 * 1024 {
            continue;
        }
        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };
        for line in read_lines_newest_first(&contents) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if is_record_older_than_cutoff(&value, cutoff_nanos) {
                continue;
            }
            builder.push_record(value)?;
        }
    }
    Ok(())
}

fn append_tauri_diagnostic_records(
    app: &tauri::AppHandle,
    builder: &mut BundlePayloadBuilder,
) -> Result<(), String> {
    builder.push_record(json!({
        "type": "tauri-diagnostics-status",
        "collectedAt": current_iso_timestamp(),
        "status": resolve_diagnostics_status(app)?,
    }))?;

    let crash_report_path = crash_report_store_path(app)?;
    if !crash_report_path.exists() {
        return Ok(());
    }
    let contents = fs::read_to_string(&crash_report_path)
        .map_err(|error| format!("Could not read Pebble crash reports: {error}"))?;
    let parsed: Value = serde_json::from_str(&contents)
        .map_err(|error| format!("Could not parse Pebble crash reports: {error}"))?;
    builder.push_record(json!({
        "type": "tauri-crash-reports",
        "collectedAt": current_iso_timestamp(),
        "reports": parsed.get("reports").cloned().unwrap_or(Value::Array(Vec::new())),
    }))
}

fn is_record_older_than_cutoff(value: &Value, cutoff_nanos: u128) -> bool {
    value
        .get("endTimeUnixNano")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u128>().ok())
        .map(|value| value < cutoff_nanos)
        .unwrap_or(false)
}

fn read_lines_newest_first(text: &str) -> Vec<String> {
    text.lines()
        .rev()
        .map(|line| line.trim_end_matches('\r').to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

fn remember_pending_bundle(
    state: &DiagnosticsState,
    bundle: &CollectedDiagnosticBundle,
    preview_file_path: PathBuf,
) -> Result<(), String> {
    let mut pending = lock_state(&state.pending_bundles)?;
    prune_pending_bundles(&mut pending);
    pending.insert(
        bundle.bundle_submission_id.clone(),
        PendingDiagnosticBundle {
            payload: bundle.payload.clone(),
            bytes: bundle.bytes,
            span_count: bundle.span_count,
            preview_file_path,
            created_at_ms: current_time_millis(),
            preview_opened: false,
        },
    );
    prune_pending_bundles(&mut pending);
    Ok(())
}

fn get_pending_preview_file_path(
    state: &DiagnosticsState,
    bundle_submission_id: &str,
) -> Result<PathBuf, String> {
    if !is_bundle_identifier(bundle_submission_id) {
        return Err("bundleSubmissionId has invalid format".to_string());
    }
    let mut pending = lock_state(&state.pending_bundles)?;
    prune_pending_bundles(&mut pending);
    pending
        .get(bundle_submission_id)
        .map(|bundle| bundle.preview_file_path.clone())
        .ok_or_else(|| "review file has expired; create a new one before opening".to_string())
}

fn get_pending_bundle_for_upload(
    state: &DiagnosticsState,
    bundle_submission_id: &str,
) -> Result<PendingDiagnosticBundle, String> {
    if !is_bundle_identifier(bundle_submission_id) {
        return Err("bundleSubmissionId has invalid format".to_string());
    }
    let mut pending = lock_state(&state.pending_bundles)?;
    prune_pending_bundles(&mut pending);
    let bundle = pending
        .get(bundle_submission_id)
        .cloned()
        .ok_or_else(|| "review file has expired; create a new one before sending".to_string())?;
    if !bundle.preview_opened {
        return Err("open the review file before sending".to_string());
    }
    Ok(bundle)
}

fn delete_pending_bundle(
    state: &DiagnosticsState,
    bundle_submission_id: &str,
) -> Result<(), String> {
    if !is_bundle_identifier(bundle_submission_id) {
        return Err("bundleSubmissionId has invalid format".to_string());
    }
    let removed = lock_state(&state.pending_bundles)?.remove(bundle_submission_id);
    if let Some(bundle) = removed {
        let _ = fs::remove_file(bundle.preview_file_path);
    }
    Ok(())
}

fn prune_pending_bundles(pending: &mut HashMap<String, PendingDiagnosticBundle>) {
    let now = current_time_millis();
    let expired = pending
        .iter()
        .filter_map(|(id, bundle)| {
            (now.saturating_sub(bundle.created_at_ms) > PENDING_BUNDLE_TTL_MS).then(|| id.clone())
        })
        .collect::<Vec<_>>();
    for id in expired {
        if let Some(bundle) = pending.remove(&id) {
            let _ = fs::remove_file(bundle.preview_file_path);
        }
    }
    while pending.len() > MAX_PENDING_BUNDLES {
        let oldest = pending
            .iter()
            .min_by_key(|(_, bundle)| bundle.created_at_ms)
            .map(|(id, _)| id.clone());
        if let Some(id) = oldest {
            if let Some(bundle) = pending.remove(&id) {
                let _ = fs::remove_file(bundle.preview_file_path);
            }
        } else {
            break;
        }
    }
}

fn write_bundle_preview_file(bundle: &CollectedDiagnosticBundle) -> Result<PathBuf, String> {
    let directory = std::env::temp_dir().join(PREVIEW_DIRECTORY_NAME);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create diagnostics preview directory: {error}"))?;
    harden_private_path(&directory, true);
    let preview_file_path = directory.join(format!("{}.ndjson", bundle.bundle_submission_id));
    write_private_file(&preview_file_path, &bundle.payload)?;
    Ok(preview_file_path)
}

async fn upload_diagnostic_bundle(
    token_endpoint: &str,
    bundle: &PendingDiagnosticBundle,
) -> Result<String, String> {
    if bundle.bytes > MAX_BUNDLE_BYTES {
        return Err(format!("bundle exceeds 4 MiB cap ({} bytes)", bundle.bytes));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(UPLOAD_REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| error.to_string())?;
    let token_response = client
        .post(token_endpoint)
        .json(&json!({
            "bundle_submission_id": bundle_id_from_preview_path(&bundle.preview_file_path),
            "bytes": bundle.bytes,
        }))
        .timeout(Duration::from_secs(TOKEN_REQUEST_TIMEOUT_SECONDS))
        .send()
        .await
        .map_err(|_| "diagnostic network request failed".to_string())?;
    if !token_response.status().is_success() {
        return Err(format!("HTTP {}", token_response.status().as_u16()));
    }
    let token = token_response
        .json::<TokenResponse>()
        .await
        .map_err(|_| "malformed token response".to_string())?;
    if bundle.bytes > token.max_bytes {
        return Err(format!(
            "bundle exceeds server-issued cap ({} > {})",
            bundle.bytes, token.max_bytes
        ));
    }
    validate_upload_url(&token.upload_url, token_endpoint)?;
    let upload_response = client
        .post(&token.upload_url)
        .bearer_auth(token.token)
        .header("content-type", DIAGNOSTIC_BUNDLE_CONTENT_TYPE)
        .header("content-length", bundle.bytes.to_string())
        .body(bundle.payload.clone())
        .send()
        .await
        .map_err(|_| "diagnostic network request failed".to_string())?;
    if !upload_response.status().is_success() {
        return Err(format!("HTTP {}", upload_response.status().as_u16()));
    }
    let upload = upload_response
        .json::<UploadResponse>()
        .await
        .map_err(|_| "malformed upload response: missing ticket_id".to_string())?;
    if upload.ticket_id.trim().is_empty() {
        return Err("malformed upload response: missing ticket_id".to_string());
    }
    Ok(upload.ticket_id)
}

pub async fn delete_remote_diagnostic_bundle(
    token_endpoint: &str,
    ticket_id: &str,
) -> Result<(), String> {
    if !is_bundle_identifier(ticket_id) {
        return Err("ticketId has invalid format".to_string());
    }
    let endpoint = resolve_delete_endpoint(token_endpoint, ticket_id)?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(TOKEN_REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| error.to_string())?
        .post(endpoint)
        .json(&json!({}))
        .send()
        .await
        .map_err(|_| "diagnostic network request failed".to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("HTTP {}", response.status().as_u16()))
    }
}

pub fn resolve_diagnostic_token_endpoint() -> Option<String> {
    let build_identity = resolve_diagnostic_build_identity();
    let build_endpoint = option_env!("PEBBLE_DIAGNOSTICS_TOKEN_URL")
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if build_identity.is_some() {
        return build_endpoint;
    }
    std::env::var("PEBBLE_DIAGNOSTICS_TOKEN_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .or(build_endpoint)
}

fn resolve_diagnostic_build_identity() -> Option<&'static str> {
    option_env!("PEBBLE_BUILD_IDENTITY").filter(|value| *value == "stable" || *value == "rc")
}

fn resolve_diagnostic_pebble_channel() -> &'static str {
    resolve_diagnostic_build_identity().unwrap_or("dev")
}

fn validate_upload_url(upload_url: &str, token_endpoint: &str) -> Result<(), String> {
    let parsed_upload = reqwest::Url::parse(upload_url)
        .map_err(|_| "invalid upload_url from token endpoint".to_string())?;
    let parsed_token = reqwest::Url::parse(token_endpoint)
        .map_err(|_| "invalid tokenEndpoint configuration".to_string())?;
    if parsed_token.scheme() == "https" && parsed_upload.scheme() != "https" {
        return Err("upload_url must use https when tokenEndpoint is https".to_string());
    }
    if parsed_upload.scheme() != "https" && parsed_upload.scheme() != "http" {
        return Err("upload_url must use http(s)".to_string());
    }
    let upload_host = parsed_upload.host_str().map(|host| {
        format!(
            "{}:{}",
            host,
            parsed_upload.port_or_known_default().unwrap_or(0)
        )
    });
    let token_host = parsed_token.host_str().map(|host| {
        format!(
            "{}:{}",
            host,
            parsed_token.port_or_known_default().unwrap_or(0)
        )
    });
    if upload_host != token_host {
        return Err("upload_url host must match tokenEndpoint host".to_string());
    }
    Ok(())
}

fn resolve_delete_endpoint(token_endpoint: &str, ticket_id: &str) -> Result<String, String> {
    let parsed_token = reqwest::Url::parse(token_endpoint)
        .map_err(|_| "invalid tokenEndpoint configuration".to_string())?;
    parsed_token
        .join(&format!("/diagnostics/delete/{ticket_id}"))
        .map(|url| url.to_string())
        .map_err(|_| "invalid tokenEndpoint configuration".to_string())
}

pub fn create_feedback_multipart_form(
    feedback: String,
    input: CrashFeedbackIdentity<'_>,
    attachment: FeedbackDiagnosticBundleAttachment,
) -> Result<Form, String> {
    let part = Part::text(attachment.content)
        .file_name(format!(
            "pebble-diagnostics-{}.ndjson",
            attachment.bundle_submission_id
        ))
        .mime_str(DIAGNOSTIC_BUNDLE_CONTENT_TYPE)
        .map_err(|error| error.to_string())?;
    let mut form = Form::new()
        .text("feedback", feedback)
        .text("submissionType", "crash")
        .text("appVersion", input.app_version.to_string())
        .text("platform", current_node_platform())
        .text("osRelease", current_os_release())
        .text("arch", current_node_arch())
        .text(
            "diagnosticBundleSubmissionId",
            attachment.bundle_submission_id,
        )
        .text("diagnosticBundleBytes", attachment.bytes.to_string())
        .text(
            "diagnosticBundleSpanCount",
            attachment.span_count.to_string(),
        )
        .part("diagnosticBundleFile", part);
    if !input.submit_anonymously {
        if let Some(github_login) = input.github_login {
            form = form.text("githubLogin", github_login.to_string());
        }
        if let Some(github_email) = input.github_email {
            form = form.text("githubEmail", github_email.to_string());
        }
    }
    Ok(form)
}

pub struct CrashFeedbackIdentity<'a> {
    pub app_version: &'a str,
    pub github_login: Option<&'a str>,
    pub github_email: Option<&'a str>,
    pub submit_anonymously: bool,
}

fn confirm_bundle_upload(bundle: &PendingDiagnosticBundle) -> bool {
    matches!(
        rfd::MessageDialog::new()
            .set_title("Send this file to support?")
            .set_description(format!(
                "This uploads the redacted app diagnostics file you reviewed.\n\nDiagnostic ID: {}\nDiagnostic records: {}\nSize: {} KB",
                bundle_id_from_preview_path(&bundle.preview_file_path),
                bundle.span_count,
                (bundle.bytes + 1023) / 1024
            ))
            .set_buttons(rfd::MessageButtons::OkCancel)
            .show(),
        rfd::MessageDialogResult::Ok
    )
}

fn to_bundle_payload(bundle: &CollectedDiagnosticBundle) -> DiagnosticsBundlePayload {
    DiagnosticsBundlePayload {
        bundle_submission_id: bundle.bundle_submission_id.clone(),
        bytes: bundle.bytes,
        span_count: bundle.span_count,
    }
}

fn skipped_crash_diagnostic_bundle() -> CrashDiagnosticBundleAttachment {
    not_uploaded_crash_diagnostic_bundle("diagnostic log upload skipped by user")
}

fn not_uploaded_crash_diagnostic_bundle(reason: &str) -> CrashDiagnosticBundleAttachment {
    CrashDiagnosticBundleAttachment {
        diagnostic_bundle: CrashReportDiagnosticBundle {
            status: "not_uploaded".to_string(),
            reason: Some(sanitize_bundle_string(reason)),
            ticket_id: None,
            bundle_submission_id: None,
            bytes: None,
            span_count: None,
        },
        feedback_diagnostic_bundle: None,
    }
}

fn attached_crash_diagnostic_bundle(
    bundle: &CollectedDiagnosticBundle,
) -> CrashReportDiagnosticBundle {
    CrashReportDiagnosticBundle {
        status: "attached".to_string(),
        reason: None,
        ticket_id: None,
        bundle_submission_id: Some(bundle.bundle_submission_id.clone()),
        bytes: Some(bundle.bytes),
        span_count: Some(bundle.span_count),
    }
}

fn create_bundle_submission_id() -> String {
    Uuid::new_v4().to_string().replace('-', "")
}

fn is_bundle_identifier(value: &str) -> bool {
    let len = value.len();
    (16..=64).contains(&len)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn bundle_id_from_preview_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_string()
}

fn normalize_lookback_minutes(value: Option<u64>) -> u64 {
    value
        .unwrap_or(DEFAULT_LOOKBACK_MINUTES)
        .clamp(1, 30 * 24 * 60)
}

fn trace_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve Pebble app data directory: {error}"))?
        .join("logs")
        .join(TRACE_FILE_NAME))
}

fn crash_report_store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve Pebble app data directory: {error}"))?
        .join(CRASH_REPORTS_FILE))
}

fn get_rotated_family_size(file_path: &Path) -> u64 {
    list_rotated_files(file_path)
        .iter()
        .filter_map(|path| fs::metadata(path).ok().map(|metadata| metadata.len()))
        .sum()
}

fn list_rotated_files(file_path: &Path) -> Vec<PathBuf> {
    (0..DEFAULT_MAX_FILES)
        .filter_map(|index| {
            let path = if index == 0 {
                file_path.to_path_buf()
            } else {
                PathBuf::from(format!("{}.{}", file_path.to_string_lossy(), index))
            };
            path.exists().then_some(path)
        })
        .collect()
}

fn write_private_file(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve diagnostics preview directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create diagnostics preview directory: {error}"))?;
    harden_private_path(parent, true);
    let tmp_path = path.with_extension(format!("ndjson.{}.tmp", create_bundle_submission_id()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp_path)
        .map_err(|error| format!("Could not create diagnostics preview file: {error}"))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("Could not write diagnostics preview file: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not flush diagnostics preview file: {error}"))?;
    harden_private_path(&tmp_path, false);
    fs::rename(&tmp_path, path)
        .map_err(|error| format!("Could not replace diagnostics preview file: {error}"))?;
    harden_private_path(path, false);
    Ok(())
}

fn harden_private_path(path: &Path, is_directory: bool) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if is_directory { 0o700 } else { 0o600 };
        if let Ok(metadata) = fs::metadata(path) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(mode);
            let _ = fs::set_permissions(path, permissions);
        }
    }
}

fn lock_state<'a, T>(mutex: &'a Mutex<T>) -> Result<MutexGuard<'a, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Pebble diagnostics state is unavailable.".to_string())
}

fn open_with_system_default(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        return Command::new("open").arg(path).spawn().is_ok();
    }
    #[cfg(target_os = "windows")]
    {
        return Command::new("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .spawn()
            .is_ok();
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        Command::new("xdg-open").arg(path).spawn().is_ok()
    }
}

fn current_iso_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn current_time_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn current_os_release() -> String {
    Command::new("uname")
        .arg("-r")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| std::env::consts::OS.to_string())
}

fn current_node_platform() -> String {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        "linux" => "linux",
        other => other,
    }
    .to_string()
}

fn current_node_arch() -> String {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
    .to_string()
}

fn redact_value(value: Value, server_mode: bool) -> Value {
    match value {
        Value::String(value) => Value::String(redact_string(&value)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| redact_value(value, server_mode))
                .collect(),
        ),
        Value::Object(values) => {
            let mut redacted = Map::new();
            for (key, value) in values {
                if should_drop_attribute_key(&key, server_mode) {
                    continue;
                }
                redacted.insert(key, redact_value(value, server_mode));
            }
            Value::Object(redacted)
        }
        other => other,
    }
}

fn should_drop_attribute_key(key: &str, server_mode: bool) -> bool {
    let key_lower = key.to_ascii_lowercase();
    let normalized = key_lower
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>();
    let blocked = [
        "env",
        "environment",
        "env_vars",
        "api_key",
        "api-key",
        "apikey",
        "authorization",
        "bearer",
        "cookie",
        "password",
        "set-cookie",
        "secret",
        "token",
        "access_token",
        "refresh_token",
        "proxy-authorization",
        "headers.authorization",
    ];
    blocked.contains(&key_lower.as_str())
        || Regex::new(
            r"(?i)(api[-_]?key|token|secret|password|bearer|authorization|private[-_]?key)",
        )
        .map(|regex| regex.is_match(key) || regex.is_match(&normalized))
        .unwrap_or(false)
        || (server_mode
            && ["install_id", "installid", "distinct_id", "distinctid"]
                .contains(&key_lower.as_str()))
}

fn redact_string(input: &str) -> String {
    let mut output = input.to_string();
    let replacements = [
        (
            r"(?i)\b(?:api[-_]?key|token|secret|password|bearer|authorization)\b\s*[:=]\s*(?:Bearer\s+\S+|Token\s+\S+|\S+)",
            "[redacted:labeled-kv]",
        ),
        (r"sk-ant-[a-zA-Z0-9_-]{40,}", "[redacted:anthropic-key]"),
        (r"sk-(?:proj-)?[a-zA-Z0-9_-]{32,}", "[redacted:openai-key]"),
        (r"gh[pousr]_[A-Za-z0-9]{36,}", "[redacted:github-token]"),
        (r"AKIA[0-9A-Z]{16}", "[redacted:aws-access-key-id]"),
        (
            r"(?i)aws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{40}",
            "[redacted:aws-secret-access-key]",
        ),
        (
            r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
            "[redacted:jwt]",
        ),
        (r"xox[baprsoe]-[A-Za-z0-9-]{10,}", "[redacted:slack-token]"),
        (
            r"-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----",
            "[redacted:pem]",
        ),
        (r"(https?://)([^/@\s]+)@", "$1[redacted]@"),
        (r#"/(?:Users|home)/[^\s"'`<>\n\r)]+"#, "[redacted-path]"),
        (r#"[A-Za-z]:\\[^\s"'`<>\n\r)]+"#, "[redacted-path]"),
    ];
    for (pattern, replacement) in replacements {
        if let Ok(regex) = Regex::new(pattern) {
            output = regex.replace_all(&output, replacement).to_string();
        }
    }
    if let Ok(env_line) = Regex::new(r"(?m)^\s*([A-Z_][A-Z0-9_]*)\s*=\s*\S.*") {
        output = env_line
            .replace_all(&output, |captures: &regex::Captures<'_>| {
                format!(
                    "{}=[redacted:env-value]",
                    captures.get(1).map(|value| value.as_str()).unwrap_or("KEY")
                )
            })
            .to_string();
    }
    output
}

fn sanitize_bundle_string(value: &str) -> String {
    let redacted = redact_string(value);
    if redacted.chars().count() > 240 {
        format!("{}...", redacted.chars().take(240).collect::<String>())
    } else {
        redacted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bundle_payload_secrets_and_identity_keys() {
        let value = json!({
            "message": "token=abc123 sk-proj-abcdefghijklmnopqrstuvwxyzabcdef",
            "authorization": "Bearer secret",
            "install_id": "posthog-identity",
            "nested": { "url": "https://user:pass@example.com/path" }
        });
        let redacted = redact_value(value, true);
        let text = serde_json::to_string(&redacted).unwrap();
        assert!(text.contains("[redacted:labeled-kv]"));
        assert!(text.contains("https://[redacted]@example.com/path"));
        assert!(!text.contains("posthog-identity"));
        assert!(!text.contains("Bearer secret"));
    }

    #[test]
    fn rejects_upload_url_host_mismatch() {
        assert!(validate_upload_url(
            "https://evil.example/upload",
            "https://www.nebutra.com/diagnostics/token"
        )
        .is_err());
        assert!(validate_upload_url(
            "https://www.nebutra.com/diagnostics/upload",
            "https://www.nebutra.com/diagnostics/token"
        )
        .is_ok());
    }
}
