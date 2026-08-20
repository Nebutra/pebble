//! Starts the runtime while the webview is still loading.
//!
//! Cold start measured 1095ms to a usable terminal, and 652ms of it was the gap
//! between the app process existing and the runtime being spawned: the renderer
//! owns the runtime's credential, so nothing could spawn it until the bundle had
//! parsed and React had mounted. The runtime itself needs only 81ms to bind.
//!
//! The host remembers what the renderer last launched and replays it at setup,
//! in parallel with the webview. The renderer's own start path is unchanged — it
//! probes first and finds the runtime already up. Only the first launch on a new
//! machine still pays the serial cost, because only then is there nothing to
//! replay.

use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::runtime_process::{RuntimeProcessStartCommand, RuntimeProcessState};

const PRESTART_FILE: &str = "runtime-prestart.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimePrestartRecord {
    pub executable: String,
    pub listen: String,
    pub data_dir: Option<String>,
    pub bearer_token: Option<String>,
}

fn prestart_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve app data: {error}"))?;
    Ok(directory.join(PRESTART_FILE))
}

/// Records what the renderer launched, so the next cold start can replay it.
pub fn remember(app: &AppHandle, record: &RuntimePrestartRecord) {
    let Ok(path) = prestart_path(app) else {
        return;
    };
    let Ok(contents) = serde_json::to_vec_pretty(record) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // Why: this file carries the loopback runtime's bearer token, so it is
    // written for this user only — the same secrecy the renderer's own storage
    // gives it, on a path the host can read before any window exists.
    if write_private(&path, &contents).is_err() {
        let _ = fs::remove_file(&path);
    }
}

#[cfg(unix)]
fn write_private(path: &PathBuf, contents: &[u8]) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::io::Write;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents)
}

#[cfg(not(unix))]
fn write_private(path: &PathBuf, contents: &[u8]) -> io::Result<()> {
    fs::write(path, contents)
}

fn read_record(app: &AppHandle) -> Option<RuntimePrestartRecord> {
    let path = prestart_path(app).ok()?;
    let contents = fs::read(path).ok()?;
    serde_json::from_slice(&contents).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_record_survives_a_round_trip() {
        let record = RuntimePrestartRecord {
            executable: "pebble-runtime".to_string(),
            listen: "127.0.0.1:17777".to_string(),
            data_dir: Some("/tmp/pebble".to_string()),
            bearer_token: Some("secret".to_string()),
        };
        let encoded = serde_json::to_vec(&record).expect("encode");
        let decoded: RuntimePrestartRecord = serde_json::from_slice(&encoded).expect("decode");
        assert_eq!(decoded.listen, record.listen);
        assert_eq!(decoded.bearer_token, record.bearer_token);
    }

    #[cfg(unix)]
    #[test]
    fn the_record_is_written_for_this_user_only() {
        // Why: the file carries the runtime's bearer token, so a mode that let
        // other local users read it would hand over the loopback control plane.
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!("pebble-prestart-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("temp dir");
        let path = directory.join("record.json");
        write_private(&path, b"{}").expect("write");

        let mode = std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "prestart record must not be group or world readable");

        let _ = std::fs::remove_dir_all(&directory);
    }
}

/// Replays the last known launch. Any failure is silent: the renderer's start
/// path is still there and still authoritative, so a bad or stale record costs
/// the old serial startup rather than a broken one.
pub fn begin(app: &AppHandle) {
    let Some(record) = read_record(app) else {
        return;
    };
    let handle = app.clone();
    std::thread::spawn(move || {
        let Some(state) = handle.try_state::<RuntimeProcessState>() else {
            return;
        };
        let command = RuntimeProcessStartCommand {
            executable: record.executable,
            listen: record.listen,
            data_dir: record.data_dir,
            bearer_token: record.bearer_token,
            extra_args: Vec::new(),
        };
        let _ = super::runtime_process::start_runtime_process_inner(&handle, command, &state);
    });
}
