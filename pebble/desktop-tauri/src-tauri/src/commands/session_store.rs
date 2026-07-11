use std::fs;
use std::path::PathBuf;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const SESSION_STORE_SUBDIR: &str = "workspace-sessions";
const MAX_HOST_ID_BYTES: usize = 4 * 1024;
const MAX_SESSION_BYTES: usize = 16 * 1024 * 1024;

#[tauri::command]
pub fn read_host_workspace_session(
    app: AppHandle,
    host_id: String,
) -> Result<Option<String>, String> {
    let path = session_path(&app, &host_id)?;
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn write_host_workspace_session(
    app: AppHandle,
    host_id: String,
    contents: String,
) -> Result<(), String> {
    if contents.len() > MAX_SESSION_BYTES
        || serde_json::from_str::<serde_json::Value>(&contents).is_err()
    {
        return Err("Workspace session must be bounded valid JSON.".to_string());
    }
    let path = session_path(&app, &host_id)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid workspace session path.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, contents).map_err(|error| error.to_string())?;
    replace_session_file(&temp, &path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        error.to_string()
    })
}

fn replace_session_file(temp: &PathBuf, target: &PathBuf) -> std::io::Result<()> {
    match fs::rename(temp, target) {
        Ok(()) => Ok(()),
        Err(error)
            if target.exists()
                && matches!(
                    error.kind(),
                    std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied
                ) =>
        {
            // Windows rename does not replace an existing destination.
            fs::remove_file(target)?;
            fs::rename(temp, target)
        }
        Err(error) => Err(error),
    }
}

fn session_path(app: &AppHandle, host_id: &str) -> Result<PathBuf, String> {
    let host_id = host_id.trim();
    if host_id.is_empty() || host_id == "local" || host_id.len() > MAX_HOST_ID_BYTES {
        return Err("Invalid remote workspace session host id.".to_string());
    }
    let digest = Sha256::digest(host_id.as_bytes());
    let file_name = format!("{:x}.json", digest);
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(base.join(SESSION_STORE_SUBDIR).join(file_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_ids_map_to_stable_path_safe_names() {
        let digest = Sha256::digest(b"ssh:builder/../../escape");
        let file_name = format!("{:x}.json", digest);
        assert_eq!(file_name.len(), 69);
        assert!(!file_name.contains('/'));
        assert!(!file_name.contains(".."));
    }
}
