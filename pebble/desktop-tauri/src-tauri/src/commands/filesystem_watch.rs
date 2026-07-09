use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const FS_CHANGED_EVENT: &str = "pebble:fs-changed";
const DEBOUNCE_TRAILING_MS: u64 = 150;
const DEBOUNCE_MAX_WAIT_MS: u64 = 500;
const MAX_BATCHED_WATCHER_EVENTS: usize = 5_000;
const WATCHER_IGNORE_DIRS: [&str; 9] = [
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".cache",
    "target",
    ".venv",
    "__pycache__",
];

#[derive(Default)]
pub struct FsWatcherState {
    watchers: Mutex<HashMap<String, WatchEntry>>,
}

struct WatchEntry {
    _watcher: RecommendedWatcher,
    batch: Arc<Mutex<WatcherBatch>>,
    subscriber_count: usize,
}

#[derive(Default)]
struct WatcherBatch {
    events: Vec<RawFsEvent>,
    overflowed: bool,
    first_event_at: Option<Instant>,
    generation: u64,
}

#[derive(Clone)]
struct RawFsEvent {
    kind: RawFsEventKind,
    path: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RawFsEventKind {
    Create,
    Update,
    Delete,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsWatchInput {
    worktree_path: String,
    connection_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChangedPayload {
    worktree_path: String,
    events: Vec<FsChangeEvent>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChangeEvent {
    kind: &'static str,
    absolute_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_directory: Option<bool>,
}

#[tauri::command]
pub fn fs_watch_worktree(
    input: FsWatchInput,
    app: AppHandle,
    state: State<'_, FsWatcherState>,
) -> Result<(), String> {
    if input
        .connection_id
        .as_deref()
        .is_some_and(|id| !id.is_empty())
    {
        return Ok(());
    }

    let root_path = normalize_root_path(&input.worktree_path)?;
    let root_key = path_to_string(&root_path);
    let mut watchers = state
        .watchers
        .lock()
        .map_err(|_| "filesystem watcher state is poisoned".to_string())?;

    if let Some(entry) = watchers.get_mut(&root_key) {
        entry.subscriber_count = entry.subscriber_count.saturating_add(1);
        return Ok(());
    }

    match std::fs::metadata(&root_path) {
        Ok(metadata) if metadata.is_dir() => {}
        _ => return Ok(()),
    }

    let batch = Arc::new(Mutex::new(WatcherBatch::default()));
    let callback_batch = Arc::clone(&batch);
    let callback_root = root_path.clone();
    let callback_root_key = root_key.clone();
    let callback_app = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |result| match result {
            Ok(event) => queue_notify_event(
                callback_app.clone(),
                callback_root_key.clone(),
                callback_root.clone(),
                Arc::clone(&callback_batch),
                event,
            ),
            Err(error) => {
                eprintln!(
                    "[tauri-filesystem-watch] watcher error for {callback_root_key}: {error}"
                );
                emit_overflow(callback_app.clone(), callback_root_key.clone());
            }
        },
        Config::default(),
    )
    .map_err(|error| format!("failed to create filesystem watcher: {error}"))?;

    if let Err(error) = watcher.watch(&root_path, RecursiveMode::Recursive) {
        eprintln!("[tauri-filesystem-watch] failed to watch {root_key}: {error}");
        return Ok(());
    }

    watchers.insert(
        root_key,
        WatchEntry {
            _watcher: watcher,
            batch,
            subscriber_count: 1,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn fs_unwatch_worktree(
    input: FsWatchInput,
    state: State<'_, FsWatcherState>,
) -> Result<(), String> {
    if input
        .connection_id
        .as_deref()
        .is_some_and(|id| !id.is_empty())
    {
        return Ok(());
    }

    let root_path = normalize_root_path(&input.worktree_path)?;
    let root_key = path_to_string(&root_path);
    let mut watchers = state
        .watchers
        .lock()
        .map_err(|_| "filesystem watcher state is poisoned".to_string())?;

    let should_remove = match watchers.get_mut(&root_key) {
        Some(entry) if entry.subscriber_count > 1 => {
            entry.subscriber_count -= 1;
            false
        }
        Some(_) => true,
        None => false,
    };
    if should_remove {
        if let Some(entry) = watchers.remove(&root_key) {
            if let Ok(mut batch) = entry.batch.lock() {
                // Why: debounce tasks may still be pending after unwatch; bump
                // the generation and clear queued paths so they flush nothing.
                batch.events.clear();
                batch.overflowed = false;
                batch.first_event_at = None;
                batch.generation = batch.generation.wrapping_add(1);
            }
        }
    }
    Ok(())
}

fn queue_notify_event(
    app: AppHandle,
    root_key: String,
    root_path: PathBuf,
    batch: Arc<Mutex<WatcherBatch>>,
    event: Event,
) {
    let incoming = map_notify_event(event, &root_path);
    if incoming.is_empty() {
        return;
    }

    let (generation, first_event_at) = match queue_raw_events(&batch, incoming) {
        Some(snapshot) => snapshot,
        None => return,
    };

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(DEBOUNCE_TRAILING_MS)).await;
        let should_flush = batch
            .lock()
            .map(|current| {
                current.generation == generation
                    || current.first_event_at.is_some_and(|first| {
                        first.elapsed() >= Duration::from_millis(DEBOUNCE_MAX_WAIT_MS)
                    })
                    || first_event_at.elapsed() >= Duration::from_millis(DEBOUNCE_MAX_WAIT_MS)
            })
            .unwrap_or(false);
        if should_flush {
            flush_batch(app, root_key, batch);
        }
    });
}

fn queue_raw_events(
    batch: &Arc<Mutex<WatcherBatch>>,
    incoming: Vec<RawFsEvent>,
) -> Option<(u64, Instant)> {
    let mut current = batch.lock().ok()?;
    if !current.overflowed {
        if current.events.len() + incoming.len() > MAX_BATCHED_WATCHER_EVENTS {
            current.events.clear();
            current.overflowed = true;
        } else {
            current.events.extend(incoming);
        }
    }
    let first_event_at = *current.first_event_at.get_or_insert_with(Instant::now);
    current.generation = current.generation.wrapping_add(1);
    Some((current.generation, first_event_at))
}

fn flush_batch(app: AppHandle, root_key: String, batch: Arc<Mutex<WatcherBatch>>) {
    let (raw_events, overflowed) = match batch.lock() {
        Ok(mut current) => {
            let events = std::mem::take(&mut current.events);
            let overflowed = current.overflowed;
            current.overflowed = false;
            current.first_event_at = None;
            (events, overflowed)
        }
        Err(_) => return,
    };

    if overflowed || raw_events.len() > MAX_BATCHED_WATCHER_EVENTS {
        emit_overflow(app, root_key);
        return;
    }
    if raw_events.is_empty() {
        return;
    }

    let events = coalesce_events(raw_events)
        .into_iter()
        .map(|event| FsChangeEvent {
            kind: event.kind.as_str(),
            is_directory: if event.kind == RawFsEventKind::Delete {
                None
            } else {
                std::fs::metadata(&event.path)
                    .ok()
                    .map(|metadata| metadata.is_dir())
            },
            absolute_path: path_to_string(&event.path),
        })
        .collect();

    let _ = app.emit(
        FS_CHANGED_EVENT,
        FsChangedPayload {
            worktree_path: root_key,
            events,
        },
    );
}

fn emit_overflow(app: AppHandle, root_key: String) {
    let _ = app.emit(
        FS_CHANGED_EVENT,
        FsChangedPayload {
            worktree_path: root_key.clone(),
            events: vec![FsChangeEvent {
                kind: "overflow",
                absolute_path: root_key,
                is_directory: None,
            }],
        },
    );
}

fn map_notify_event(event: Event, root_path: &Path) -> Vec<RawFsEvent> {
    let Some(kind) = map_event_kind(&event.kind) else {
        return Vec::new();
    };
    event
        .paths
        .into_iter()
        .filter(|path| !is_ignored_path(root_path, path))
        .map(|path| RawFsEvent { kind, path })
        .collect()
}

fn map_event_kind(kind: &EventKind) -> Option<RawFsEventKind> {
    match kind {
        EventKind::Create(_) => Some(RawFsEventKind::Create),
        EventKind::Modify(_) => Some(RawFsEventKind::Update),
        EventKind::Remove(_) => Some(RawFsEventKind::Delete),
        EventKind::Any | EventKind::Other => Some(RawFsEventKind::Update),
        EventKind::Access(_) => None,
    }
}

fn coalesce_events(raw: Vec<RawFsEvent>) -> Vec<RawFsEvent> {
    let mut last_by_path: HashMap<PathBuf, (RawFsEventKind, usize)> = HashMap::new();
    let mut delete_before_create: Vec<PathBuf> = Vec::new();

    for (index, event) in raw.into_iter().enumerate() {
        if let Some((previous_kind, _)) = last_by_path.get(&event.path).copied() {
            if previous_kind == RawFsEventKind::Delete && event.kind == RawFsEventKind::Create {
                push_unique_path(&mut delete_before_create, event.path.clone());
            }
            if previous_kind == RawFsEventKind::Create && event.kind == RawFsEventKind::Delete {
                last_by_path.remove(&event.path);
                remove_path(&mut delete_before_create, &event.path);
                continue;
            }
        }

        if event.kind != RawFsEventKind::Create {
            remove_path(&mut delete_before_create, &event.path);
        }
        last_by_path.insert(event.path, (event.kind, index));
    }

    let mut result: Vec<RawFsEvent> = delete_before_create
        .into_iter()
        .map(|path| RawFsEvent {
            kind: RawFsEventKind::Delete,
            path,
        })
        .collect();
    let mut last_events: Vec<(usize, RawFsEvent)> = last_by_path
        .into_iter()
        .map(|(path, (kind, index))| (index, RawFsEvent { kind, path }))
        .collect();
    last_events.sort_by_key(|(index, _)| *index);
    result.extend(last_events.into_iter().map(|(_, event)| event));
    result
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if paths.iter().any(|existing| existing == &path) {
        return;
    }
    paths.push(path);
}

fn remove_path(paths: &mut Vec<PathBuf>, path: &Path) {
    paths.retain(|existing| existing != path);
}

impl RawFsEventKind {
    fn as_str(self) -> &'static str {
        match self {
            RawFsEventKind::Create => "create",
            RawFsEventKind::Update => "update",
            RawFsEventKind::Delete => "delete",
        }
    }
}

fn is_ignored_path(root_path: &Path, path: &Path) -> bool {
    let relative = path.strip_prefix(root_path).unwrap_or(path);
    relative.components().any(|component| match component {
        Component::Normal(name) => WATCHER_IGNORE_DIRS.iter().any(|ignored| name == *ignored),
        _ => false,
    })
}

fn normalize_root_path(value: &str) -> Result<PathBuf, String> {
    if value.trim().is_empty() {
        return Err("worktree path is required for filesystem watching".to_string());
    }
    let path = PathBuf::from(value);
    let absolute_path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map(|current| current.join(path))
            .map_err(|error| format!("failed to resolve worktree path: {error}"))?
    };
    Ok(normalize_platform_path(normalize_absolute_path(
        &absolute_path,
    )))
}

fn normalize_absolute_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
            Component::Prefix(_) | Component::RootDir => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

#[cfg(windows)]
fn normalize_platform_path(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return path;
    };
    if chars.next() == Some(':') && first.is_ascii_alphabetic() {
        return PathBuf::from(format!("{}{}", first.to_ascii_uppercase(), &value[1..]));
    }
    path
}

#[cfg(not(windows))]
fn normalize_platform_path(path: PathBuf) -> PathBuf {
    path
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_blank_watch_roots() {
        assert!(normalize_root_path("").is_err());
        assert!(normalize_root_path("   ").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn normalizes_absolute_watch_roots_without_requiring_existing_paths() {
        assert_eq!(
            normalize_root_path("/tmp/pebble-watch/../pebble-watch/./src").unwrap(),
            PathBuf::from("/tmp/pebble-watch/src")
        );
    }

    #[test]
    fn coalesces_create_then_delete_as_noop() {
        let path = PathBuf::from("/tmp/pebble-watch/file.txt");
        assert!(coalesce_events(vec![
            RawFsEvent {
                kind: RawFsEventKind::Create,
                path: path.clone(),
            },
            RawFsEvent {
                kind: RawFsEventKind::Delete,
                path,
            },
        ])
        .is_empty());
    }

    #[test]
    fn coalesces_delete_then_create_as_delete_and_create() {
        let path = PathBuf::from("/tmp/pebble-watch/file.txt");
        let events = coalesce_events(vec![
            RawFsEvent {
                kind: RawFsEventKind::Delete,
                path: path.clone(),
            },
            RawFsEvent {
                kind: RawFsEventKind::Create,
                path: path.clone(),
            },
        ]);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, RawFsEventKind::Delete);
        assert_eq!(events[0].path, path);
        assert_eq!(events[1].kind, RawFsEventKind::Create);
    }
}
