use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

#[derive(Default)]
pub struct DownloadedFileState {
    sessions: Mutex<HashMap<String, DownloadSession>>,
}

struct DownloadSession {
    destination: PathBuf,
    temporary: PathBuf,
    file: File,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDownloadedFileInput {
    suggested_name: String,
    content: String,
    encoding: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartDownloadedFileInput {
    suggested_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendDownloadedFileInput {
    transfer_id: String,
    content_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTransferInput {
    transfer_id: String,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum DownloadStartResult {
    Canceled {
        canceled: bool,
    },
    Started {
        canceled: bool,
        #[serde(rename = "transferId")]
        transfer_id: String,
        #[serde(rename = "destinationPath")]
        destination_path: String,
    },
}

#[derive(Serialize)]
pub struct DownloadCompleteResult {
    canceled: bool,
    #[serde(rename = "destinationPath")]
    destination_path: String,
}

#[derive(Serialize)]
pub struct DownloadWriteResult {
    ok: bool,
}

#[tauri::command]
pub async fn fs_save_downloaded_file(
    input: SaveDownloadedFileInput,
) -> Result<DownloadStartResult, String> {
    let Some(destination) = choose_destination(&input.suggested_name)? else {
        return Ok(DownloadStartResult::Canceled { canceled: true });
    };
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_content(&input.content, &input.encoding)?;
        let temporary = create_temporary_file_path(&destination);
        let result = (|| {
            let mut file = open_new(&temporary)?;
            file.write_all(&bytes).map_err(file_error)?;
            file.sync_all().map_err(file_error)?;
            drop(file);
            promote_file(&temporary, &destination)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        Ok(DownloadStartResult::Started {
            canceled: false,
            transfer_id: String::new(),
            destination_path: path_string(&destination),
        })
    })
    .await
    .map_err(|error| format!("download save task failed: {error}"))?
}

#[tauri::command]
pub fn fs_start_downloaded_file(
    state: tauri::State<'_, DownloadedFileState>,
    input: StartDownloadedFileInput,
) -> Result<DownloadStartResult, String> {
    let Some(destination) = choose_destination(&input.suggested_name)? else {
        return Ok(DownloadStartResult::Canceled { canceled: true });
    };
    let temporary = create_temporary_file_path(&destination);
    let file = open_new(&temporary)?;
    let transfer_id = Uuid::new_v4().to_string();
    state
        .sessions
        .lock()
        .map_err(|_| "download session registry is unavailable".to_string())?
        .insert(
            transfer_id.clone(),
            DownloadSession {
                destination: destination.clone(),
                temporary,
                file,
            },
        );
    Ok(DownloadStartResult::Started {
        canceled: false,
        transfer_id,
        destination_path: path_string(&destination),
    })
}

#[tauri::command]
pub fn fs_append_downloaded_file_chunk(
    state: tauri::State<'_, DownloadedFileState>,
    input: AppendDownloadedFileInput,
) -> Result<DownloadWriteResult, String> {
    let bytes = BASE64_STANDARD
        .decode(input.content_base64)
        .map_err(|_| "download chunk is not valid base64".to_string())?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "download session registry is unavailable".to_string())?;
    let session = sessions
        .get_mut(&input.transfer_id)
        .ok_or_else(|| "Download session not found".to_string())?;
    session.file.write_all(&bytes).map_err(file_error)?;
    Ok(DownloadWriteResult { ok: true })
}

#[tauri::command]
pub fn fs_finish_downloaded_file(
    state: tauri::State<'_, DownloadedFileState>,
    input: DownloadTransferInput,
) -> Result<DownloadCompleteResult, String> {
    let session = take_session(&state, &input.transfer_id)?;
    session.file.sync_all().map_err(file_error)?;
    drop(session.file);
    if let Err(error) = promote_file(&session.temporary, &session.destination) {
        let _ = fs::remove_file(&session.temporary);
        return Err(error);
    }
    Ok(DownloadCompleteResult {
        canceled: false,
        destination_path: path_string(&session.destination),
    })
}

#[tauri::command]
pub fn fs_cancel_downloaded_file(
    state: tauri::State<'_, DownloadedFileState>,
    input: DownloadTransferInput,
) -> Result<DownloadWriteResult, String> {
    if let Some(session) = state
        .sessions
        .lock()
        .map_err(|_| "download session registry is unavailable".to_string())?
        .remove(&input.transfer_id)
    {
        drop(session.file);
        let _ = fs::remove_file(session.temporary);
    }
    Ok(DownloadWriteResult { ok: true })
}

fn take_session(
    state: &tauri::State<'_, DownloadedFileState>,
    transfer_id: &str,
) -> Result<DownloadSession, String> {
    state
        .sessions
        .lock()
        .map_err(|_| "download session registry is unavailable".to_string())?
        .remove(transfer_id)
        .ok_or_else(|| "Download session not found".to_string())
}

fn choose_destination(suggested_name: &str) -> Result<Option<PathBuf>, String> {
    let name = sanitize_filename(suggested_name)?;
    Ok(rfd::FileDialog::new().set_file_name(&name).save_file())
}

fn sanitize_filename(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("suggestedName is required".to_string());
    }
    let name = Path::new(trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && *value != "." && *value != "..")
        .ok_or_else(|| "suggestedName is invalid".to_string())?;
    Ok(name
        .chars()
        .filter(|character| !character.is_control())
        .collect())
}

fn decode_content(content: &str, encoding: &str) -> Result<Vec<u8>, String> {
    if encoding == "base64" {
        return BASE64_STANDARD
            .decode(content)
            .map_err(|_| "download content is not valid base64".to_string());
    }
    if encoding != "utf8" {
        return Err("download encoding must be utf8 or base64".to_string());
    }
    Ok(content.as_bytes().to_vec())
}

fn create_temporary_file_path(destination: &Path) -> PathBuf {
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    destination.with_file_name(format!(".{file_name}.pebble-{}.part", Uuid::new_v4()))
}

fn open_new(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(file_error)
}

fn promote_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    if !destination.exists() {
        return fs::rename(temporary, destination).map_err(file_error);
    }
    let backup = destination.with_file_name(format!(
        ".{}.pebble-{}.backup",
        destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("download"),
        Uuid::new_v4()
    ));
    fs::rename(destination, &backup).map_err(file_error)?;
    if let Err(error) = fs::rename(temporary, destination) {
        let _ = fs::rename(&backup, destination);
        return Err(file_error(error));
    }
    fs::remove_file(backup).map_err(file_error)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn file_error(error: std::io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_to_a_leaf_filename() {
        assert_eq!(sanitize_filename("../report.txt").unwrap(), "report.txt");
        assert!(sanitize_filename("  ").is_err());
    }

    #[test]
    fn promotion_replaces_without_leaving_a_backup() {
        let root = std::env::temp_dir().join(format!("pebble-download-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let destination = root.join("report.txt");
        let temporary = root.join("report.part");
        fs::write(&destination, b"old").unwrap();
        fs::write(&temporary, b"new").unwrap();
        promote_file(&temporary, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"new");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
