//! File-backed store for named JSON documents (settings, onboarding,
//! keybindings) under the app data directory. Mirrors the Electron persistence
//! contract: atomic tmp+rename writes, schema-tolerant reads, and corrupt-file
//! tolerance (treat as absent + preserve the bad bytes as a .bak sidecar).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Documents live under `<app_data_dir>/settings-store/<name>.json`. The
/// subdirectory keeps these renderer-owned blobs from colliding with other
/// files the shell may drop in the app data root.
const STORE_SUBDIR: &str = "settings-store";

/// Only these document names are writable from the renderer bridge. An
/// allowlist keeps a compromised/confused caller from writing arbitrary paths
/// (e.g. `../../foo`) into the user's data directory.
pub const ALLOWED_DOCUMENTS: &[&str] = &["settings", "onboarding", "keybindings"];

#[derive(Debug)]
pub enum StoreError {
    /// The requested document name is not in the allowlist.
    ForbiddenName,
    /// An underlying filesystem operation failed.
    Io(io::Error),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::ForbiddenName => write!(f, "forbidden settings document name"),
            StoreError::Io(err) => write!(f, "settings store io error: {err}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<io::Error> for StoreError {
    fn from(err: io::Error) -> Self {
        StoreError::Io(err)
    }
}

fn is_allowed(name: &str) -> bool {
    ALLOWED_DOCUMENTS.contains(&name)
}

/// Resolve the app data directory and read a document. Errors surface to the
/// renderer as strings so the bridge can fall back to localStorage.
#[tauri::command]
pub fn read_settings_document(
    app: tauri::AppHandle,
    name: String,
) -> Result<Option<String>, String> {
    let base = app_data_dir(&app)?;
    read_document(&base, &name).map_err(|err| err.to_string())
}

/// Resolve the app data directory and atomically write a document.
#[tauri::command]
pub fn write_settings_document(
    app: tauri::AppHandle,
    name: String,
    contents: String,
) -> Result<(), String> {
    let base = app_data_dir(&app)?;
    write_document(&base, &name, &contents).map_err(|err| err.to_string())
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map_err(|err| format!("failed to resolve app data dir: {err}"))
}

fn document_path(base_dir: &Path, name: &str) -> PathBuf {
    base_dir.join(STORE_SUBDIR).join(format!("{name}.json"))
}

/// Read a named document. Returns `Ok(None)` when the file is absent OR when it
/// is present but not parseable JSON. A corrupt file is renamed to a `.bak`
/// sidecar so the caller can fall through to defaults without losing forensic
/// bytes and without re-tripping on every read.
pub fn read_document(base_dir: &Path, name: &str) -> Result<Option<String>, StoreError> {
    if !is_allowed(name) {
        return Err(StoreError::ForbiddenName);
    }
    let path = document_path(base_dir, name);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(StoreError::Io(err)),
    };
    if serde_json::from_str::<serde_json::Value>(&raw).is_ok() {
        return Ok(Some(raw));
    }
    // Corrupt-file tolerance: quarantine the unparseable bytes, then report
    // absent so the renderer restores defaults (mirrors Electron's .bak path).
    quarantine_corrupt(&path);
    Ok(None)
}

/// Atomically write a named document. Validates that `contents` is JSON so a
/// corrupt payload can never be persisted, then writes to a uniquely-named tmp
/// file in the same directory and renames it over the destination.
pub fn write_document(base_dir: &Path, name: &str, contents: &str) -> Result<(), StoreError> {
    if !is_allowed(name) {
        return Err(StoreError::ForbiddenName);
    }
    // Refuse to persist non-JSON so a later read never has to quarantine our
    // own writes.
    serde_json::from_str::<serde_json::Value>(contents)
        .map_err(|err| StoreError::Io(io::Error::new(io::ErrorKind::InvalidData, err)))?;
    let path = document_path(base_dir, name);
    let dir = path
        .parent()
        .expect("document path always has a parent directory");
    fs::create_dir_all(dir)?;

    let tmp_path = temp_path(&path);
    // Same-directory tmp guarantees the rename is atomic (same filesystem).
    match fs::write(&tmp_path, contents) {
        Ok(()) => {}
        Err(err) => {
            let _ = fs::remove_file(&tmp_path);
            return Err(StoreError::Io(err));
        }
    }
    if let Err(err) = fs::rename(&tmp_path, &path) {
        // Failed rename must not leak a multi-KB tmp orphan.
        let _ = fs::remove_file(&tmp_path);
        return Err(StoreError::Io(err));
    }
    Ok(())
}

fn quarantine_corrupt(path: &Path) {
    let mut bak = path.as_os_str().to_owned();
    bak.push(".bak");
    // Best-effort: a failure here still lets read_document report absent.
    let _ = fs::rename(path, PathBuf::from(bak));
}

/// Build a collision-resistant tmp path next to the destination file. The
/// pid+timestamp+counter naming mirrors Electron so two writers never race over
/// one tmp path.
fn temp_path(path: &Path) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{pid}.{nanos}.{seq}.tmp"));
    PathBuf::from(tmp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_base() -> PathBuf {
        let mut dir = std::env::temp_dir();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        dir.push(format!(
            "pebble-settings-store-test-{}-{}",
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn absent_document_reads_as_none() {
        let base = temp_base();
        assert!(read_document(&base, "settings").unwrap().is_none());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn write_then_read_roundtrips() {
        let base = temp_base();
        let payload = r#"{"theme":"dark","fontSize":13}"#;
        write_document(&base, "settings", payload).unwrap();
        let read = read_document(&base, "settings").unwrap().unwrap();
        assert_eq!(read, payload);
        // A roundtrip must survive JSON re-parse to the same value.
        let parsed: serde_json::Value = serde_json::from_str(&read).unwrap();
        assert_eq!(parsed["theme"], "dark");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn corrupt_document_reads_as_none_and_is_quarantined() {
        let base = temp_base();
        let path = document_path(&base, "onboarding");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ this is not valid json ]").unwrap();

        assert!(read_document(&base, "onboarding").unwrap().is_none());
        // Original is gone; a .bak sidecar holds the corrupt bytes.
        assert!(!path.exists());
        let mut bak = path.as_os_str().to_owned();
        bak.push(".bak");
        assert_eq!(
            fs::read_to_string(PathBuf::from(bak)).unwrap(),
            "{ this is not valid json ]"
        );
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn write_refuses_non_json_payload() {
        let base = temp_base();
        let err = write_document(&base, "settings", "not json").unwrap_err();
        assert!(matches!(err, StoreError::Io(_)));
        // Nothing must be persisted from a rejected write.
        assert!(read_document(&base, "settings").unwrap().is_none());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn forbidden_names_are_rejected_both_ways() {
        let base = temp_base();
        assert!(matches!(
            read_document(&base, "../escape").unwrap_err(),
            StoreError::ForbiddenName
        ));
        assert!(matches!(
            write_document(&base, "secrets", "{}").unwrap_err(),
            StoreError::ForbiddenName
        ));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn temp_path_is_in_same_directory_and_unique() {
        let base = temp_base();
        let path = document_path(&base, "settings");
        let a = temp_path(&path);
        let b = temp_path(&path);
        // Atomic rename requires the tmp file to be a sibling of the target.
        assert_eq!(a.parent(), path.parent());
        assert!(a.to_string_lossy().ends_with(".tmp"));
        assert_ne!(a, b);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn write_leaves_no_tmp_orphans() {
        let base = temp_base();
        write_document(&base, "settings", "{}").unwrap();
        let store_dir = base.join(STORE_SUBDIR);
        let leftover: Vec<_> = fs::read_dir(&store_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftover.is_empty(), "tmp orphan left behind: {leftover:?}");
        fs::remove_dir_all(&base).ok();
    }
}
