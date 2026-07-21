use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;
use uuid::Uuid;

const TERMINAL_FILE_GRANT_TTL: Duration = Duration::from_secs(10 * 60);
const TERMINAL_TEXT_MAX_BYTES: u64 = 512 * 1024;
const TERMINAL_PREVIEW_MAX_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Default)]
pub struct TerminalArtifactsState {
    grants: Mutex<HashMap<String, TerminalFileGrant>>,
}

#[derive(Clone)]
struct TerminalFileGrant {
    worktree_id: String,
    absolute_path: PathBuf,
    expires_at: SystemTime,
    stat_identity: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalArtifactGrantInput {
    worktree_id: String,
    absolute_path: String,
    worktree_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalArtifactAccessInput {
    worktree_id: String,
    grant_id: String,
    absolute_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalArtifactWriteInput {
    worktree_id: String,
    grant_id: String,
    absolute_path: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalArtifactGrantResult {
    absolute_path: String,
    is_directory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    grant_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalArtifactReadResult {
    worktree: String,
    relative_path: String,
    content: String,
    truncated: bool,
    byte_length: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalArtifactPreviewResult {
    content: String,
    is_binary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_image: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalArtifactWriteResult {
    ok: bool,
}

#[tauri::command]
pub fn terminal_artifact_grant(
    input: TerminalArtifactGrantInput,
    state: State<'_, TerminalArtifactsState>,
) -> Result<TerminalArtifactGrantResult, String> {
    let worktree_id = normalize_required(&input.worktree_id, "worktree id")?;
    let absolute_path = validate_absolute_path(&input.absolute_path)?;
    let canonical_path = canonical_path(&absolute_path)?;
    if !is_allowed_terminal_artifact_path(&canonical_path, input.worktree_path.as_deref()) {
        return Err("terminal_file_grant_unavailable".to_string());
    }

    let metadata = fs::metadata(&canonical_path).map_err(map_io_error)?;
    let is_directory = metadata.is_dir();
    if is_directory {
        return Ok(TerminalArtifactGrantResult {
            absolute_path: path_to_string(&canonical_path),
            is_directory,
            grant_id: None,
        });
    }
    assert_terminal_artifact_not_hard_linked(&metadata)?;

    let grant_id = Uuid::new_v4().to_string();
    let grant = TerminalFileGrant {
        worktree_id: worktree_id.to_string(),
        absolute_path: canonical_path.clone(),
        expires_at: SystemTime::now() + TERMINAL_FILE_GRANT_TTL,
        stat_identity: terminal_file_stat_identity(&metadata),
    };

    let mut grants = state
        .grants
        .lock()
        .map_err(|_| "terminal artifact grant state is poisoned".to_string())?;
    prune_expired_grants(&mut grants);
    grants.insert(grant_id.clone(), grant);

    Ok(TerminalArtifactGrantResult {
        absolute_path: path_to_string(&canonical_path),
        is_directory,
        grant_id: Some(grant_id),
    })
}

#[tauri::command]
pub fn terminal_artifact_read(
    input: TerminalArtifactAccessInput,
    state: State<'_, TerminalArtifactsState>,
) -> Result<TerminalArtifactReadResult, String> {
    let grant = require_terminal_file_grant(&input, &state)?;
    if is_mobile_binary_path(&grant.absolute_path) {
        return Err("binary_file".to_string());
    }
    let mut file = open_read_no_follow(&grant.absolute_path)?;
    let metadata = file.metadata().map_err(map_io_error)?;
    let content = read_terminal_text_file(&mut file, &grant, &metadata)?;
    refresh_terminal_file_grant(&input.grant_id, &state, None)?;
    let byte_length = content.as_bytes().len() as u64;
    Ok(TerminalArtifactReadResult {
        worktree: grant.worktree_id,
        relative_path: path_to_string(&grant.absolute_path),
        content,
        truncated: false,
        byte_length,
    })
}

#[tauri::command]
pub fn terminal_artifact_preview(
    input: TerminalArtifactAccessInput,
    state: State<'_, TerminalArtifactsState>,
) -> Result<TerminalArtifactPreviewResult, String> {
    let grant = require_terminal_file_grant(&input, &state)?;
    let mut file = open_read_no_follow(&grant.absolute_path)?;
    let metadata = file.metadata().map_err(map_io_error)?;
    if metadata.is_dir() {
        return Err("Cannot preview a directory".to_string());
    }
    assert_terminal_file_grant_fresh(&grant, &metadata)?;
    if let Some(mime_type) = preview_mime_type(&grant.absolute_path) {
        if metadata.len() > TERMINAL_PREVIEW_MAX_BYTES {
            return Err("file_too_large".to_string());
        }
        let bytes = read_bounded_file(&mut file, TERMINAL_PREVIEW_MAX_BYTES + 1)?;
        refresh_terminal_file_grant(&input.grant_id, &state, None)?;
        return Ok(TerminalArtifactPreviewResult {
            content: BASE64_STANDARD.encode(bytes),
            is_binary: true,
            is_image: Some(true),
            mime_type: Some(mime_type),
        });
    }

    let content = read_terminal_text_file(&mut file, &grant, &metadata)?;
    refresh_terminal_file_grant(&input.grant_id, &state, None)?;
    Ok(TerminalArtifactPreviewResult {
        content,
        is_binary: false,
        is_image: None,
        mime_type: None,
    })
}

#[tauri::command]
pub fn terminal_artifact_write(
    input: TerminalArtifactWriteInput,
    state: State<'_, TerminalArtifactsState>,
) -> Result<TerminalArtifactWriteResult, String> {
    if input.content.as_bytes().len() as u64 > TERMINAL_TEXT_MAX_BYTES {
        return Err("file_too_large".to_string());
    }
    let access = TerminalArtifactAccessInput {
        worktree_id: input.worktree_id,
        grant_id: input.grant_id,
        absolute_path: input.absolute_path,
    };
    let grant = require_terminal_file_grant(&access, &state)?;
    if is_mobile_binary_path(&grant.absolute_path) {
        return Err("binary_file".to_string());
    }

    let mut file = open_read_no_follow(&grant.absolute_path)?;
    let metadata = file.metadata().map_err(map_io_error)?;
    let original_permissions = metadata.permissions();
    let _ = read_terminal_text_file(&mut file, &grant, &metadata)?;
    drop(file);

    let temp_path = terminal_artifact_temp_path(&grant.absolute_path)?;
    let write_result = write_terminal_artifact_temp_file(&temp_path, &input.content)
        .and_then(|_| fs::set_permissions(&temp_path, original_permissions).map_err(map_io_error))
        .and_then(|_| {
            let fresh_file = open_read_no_follow(&grant.absolute_path)?;
            let fresh_metadata = fresh_file.metadata().map_err(map_io_error)?;
            assert_terminal_file_grant_fresh(&grant, &fresh_metadata)?;
            replace_file(&temp_path, &grant.absolute_path)
        });
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    let next_metadata = fs::metadata(&grant.absolute_path).map_err(map_io_error)?;
    refresh_terminal_file_grant(
        &access.grant_id,
        &state,
        Some(terminal_file_stat_identity(&next_metadata)),
    )?;
    Ok(TerminalArtifactWriteResult { ok: true })
}

fn require_terminal_file_grant(
    input: &TerminalArtifactAccessInput,
    state: &State<'_, TerminalArtifactsState>,
) -> Result<TerminalFileGrant, String> {
    let worktree_id = normalize_required(&input.worktree_id, "worktree id")?;
    let grant_id = normalize_required(&input.grant_id, "terminal artifact grant")?.to_string();
    let absolute_path = validate_absolute_path(&input.absolute_path)?;
    let mut grants = state
        .grants
        .lock()
        .map_err(|_| "terminal artifact grant state is poisoned".to_string())?;
    prune_expired_grants(&mut grants);
    let Some(grant) = grants.get(&grant_id).cloned() else {
        return Err("terminal_file_grant_expired".to_string());
    };
    if grant.expires_at <= SystemTime::now() {
        grants.remove(&grant_id);
        return Err("terminal_file_grant_expired".to_string());
    }
    if grant.worktree_id != worktree_id || grant.absolute_path != absolute_path {
        return Err("terminal_file_grant_mismatch".to_string());
    }
    assert_terminal_artifact_path_still_canonical(&grant.absolute_path)?;
    Ok(grant)
}

fn refresh_terminal_file_grant(
    grant_id: &str,
    state: &State<'_, TerminalArtifactsState>,
    stat_identity: Option<Option<String>>,
) -> Result<(), String> {
    let mut grants = state
        .grants
        .lock()
        .map_err(|_| "terminal artifact grant state is poisoned".to_string())?;
    if let Some(grant) = grants.get_mut(grant_id) {
        grant.expires_at = SystemTime::now() + TERMINAL_FILE_GRANT_TTL;
        if let Some(next_identity) = stat_identity {
            grant.stat_identity = next_identity;
        }
    }
    Ok(())
}

fn prune_expired_grants(grants: &mut HashMap<String, TerminalFileGrant>) {
    let now = SystemTime::now();
    grants.retain(|_, grant| grant.expires_at > now);
}

fn read_terminal_text_file(
    file: &mut File,
    grant: &TerminalFileGrant,
    metadata: &Metadata,
) -> Result<String, String> {
    assert_readable_file_is_fresh(grant, metadata)?;
    let bytes = read_bounded_file(file, TERMINAL_TEXT_MAX_BYTES + 1)?;
    if bytes.len() as u64 > TERMINAL_TEXT_MAX_BYTES {
        return Err("file_too_large".to_string());
    }
    if bytes.contains(&0) {
        return Err("binary_file".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "binary_file".to_string())
}

fn assert_readable_file_is_fresh(
    grant: &TerminalFileGrant,
    metadata: &Metadata,
) -> Result<(), String> {
    if metadata.is_dir() {
        return Err("Cannot read a directory".to_string());
    }
    if metadata.len() > TERMINAL_TEXT_MAX_BYTES {
        return Err("file_too_large".to_string());
    }
    assert_terminal_file_grant_fresh(grant, metadata)
}

fn assert_terminal_file_grant_fresh(
    grant: &TerminalFileGrant,
    metadata: &Metadata,
) -> Result<(), String> {
    assert_terminal_artifact_not_hard_linked(metadata)?;
    let next_identity = terminal_file_stat_identity(metadata);
    if grant.stat_identity.is_some()
        && next_identity.is_some()
        && grant.stat_identity != next_identity
    {
        return Err("terminal_file_grant_stale".to_string());
    }
    Ok(())
}

fn assert_terminal_artifact_path_still_canonical(path: &Path) -> Result<(), String> {
    let current = canonical_path(path)?;
    if current != path {
        return Err("terminal_file_grant_stale".to_string());
    }
    Ok(())
}

fn read_bounded_file(file: &mut File, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.take(limit)
        .read_to_end(&mut bytes)
        .map_err(map_io_error)?;
    Ok(bytes)
}

fn open_read_no_follow(path: &Path) -> Result<File, String> {
    assert_terminal_artifact_path_still_canonical(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path).map_err(map_io_error)
}

fn write_terminal_artifact_temp_file(path: &Path, content: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(map_io_error)?;
    file.write_all(content.as_bytes()).map_err(map_io_error)
}

fn replace_file(temp_path: &Path, destination_path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Why: std::fs::rename does not replace existing files on Windows.
        // The grant is revalidated immediately before this best-effort replace.
        fs::remove_file(destination_path).map_err(map_io_error)?;
    }
    fs::rename(temp_path, destination_path).map_err(map_io_error)
}

fn terminal_artifact_temp_path(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "terminal_file_grant_unavailable".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "terminal_file_grant_unavailable".to_string())?;
    Ok(parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4())))
}

fn is_allowed_terminal_artifact_path(path: &Path, _worktree_path: Option<&str>) -> bool {
    terminal_artifact_roots()
        .into_iter()
        .any(|root| path_inside_or_equal(&root, path))
}

fn terminal_artifact_roots() -> Vec<PathBuf> {
    let mut roots = vec![env::temp_dir()];
    #[cfg(not(windows))]
    {
        roots.push(PathBuf::from("/tmp"));
        roots.push(PathBuf::from("/private/tmp"));
    }
    let mut expanded = Vec::new();
    for root in roots {
        expanded.push(root.clone());
        if let Ok(canonical) = fs::canonicalize(&root) {
            expanded.push(canonical);
        }
    }
    expanded
}

fn path_inside_or_equal(root: &Path, path: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn validate_absolute_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = normalize_required(value, "terminal artifact path")?;
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("not_absolute".to_string());
    }
    Ok(path)
}

fn canonical_path(path: impl AsRef<Path>) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(map_io_error)
}

fn normalize_required<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is required"));
    }
    Ok(trimmed)
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn preview_mime_type(path: &Path) -> Option<&'static str> {
    match file_extension(path).as_deref() {
        Some(".png") => Some("image/png"),
        Some(".jpg") | Some(".jpeg") => Some("image/jpeg"),
        Some(".gif") => Some("image/gif"),
        Some(".svg") => Some("image/svg+xml"),
        Some(".webp") => Some("image/webp"),
        Some(".bmp") => Some("image/bmp"),
        Some(".ico") => Some("image/x-icon"),
        Some(".pdf") => Some("application/pdf"),
        _ => None,
    }
}

fn is_mobile_binary_path(path: &Path) -> bool {
    matches!(
        file_extension(path).as_deref(),
        Some(".avif")
            | Some(".bmp")
            | Some(".gif")
            | Some(".heic")
            | Some(".ico")
            | Some(".jpeg")
            | Some(".jpg")
            | Some(".mov")
            | Some(".mp3")
            | Some(".mp4")
            | Some(".pdf")
            | Some(".png")
            | Some(".webp")
            | Some(".zip")
    )
}

fn file_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_ascii_lowercase()))
}

fn terminal_file_stat_identity(metadata: &Metadata) -> Option<String> {
    let modified_ms = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return Some(format!(
            "{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.nlink(),
            metadata.len(),
            modified_ms
        ));
    }
    #[cfg(not(unix))]
    {
        Some(format!("{}:{}", metadata.len(), modified_ms))
    }
}

fn assert_terminal_artifact_not_hard_linked(metadata: &Metadata) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return Err("terminal_file_grant_stale".to_string());
        }
    }
    Ok(())
}

fn map_io_error(error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "not_found".to_string(),
        std::io::ErrorKind::PermissionDenied => "permission_denied".to_string(),
        _ => error.to_string(),
    }
}
