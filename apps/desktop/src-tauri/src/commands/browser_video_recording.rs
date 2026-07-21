use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request};
use tauri::State;

const RECORDING_ID_HEADER: &str = "x-pebble-recording-id";
const MAX_CHUNK_BYTES: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub struct BrowserVideoRecordingState {
    writers: Mutex<HashMap<String, BrowserVideoWriter>>,
}

struct BrowserVideoWriter {
    target: PathBuf,
    temporary: PathBuf,
    file: File,
    bytes_written: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVideoRecordingStartInput {
    path: String,
    base_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVideoRecordingStopInput {
    recording_id: String,
    discard: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVideoRecordingStartResult {
    recording_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVideoRecordingStopResult {
    path: String,
    bytes: u64,
}

#[tauri::command]
pub fn browser_video_recording_start(
    state: State<'_, BrowserVideoRecordingState>,
    input: BrowserVideoRecordingStartInput,
) -> Result<BrowserVideoRecordingStartResult, String> {
    let target = resolve_video_path(&input.path, input.base_dir.as_deref())?;
    let parent = target
        .parent()
        .ok_or_else(|| "Browser video path has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create browser video directory: {error}"))?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("Browser video directory is unavailable: {error}"))?;
    if fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Browser video path cannot be a symbolic link.".to_string());
    }
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Browser video file name is invalid.".to_string())?;
    let recording_id = uuid::Uuid::new_v4().to_string();
    let temporary = canonical_parent.join(format!(".{file_name}.pebble-{recording_id}.tmp"));
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create browser video: {error}"))?;
    let writer = BrowserVideoWriter {
        target: canonical_parent.join(file_name),
        temporary,
        file,
        bytes_written: 0,
    };
    state
        .writers
        .lock()
        .map_err(|_| "Browser video writer state is unavailable.".to_string())?
        .insert(recording_id.clone(), writer);
    Ok(BrowserVideoRecordingStartResult { recording_id })
}

#[tauri::command]
pub fn browser_video_recording_append(
    state: State<'_, BrowserVideoRecordingState>,
    request: Request<'_>,
) -> Result<(), String> {
    let recording_id = request
        .headers()
        .get(RECORDING_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 64)
        .ok_or_else(|| "Browser video recording id is required.".to_string())?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) if !bytes.is_empty() && bytes.len() <= MAX_CHUNK_BYTES => bytes,
        InvokeBody::Raw(_) => return Err("Browser video chunk size is invalid.".to_string()),
        InvokeBody::Json(_) => return Err("Browser video chunks must use raw IPC.".to_string()),
    };
    let mut writers = state
        .writers
        .lock()
        .map_err(|_| "Browser video writer state is unavailable.".to_string())?;
    let writer = writers
        .get_mut(recording_id)
        .ok_or_else(|| "Browser video recording is not active.".to_string())?;
    writer
        .file
        .write_all(bytes)
        .map_err(|error| format!("Could not append browser video: {error}"))?;
    writer.bytes_written += bytes.len() as u64;
    Ok(())
}

#[tauri::command]
pub fn browser_video_recording_stop(
    state: State<'_, BrowserVideoRecordingState>,
    input: BrowserVideoRecordingStopInput,
) -> Result<BrowserVideoRecordingStopResult, String> {
    let mut writer = state
        .writers
        .lock()
        .map_err(|_| "Browser video writer state is unavailable.".to_string())?
        .remove(&input.recording_id)
        .ok_or_else(|| "Browser video recording is not active.".to_string())?;
    if input.discard.unwrap_or(false) || writer.bytes_written == 0 {
        drop(writer.file);
        let _ = fs::remove_file(&writer.temporary);
        return Err("Browser video recording captured no frames.".to_string());
    }
    writer
        .file
        .flush()
        .and_then(|_| writer.file.sync_all())
        .map_err(|error| format!("Could not finalize browser video: {error}"))?;
    drop(writer.file);
    if let Err(error) = publish_video_file(&writer.temporary, &writer.target) {
        let _ = fs::remove_file(&writer.temporary);
        return Err(error);
    }
    Ok(BrowserVideoRecordingStopResult {
        path: writer.target.to_string_lossy().into_owned(),
        bytes: writer.bytes_written,
    })
}

#[cfg(not(windows))]
fn publish_video_file(temporary: &Path, target: &Path) -> Result<(), String> {
    fs::rename(temporary, target)
        .map_err(|error| format!("Could not publish browser video: {error}"))?;
    // Why: syncing the containing directory makes the atomic rename durable
    // across a host crash immediately after recording completion.
    if let Some(parent) = target.parent() {
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not sync browser video directory: {error}"))?;
    }
    Ok(())
}

#[cfg(windows)]
fn publish_video_file(temporary: &Path, target: &Path) -> Result<(), String> {
    if !target.exists() {
        return fs::rename(temporary, target)
            .map_err(|error| format!("Could not publish browser video: {error}"));
    }
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    let target_wide = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let temporary_wide = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // Why: deleting the destination before rename creates a data-loss window;
    // ReplaceFileW preserves atomic overwrite semantics for existing recordings.
    let replaced = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            temporary_wide.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        return Err(format!(
            "Could not publish browser video: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn resolve_video_path(value: &str, base_dir: Option<&str>) -> Result<PathBuf, String> {
    let requested = Path::new(value.trim());
    if requested.as_os_str().is_empty() {
        return Err("Browser video path is required.".to_string());
    }
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("webm" | "mp4")) {
        return Err("Browser video path must use .webm or .mp4.".to_string());
    }
    if requested.is_absolute() {
        return Ok(requested.to_path_buf());
    }
    if requested
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("Relative browser video paths cannot escape the workspace.".to_string());
    }
    let base = base_dir
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Relative browser video paths require a local workspace.".to_string())?;
    Ok(Path::new(base).join(requested))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_paths_are_bounded_to_supported_containers() {
        assert_eq!(
            resolve_video_path("recordings/demo.webm", Some("/workspace")).unwrap(),
            Path::new("/workspace/recordings/demo.webm")
        );
        assert!(resolve_video_path("../demo.webm", Some("/workspace")).is_err());
        assert!(resolve_video_path("demo.mov", Some("/workspace")).is_err());
        assert!(resolve_video_path("demo.mp4", None).is_err());
    }

    #[test]
    fn publishing_replaces_an_existing_recording() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("capture.webm");
        let temporary = directory.path().join(".capture.tmp");
        fs::write(&target, b"old recording").unwrap();
        fs::write(&temporary, b"new recording").unwrap();

        publish_video_file(&temporary, &target).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new recording");
        assert!(!temporary.exists());
    }
}
