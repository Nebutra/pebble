use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalImportInput {
    source_paths: Vec<String>,
    dest_dir: String,
    #[serde(default)]
    ensure_dir: bool,
}

#[derive(Serialize)]
pub struct ExternalImportResult {
    results: Vec<ImportItemResult>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
enum ImportItemResult {
    Imported {
        #[serde(rename = "sourcePath")]
        source_path: String,
        #[serde(rename = "destPath")]
        dest_path: String,
        kind: &'static str,
        renamed: bool,
    },
    Skipped {
        #[serde(rename = "sourcePath")]
        source_path: String,
        reason: &'static str,
    },
    Failed {
        #[serde(rename = "sourcePath")]
        source_path: String,
        reason: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalStageInput {
    source_paths: Vec<String>,
}

#[derive(Serialize)]
pub struct ExternalStageResult {
    sources: Vec<StagedSource>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
enum StagedSource {
    Staged {
        #[serde(rename = "sourcePath")]
        source_path: String,
        name: String,
        kind: &'static str,
        entries: Vec<StagedEntry>,
    },
    Skipped {
        #[serde(rename = "sourcePath")]
        source_path: String,
        reason: &'static str,
    },
    Failed {
        #[serde(rename = "sourcePath")]
        source_path: String,
        reason: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum StagedEntry {
    Directory {
        #[serde(rename = "relativePath")]
        relative_path: String,
    },
    File {
        #[serde(rename = "relativePath")]
        relative_path: String,
        #[serde(rename = "contentBase64")]
        content_base64: String,
    },
}

#[tauri::command]
pub async fn fs_import_external_paths(
    input: ExternalImportInput,
) -> Result<ExternalImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || import_external_paths(input))
        .await
        .map_err(|error| format!("external import task failed: {error}"))
}

#[tauri::command]
pub async fn fs_stage_external_paths(
    input: ExternalStageInput,
) -> Result<ExternalStageResult, String> {
    tauri::async_runtime::spawn_blocking(move || stage_external_paths(input))
        .await
        .map_err(|error| format!("external staging task failed: {error}"))
}

fn import_external_paths(input: ExternalImportInput) -> ExternalImportResult {
    let destination = PathBuf::from(&input.dest_dir);
    if input.ensure_dir {
        let _ = fs::create_dir_all(&destination);
    }
    let mut reserved = HashSet::new();
    let results = input
        .source_paths
        .into_iter()
        .map(|source| import_one(&source, &destination, &mut reserved))
        .collect();
    ExternalImportResult { results }
}

fn import_one(
    source_path: &str,
    destination: &Path,
    reserved: &mut HashSet<String>,
) -> ImportItemResult {
    let source = PathBuf::from(source_path);
    let metadata = match fs::symlink_metadata(&source) {
        Ok(value) => value,
        Err(error) => return import_metadata_error(source_path, error),
    };
    if metadata.file_type().is_symlink() {
        return skipped_import(source_path, "symlink");
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return skipped_import(source_path, "unsupported");
    }
    if metadata.is_dir() {
        match contains_symlink(&source) {
            Ok(true) => return skipped_import(source_path, "symlink"),
            Err(error) => return failed_import(source_path, error),
            Ok(false) => {}
        }
    }
    let Some(original_name) = source.file_name().and_then(|name| name.to_str()) else {
        return failed_import(
            source_path,
            "Source path has no valid file name".to_string(),
        );
    };
    let final_name = deconflict_name(destination, original_name, reserved);
    let target = destination.join(&final_name);
    let copy_result = if metadata.is_dir() {
        copy_directory(&source, &target)
    } else {
        copy_file_exclusive(&source, &target)
    };
    if let Err(error) = copy_result {
        if metadata.is_dir() {
            let _ = fs::remove_dir_all(&target);
        }
        return failed_import(source_path, error.to_string());
    }
    reserved.insert(final_name.clone());
    ImportItemResult::Imported {
        source_path: source_path.to_string(),
        dest_path: target.to_string_lossy().to_string(),
        kind: if metadata.is_dir() {
            "directory"
        } else {
            "file"
        },
        renamed: final_name != original_name,
    }
}

fn stage_external_paths(input: ExternalStageInput) -> ExternalStageResult {
    ExternalStageResult {
        sources: input
            .source_paths
            .into_iter()
            .map(|source| stage_one(&source))
            .collect(),
    }
}

fn stage_one(source_path: &str) -> StagedSource {
    let source = PathBuf::from(source_path);
    let metadata = match fs::symlink_metadata(&source) {
        Ok(value) => value,
        Err(error) => return stage_metadata_error(source_path, error),
    };
    if metadata.file_type().is_symlink() {
        return skipped_stage(source_path, "symlink");
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return skipped_stage(source_path, "unsupported");
    }
    let Some(name) = source.file_name().and_then(|value| value.to_str()) else {
        return failed_stage(
            source_path,
            "Source path has no valid file name".to_string(),
        );
    };
    let mut entries = Vec::new();
    let mut total = 0;
    let result = if metadata.is_dir() {
        entries.push(StagedEntry::Directory {
            relative_path: String::new(),
        });
        stage_directory(&source, &source, &mut total, &mut entries)
    } else {
        stage_file(&source, "", &mut total).map(|entry| entries.push(entry))
    };
    match result {
        Ok(()) => StagedSource::Staged {
            source_path: source_path.to_string(),
            name: name.to_string(),
            kind: if metadata.is_dir() {
                "directory"
            } else {
                "file"
            },
            entries,
        },
        Err(StageError::Symlink) => skipped_stage(source_path, "symlink"),
        Err(StageError::Other(error)) => failed_stage(source_path, error),
    }
}

enum StageError {
    Symlink,
    Other(String),
}

fn stage_directory(
    root: &Path,
    directory: &Path,
    total: &mut u64,
    entries: &mut Vec<StagedEntry>,
) -> Result<(), StageError> {
    for item in fs::read_dir(directory).map_err(stage_io)? {
        let item = item.map_err(stage_io)?;
        let path = item.path();
        let metadata = fs::symlink_metadata(&path).map_err(stage_io)?;
        if metadata.file_type().is_symlink() {
            return Err(StageError::Symlink);
        }
        let relative = normalized_relative(root, &path)?;
        if metadata.is_dir() {
            entries.push(StagedEntry::Directory {
                relative_path: relative,
            });
            stage_directory(root, &path, total, entries)?;
        } else if metadata.is_file() {
            entries.push(stage_file(&path, &relative, total)?);
        } else {
            return Err(StageError::Other(format!(
                "Unsupported file type in '{relative}'"
            )));
        }
    }
    Ok(())
}

fn stage_file(path: &Path, relative: &str, total: &mut u64) -> Result<StagedEntry, StageError> {
    let before = fs::symlink_metadata(path).map_err(stage_io)?;
    if before.file_type().is_symlink() {
        return Err(StageError::Symlink);
    }
    if before.len() > MAX_FILE_BYTES {
        return Err(StageError::Other(format!(
            "'{relative}' is too large for remote import"
        )));
    }
    *total = total
        .checked_add(before.len())
        .ok_or_else(|| StageError::Other("Remote import size overflow".to_string()))?;
    if *total > MAX_TOTAL_BYTES {
        return Err(StageError::Other("Remote import is too large".to_string()));
    }
    let mut file = OpenOptions::new().read(true).open(path).map_err(stage_io)?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.read_to_end(&mut bytes).map_err(stage_io)?;
    let after = file.metadata().map_err(stage_io)?;
    if before.len() != after.len() {
        return Err(StageError::Other(format!(
            "File changed during upload staging: '{relative}'"
        )));
    }
    Ok(StagedEntry::File {
        relative_path: relative.to_string(),
        content_base64: BASE64_STANDARD.encode(bytes),
    })
}

fn contains_symlink(directory: &Path) -> Result<bool, String> {
    for item in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let path = item.map_err(|error| error.to_string())?.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Ok(true);
        }
        if metadata.is_dir() && contains_symlink(&path)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn copy_directory(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir(target)?;
    for item in fs::read_dir(source)? {
        let item = item?;
        let metadata = item.file_type()?;
        let child_target = target.join(item.file_name());
        if metadata.is_dir() {
            copy_directory(&item.path(), &child_target)?;
        } else if metadata.is_file() {
            copy_file_exclusive(&item.path(), &child_target)?;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unsupported import entry",
            ));
        }
    }
    Ok(())
}

fn copy_file_exclusive(source: &Path, target: &Path) -> io::Result<()> {
    let mut input = OpenOptions::new().read(true).open(source)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    io::copy(&mut input, &mut output)?;
    output.flush()
}

fn deconflict_name(destination: &Path, original: &str, reserved: &HashSet<String>) -> String {
    if !destination.join(original).exists() && !reserved.contains(original) {
        return original.to_string();
    }
    let path = Path::new(original);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(original);
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1..10_000 {
        let candidate = match extension {
            Some(extension) => format!("{stem} {index}.{extension}"),
            None => format!("{stem} {index}"),
        };
        if !destination.join(&candidate).exists() && !reserved.contains(&candidate) {
            return candidate;
        }
    }
    format!("{stem}-{}", std::process::id())
}

fn normalized_relative(root: &Path, path: &Path) -> Result<String, StageError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| StageError::Other("Path escaped upload root".to_string()))?;
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(StageError::Other("Path escaped upload root".to_string()));
    }
    Ok(relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn stage_io(error: io::Error) -> StageError {
    StageError::Other(error.to_string())
}

fn import_metadata_error(source: &str, error: io::Error) -> ImportItemResult {
    match error.kind() {
        io::ErrorKind::NotFound => skipped_import(source, "missing"),
        io::ErrorKind::PermissionDenied => skipped_import(source, "permission-denied"),
        _ => failed_import(source, error.to_string()),
    }
}

fn stage_metadata_error(source: &str, error: io::Error) -> StagedSource {
    match error.kind() {
        io::ErrorKind::NotFound => skipped_stage(source, "missing"),
        io::ErrorKind::PermissionDenied => skipped_stage(source, "permission-denied"),
        _ => failed_stage(source, error.to_string()),
    }
}

fn skipped_import(source: &str, reason: &'static str) -> ImportItemResult {
    ImportItemResult::Skipped {
        source_path: source.to_string(),
        reason,
    }
}

fn failed_import(source: &str, reason: String) -> ImportItemResult {
    ImportItemResult::Failed {
        source_path: source.to_string(),
        reason,
    }
}

fn skipped_stage(source: &str, reason: &'static str) -> StagedSource {
    StagedSource::Skipped {
        source_path: source.to_string(),
        reason,
    }
}

fn failed_stage(source: &str, reason: String) -> StagedSource {
    StagedSource::Failed {
        source_path: source.to_string(),
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("pebble-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn imports_without_overwriting_and_stages_bytes() {
        let root = temp_root("external-import");
        let source = root.join("note.txt");
        let destination = root.join("dest");
        fs::create_dir(&destination).unwrap();
        fs::write(&source, b"pebble").unwrap();
        fs::write(destination.join("note.txt"), b"existing").unwrap();

        let imported = import_external_paths(ExternalImportInput {
            source_paths: vec![source.to_string_lossy().to_string()],
            dest_dir: destination.to_string_lossy().to_string(),
            ensure_dir: false,
        });
        assert!(matches!(
            imported.results[0],
            ImportItemResult::Imported { renamed: true, .. }
        ));

        let staged = stage_external_paths(ExternalStageInput {
            source_paths: vec![source.to_string_lossy().to_string()],
        });
        assert!(matches!(staged.sources[0], StagedSource::Staged { .. }));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_sources() {
        use std::os::unix::fs::symlink;
        let root = temp_root("external-import-symlink");
        let source = root.join("source");
        fs::write(&source, b"secret").unwrap();
        let link = root.join("link");
        symlink(&source, &link).unwrap();
        let staged = stage_external_paths(ExternalStageInput {
            source_paths: vec![link.to_string_lossy().to_string()],
        });
        assert!(matches!(
            staged.sources[0],
            StagedSource::Skipped {
                reason: "symlink",
                ..
            }
        ));
        let _ = fs::remove_dir_all(root);
    }
}
