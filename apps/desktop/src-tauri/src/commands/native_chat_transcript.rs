use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub const NATIVE_CHAT_APPENDED_EVENT: &str = "native-chat-appended";
const MAX_SEARCH_ENTRIES: usize = 10_000;
const MAX_SEARCH_DEPTH: usize = 8;

#[derive(Default)]
pub struct NativeChatWatcherState {
    watchers: Mutex<HashMap<String, TranscriptWatcher>>,
}

struct TranscriptWatcher {
    _watcher: RecommendedWatcher,
    cursor: Arc<Mutex<WatchCursor>>,
}

#[derive(Default)]
struct WatchCursor {
    offset: u64,
    closed: bool,
}

impl Drop for NativeChatWatcherState {
    fn drop(&mut self) {
        if let Ok(watchers) = self.watchers.get_mut() {
            for (_, entry) in watchers.drain() {
                if let Ok(mut cursor) = entry.cursor.lock() {
                    cursor.closed = true;
                }
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeChatTranscriptInput {
    agent: String,
    session_id: String,
    transcript_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeChatTranscriptWatchInput {
    subscription_id: String,
    agent: String,
    session_id: String,
    transcript_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeChatTranscriptUnwatchInput {
    subscription_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeChatTranscriptEntry {
    pub line: String,
    pub fallback_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeChatTranscriptReadResult {
    entries: Vec<NativeChatTranscriptEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeChatTranscriptAppendedPayload {
    subscription_id: String,
    entries: Vec<NativeChatTranscriptEntry>,
}

#[tauri::command]
pub fn native_chat_read_session(
    input: NativeChatTranscriptInput,
    app: AppHandle,
) -> Result<NativeChatTranscriptReadResult, String> {
    let app_data = app.path().app_data_dir().ok();
    let path = resolve_transcript_path(
        &input.agent,
        &input.session_id,
        input.transcript_path.as_deref(),
        app_data.as_deref(),
    )?;
    let (entries, _) = read_complete_lines(&path, 0)?;
    Ok(NativeChatTranscriptReadResult { entries })
}

#[tauri::command]
pub fn native_chat_subscribe(
    input: NativeChatTranscriptWatchInput,
    app: AppHandle,
    state: State<'_, NativeChatWatcherState>,
) -> Result<(), String> {
    validate_subscription_id(&input.subscription_id)?;
    let app_data = app.path().app_data_dir().ok();
    let path = resolve_transcript_path(
        &input.agent,
        &input.session_id,
        input.transcript_path.as_deref(),
        app_data.as_deref(),
    )?;
    let cursor = Arc::new(Mutex::new(WatchCursor::default()));
    let callback_cursor = Arc::clone(&cursor);
    let callback_path = path.clone();
    let subscription_id = input.subscription_id.clone();
    let callback_app = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            if !matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Any
            ) {
                return;
            }
            drain_watched_file(
                &callback_app,
                &subscription_id,
                &callback_path,
                &callback_cursor,
            );
        },
        Config::default(),
    )
    .map_err(|error| format!("Could not create transcript watcher: {error}"))?;
    // Why: transcript writers may atomically replace a JSONL file. Watching
    // its parent keeps the subscription alive after the old inode disappears.
    watcher
        .watch(path.parent().unwrap_or(&path), RecursiveMode::NonRecursive)
        .map_err(|error| format!("Could not watch transcript: {error}"))?;

    let mut watchers = state
        .watchers
        .lock()
        .map_err(|_| "Native chat transcript watcher state is poisoned.".to_string())?;
    if let Some(previous) = watchers.remove(&input.subscription_id) {
        close_watcher(previous);
    }
    watchers.insert(
        input.subscription_id.clone(),
        TranscriptWatcher {
            _watcher: watcher,
            cursor: Arc::clone(&cursor),
        },
    );
    drop(watchers);

    // Why: starting at zero closes the read/watch race; stable byte IDs let the
    // renderer collapse records already returned by the initial read.
    drain_watched_file(&app, &input.subscription_id, &path, &cursor);
    Ok(())
}

#[tauri::command]
pub fn native_chat_unsubscribe(
    input: NativeChatTranscriptUnwatchInput,
    state: State<'_, NativeChatWatcherState>,
) -> Result<(), String> {
    validate_subscription_id(&input.subscription_id)?;
    let entry = state
        .watchers
        .lock()
        .map_err(|_| "Native chat transcript watcher state is poisoned.".to_string())?
        .remove(&input.subscription_id);
    if let Some(entry) = entry {
        close_watcher(entry);
    }
    Ok(())
}

fn close_watcher(entry: TranscriptWatcher) {
    if let Ok(mut cursor) = entry.cursor.lock() {
        cursor.closed = true;
    }
    drop(entry);
}

fn drain_watched_file(
    app: &AppHandle,
    subscription_id: &str,
    path: &Path,
    cursor: &Arc<Mutex<WatchCursor>>,
) {
    let Ok(mut cursor) = cursor.lock() else {
        return;
    };
    if cursor.closed {
        return;
    }
    let size = match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => metadata.len(),
        _ => return,
    };
    let truncated = size < cursor.offset;
    if truncated {
        cursor.offset = 0;
    }
    let Ok((entries, next_offset)) = read_complete_lines(path, cursor.offset) else {
        return;
    };
    cursor.offset = next_offset;
    if entries.is_empty() {
        return;
    }
    let _ = app.emit(
        NATIVE_CHAT_APPENDED_EVENT,
        NativeChatTranscriptAppendedPayload {
            subscription_id: subscription_id.to_string(),
            entries,
        },
    );
}

fn read_complete_lines(
    path: &Path,
    start_offset: u64,
) -> Result<(Vec<NativeChatTranscriptEntry>, u64), String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not open transcript: {error}"))?;
    let size = file
        .metadata()
        .map_err(|error| format!("Could not inspect transcript: {error}"))?
        .len();
    let start = start_offset.min(size);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("Could not seek transcript: {error}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read transcript: {error}"))?;

    let complete_len = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    let mut entries = Vec::new();
    let mut line_start = 0usize;
    for newline in bytes[..complete_len]
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| (*byte == b'\n').then_some(index))
    {
        let raw = &bytes[line_start..newline];
        if !raw.is_empty() {
            let byte_offset = start + line_start as u64;
            let line = std::str::from_utf8(raw)
                .map_err(|_| "Transcript contains a non-UTF-8 complete line.".to_string())?
                .to_string();
            entries.push(NativeChatTranscriptEntry {
                fallback_id: format!("{}:{byte_offset}", path.to_string_lossy()),
                line,
            });
        }
        line_start = newline + 1;
    }
    Ok((entries, start + complete_len as u64))
}

fn resolve_transcript_path(
    agent: &str,
    session_id: &str,
    supplied_path: Option<&str>,
    app_data: Option<&Path>,
) -> Result<PathBuf, String> {
    let session_id = validate_session_id(session_id)?;
    let roots = transcript_roots(agent, app_data)?;
    if let Some(candidate) = supplied_path.map(str::trim).filter(|path| !path.is_empty()) {
        let candidate = PathBuf::from(candidate);
        if candidate.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            if let Some(path) = canonical_file_within_roots(&candidate, &roots) {
                return Ok(path);
            }
        }
    }
    find_transcript(agent, session_id, &roots)?
        .ok_or_else(|| format!("No transcript found for {agent} session {session_id}."))
}

fn find_transcript(
    agent: &str,
    session_id: &str,
    roots: &[PathBuf],
) -> Result<Option<PathBuf>, String> {
    let mut visited = 0usize;
    for root in roots {
        let Ok(root) = root.canonicalize() else {
            continue;
        };
        let mut pending = vec![(root.clone(), 0usize)];
        while let Some((directory, depth)) = pending.pop() {
            let entries = std::fs::read_dir(&directory)
                .map_err(|error| format!("Could not search transcript directory: {error}"))?;
            for entry in entries {
                visited += 1;
                if visited > MAX_SEARCH_ENTRIES {
                    return Err("Transcript search exceeded its bounded entry limit.".to_string());
                }
                let Ok(entry) = entry else { continue };
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                // Why: refusing symlinks keeps recursive discovery inside the
                // approved agent homes even when those homes contain links.
                if file_type.is_symlink() {
                    continue;
                }
                let path = entry.path();
                if file_type.is_dir() && depth < MAX_SEARCH_DEPTH {
                    pending.push((path, depth + 1));
                } else if file_type.is_file() && transcript_name_matches(agent, &path, session_id) {
                    if let Some(path) =
                        canonical_file_within_roots(&path, std::slice::from_ref(&root))
                    {
                        return Ok(Some(path));
                    }
                }
            }
        }
    }
    Ok(None)
}

fn transcript_name_matches(agent: &str, path: &Path, session_id: &str) -> bool {
    if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return false;
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    match agent {
        "claude" => stem == session_id,
        "codex" => stem == session_id || stem.ends_with(&format!("-{session_id}")),
        _ => false,
    }
}

fn canonical_file_within_roots(candidate: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    let path = candidate.canonicalize().ok()?;
    if !path.metadata().ok()?.is_file() {
        return None;
    }
    roots
        .iter()
        .any(|root| {
            root.canonicalize()
                .ok()
                .is_some_and(|canonical_root| path.starts_with(canonical_root))
        })
        .then_some(path)
}

fn transcript_roots(agent: &str, app_data: Option<&Path>) -> Result<Vec<PathBuf>, String> {
    let home =
        user_home().ok_or_else(|| "Could not resolve the user home directory.".to_string())?;
    match agent {
        "claude" => Ok(vec![home.join(".claude").join("projects")]),
        "codex" => {
            let mut roots = Vec::new();
            // Why: the isolated functional shell needs a temporary approved
            // root without replacing the app's user-data path for other domains.
            if std::env::var_os("PEBBLE_FUNCTIONAL_GATE_EVIDENCE_PATH").is_some() {
                if let Some(root) = std::env::var_os("PEBBLE_NATIVE_CHAT_FIXTURE_ROOT") {
                    roots.push(PathBuf::from(root));
                }
            }
            if let Some(app_data) = app_data {
                roots.push(
                    app_data
                        .join("codex-runtime-home")
                        .join("home")
                        .join("sessions"),
                );
            }
            if let Some(user_data) = std::env::var_os("PEBBLE_USER_DATA_PATH") {
                roots.push(
                    PathBuf::from(user_data)
                        .join("codex-runtime-home")
                        .join("home")
                        .join("sessions"),
                );
            }
            let codex_home = std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"));
            roots.push(codex_home.join("sessions"));
            roots.dedup();
            Ok(roots)
        }
        _ => Err(format!(
            "Unsupported native chat transcript agent: {agent}."
        )),
    }
}

fn user_home() -> Option<PathBuf> {
    #[cfg(windows)]
    let keys = ["USERPROFILE", "HOME"];
    #[cfg(not(windows))]
    let keys = ["HOME", "USERPROFILE"];
    keys.into_iter().find_map(|key| {
        std::env::var_os(key)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    })
}

fn validate_session_id(session_id: &str) -> Result<&str, String> {
    let value = session_id.trim();
    if value.is_empty()
        || value.len() > 512
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
    {
        return Err("Invalid native chat transcript session id.".to_string());
    }
    Ok(value)
}

fn validate_subscription_id(subscription_id: &str) -> Result<(), String> {
    let value = subscription_id.trim();
    if value.is_empty() || value.len() > 512 || value.contains('\0') {
        return Err("Invalid native chat transcript subscription id.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn reads_only_complete_lines_with_byte_offsets() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        write(&path, "{\"text\":\"é\"}\n{\"partial\":true}").unwrap();
        let (entries, offset) = read_complete_lines(&path, 0).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].fallback_id,
            format!("{}:0", path.to_string_lossy())
        );
        assert_eq!(entries[0].line, "{\"text\":\"é\"}");
        assert_eq!(offset, "{\"text\":\"é\"}\n".len() as u64);
    }

    #[test]
    fn partial_tail_is_retried_from_the_same_offset() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        write(&path, "one\ntw").unwrap();
        let (_, offset) = read_complete_lines(&path, 0).unwrap();
        assert_eq!(offset, 4);
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"o\n")
            .unwrap();
        let (entries, next) = read_complete_lines(&path, offset).unwrap();
        assert_eq!(entries[0].line, "two");
        assert_eq!(
            entries[0].fallback_id,
            format!("{}:4", path.to_string_lossy())
        );
        assert_eq!(next, 8);
    }

    #[test]
    fn supplied_path_cannot_escape_agent_root() {
        let root = tempdir().unwrap();
        let allowed = root.path().join("allowed");
        create_dir_all(&allowed).unwrap();
        let outside = root.path().join("outside.jsonl");
        write(&outside, "{}\n").unwrap();
        assert!(canonical_file_within_roots(&outside, &[allowed]).is_none());
    }

    #[test]
    fn codex_matching_is_suffix_bound() {
        let path = Path::new("rollout-2026-07-18-session-1.jsonl");
        assert!(transcript_name_matches("codex", path, "session-1"));
        assert!(!transcript_name_matches("codex", path, "ession-1"));
    }

    #[test]
    fn rejects_session_path_components() {
        assert!(validate_session_id("../session").is_err());
        assert!(validate_session_id("folder\\session").is_err());
        assert!(validate_session_id("session-1").is_ok());
    }
}
