use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::Manager;

const IMPORT_STATE_FILE: &str = "macos-system-crash-imports.json";
const MAX_REPORT_BYTES: u64 = 2 * 1024 * 1024;
const PEBBLE_REPORT_PREFIXES: [&str; 2] = ["pebble-desktop-tauri-", "Pebble-"];

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportState {
    incident_ids: HashSet<String>,
}

pub fn import_unseen_reports(app: tauri::AppHandle) {
    if system_crash_import_disabled(
        std::env::var_os("PEBBLE_PARITY_CAPTURE_PATH").is_some(),
        std::env::var_os("PEBBLE_FUNCTIONAL_GATE_EVIDENCE_PATH").is_some(),
        std::env::var_os("PEBBLE_SYSTEM_CRASH_IMPORT_DISABLED").is_some(),
    ) {
        return;
    }
    // Why: an abort or dyld failure happens outside Rust's panic hook. macOS
    // writes the evidence after exit, so the next healthy launch imports it.
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = import_unseen_reports_blocking(&app) {
            eprintln!("[crash-reporting] failed to import macOS crash reports: {error}");
        }
    });
}

fn system_crash_import_disabled(
    parity_capture: bool,
    functional_gate: bool,
    explicit_harness_disable: bool,
) -> bool {
    // Why: system DiagnosticReports are user-global; isolated evidence shells
    // must not import production incidents into deterministic fixture state.
    parity_capture || functional_gate || explicit_harness_disable
}

fn import_unseen_reports_blocking(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(directory) = diagnostic_reports_directory() else {
        return Ok(());
    };
    let state_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(IMPORT_STATE_FILE);
    let mut state = read_import_state(&state_path);
    let mut reports = candidate_reports(&directory)?;
    reports.sort_by_key(|path| fs::metadata(path).and_then(|value| value.modified()).ok());

    for path in reports {
        let Some(report) = parse_system_report(&path)? else {
            continue;
        };
        if state.incident_ids.contains(&report.incident_id) {
            continue;
        }
        super::crash_reports::record_native_process_failure(
            app,
            "tauri-host",
            &report.reason,
            report.exit_code,
            report.details,
        )?;
        state.incident_ids.insert(report.incident_id);
    }
    write_import_state(&state_path, &state)
}

struct ParsedSystemReport {
    incident_id: String,
    reason: String,
    exit_code: Option<i32>,
    details: Map<String, Value>,
}

fn parse_system_report(path: &Path) -> Result<Option<ParsedSystemReport>, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_REPORT_BYTES {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let Some((header_text, body_text)) = content.split_once('\n') else {
        return Ok(None);
    };
    let header: Value = serde_json::from_str(header_text).map_err(|error| error.to_string())?;
    let body: Value = serde_json::from_str(body_text).map_err(|error| error.to_string())?;
    if header.get("bundleID").and_then(Value::as_str) != Some("nebutra.pebble") {
        return Ok(None);
    }
    let Some(incident_id) = header
        .get("incident_id")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return Ok(None);
    };
    let termination = body.get("termination").unwrap_or(&Value::Null);
    let indicator = termination
        .get("indicator")
        .and_then(Value::as_str)
        .unwrap_or("native process terminated");
    let mut details = Map::new();
    insert_string(&mut details, "system_report_id", Some(&incident_id));
    insert_string(
        &mut details,
        "system_report_created_at",
        header.get("timestamp").and_then(Value::as_str),
    );
    insert_string(
        &mut details,
        "exception_type",
        body.pointer("/exception/type").and_then(Value::as_str),
    );
    insert_string(
        &mut details,
        "termination_namespace",
        termination.get("namespace").and_then(Value::as_str),
    );
    if let Some(reasons) = termination.get("reasons").and_then(Value::as_array) {
        let summary = reasons
            .iter()
            .filter_map(Value::as_str)
            .take(3)
            .collect::<Vec<_>>()
            .join("; ");
        insert_string(&mut details, "error_stack", Some(&summary));
    }
    Ok(Some(ParsedSystemReport {
        incident_id,
        reason: format!("macos-system-crash: {indicator}"),
        exit_code: termination
            .get("code")
            .and_then(Value::as_i64)
            .and_then(|value| i32::try_from(value).ok()),
        details,
    }))
}

fn insert_string(details: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        details.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn candidate_reports(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    Ok(entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("ips"))
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| {
                    PEBBLE_REPORT_PREFIXES
                        .iter()
                        .any(|prefix| name.starts_with(prefix))
                })
        })
        .collect())
}

fn diagnostic_reports_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Library/Logs/DiagnosticReports"))
}

fn read_import_state(path: &Path) -> ImportState {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_import_state(path: &Path, state: &ImportState) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "macOS crash import state has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dyld_system_report_without_copying_the_whole_ips() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("pebble-desktop-tauri-test.ips");
        fs::write(
            &path,
            concat!(
                r#"{"bundleID":"nebutra.pebble","timestamp":"2026-07-18 00:44:36 +0800","incident_id":"incident-1"}"#,
                "\n",
                r#"{"exception":{"type":"EXC_CRASH"},"termination":{"code":1,"namespace":"DYLD","indicator":"Library missing","reasons":["Library not loaded: /Users/person/secret.dylib"]}}"#
            ),
        )
        .expect("fixture");

        let report = parse_system_report(&path)
            .expect("parse")
            .expect("Pebble report");
        assert_eq!(report.reason, "macos-system-crash: Library missing");
        assert_eq!(report.exit_code, Some(1));
        assert_eq!(report.incident_id, "incident-1");
        assert_eq!(
            report.details.get("exception_type"),
            Some(&Value::String("EXC_CRASH".into()))
        );
    }

    #[test]
    fn ignores_functional_gate_reports() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("Pebble-test.ips");
        fs::write(
            &path,
            "{\"bundleID\":\"nebutra.pebble.functional-gate\",\"incident_id\":\"incident-2\"}\n{}",
        )
        .expect("fixture");
        assert!(parse_system_report(&path).expect("parse").is_none());
    }

    #[test]
    fn evidence_shells_never_import_user_global_system_reports() {
        assert!(system_crash_import_disabled(true, false, false));
        assert!(system_crash_import_disabled(false, true, false));
        assert!(system_crash_import_disabled(false, false, true));
        assert!(!system_crash_import_disabled(false, false, false));
    }
}
