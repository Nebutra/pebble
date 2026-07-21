use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::Manager;

const MAX_THEME_FILES: usize = 200;
const MAX_THEME_FILE_BYTES: u64 = 1_000_000;
const MAX_DIRECTORY_DEPTH: usize = 3;
const MAX_DIRECTORIES: usize = 80;
const MAX_ENTRIES_PER_DIRECTORY: usize = 500;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarpThemeSourceInput {
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarpThemeFile {
    label: String,
    content: String,
    source_label: String,
    content_hash_discriminator: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarpThemeSkippedFile {
    label: String,
    reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarpThemeSourcesResult {
    canceled: bool,
    source_label: Option<String>,
    files: Vec<WarpThemeFile>,
    skipped_files: Vec<WarpThemeSkippedFile>,
}

#[tauri::command]
pub async fn settings_read_warp_theme_sources(
    app: tauri::AppHandle,
    input: WarpThemeSourceInput,
) -> Result<WarpThemeSourcesResult, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let (roots, canceled, manual_files) = match input.kind.as_str() {
        "auto" => (warp_theme_directories(&home), false, None),
        "chooseFile" => {
            let handles = rfd::AsyncFileDialog::new()
                .add_filter("Warp theme YAML", &["yaml", "yml"])
                .pick_files()
                .await;
            let Some(handles) = handles else {
                return Ok(canceled_result());
            };
            (
                Vec::new(),
                false,
                Some(
                    handles
                        .into_iter()
                        .map(|file| file.path().to_path_buf())
                        .collect(),
                ),
            )
        }
        "chooseFolder" => {
            let handle = rfd::AsyncFileDialog::new().pick_folder().await;
            let Some(handle) = handle else {
                return Ok(canceled_result());
            };
            (vec![handle.path().to_path_buf()], false, None)
        }
        _ => return Err("Invalid Warp theme import source.".into()),
    };
    if canceled {
        return Ok(canceled_result());
    }
    tauri::async_runtime::spawn_blocking(move || collect_sources(roots, manual_files))
        .await
        .map_err(|error| error.to_string())?
}

fn canceled_result() -> WarpThemeSourcesResult {
    WarpThemeSourcesResult {
        canceled: true,
        source_label: None,
        files: Vec::new(),
        skipped_files: Vec::new(),
    }
}

fn collect_sources(
    roots: Vec<PathBuf>,
    manual_files: Option<Vec<PathBuf>>,
) -> Result<WarpThemeSourcesResult, String> {
    let manual_selection = manual_files.is_some();
    let mut paths = Vec::new();
    let mut skipped = Vec::new();
    let mut visited = 0usize;
    if let Some(files) = manual_files {
        paths.extend(files.into_iter().filter(|path| is_yaml(path)));
        paths.sort_by_key(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().to_lowercase())
        });
    } else {
        for root in &roots {
            scan_directory(root, root, 0, &mut visited, &mut paths, &mut skipped);
            if paths.len() >= MAX_THEME_FILES {
                break;
            }
        }
    }
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for path in paths {
        let key = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if !seen.insert(key) {
            continue;
        }
        if files.len() >= MAX_THEME_FILES {
            break;
        }
        let label = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Warp theme".into());
        let metadata = match fs::metadata(&path) {
            Ok(value) => value,
            Err(_) => {
                skipped.push(skip(&label, "Could not read file."));
                continue;
            }
        };
        if !metadata.is_file() {
            skipped.push(skip(&label, "Not a file."));
            continue;
        }
        if metadata.len() > MAX_THEME_FILE_BYTES {
            skipped.push(skip(
                &label,
                &format!(
                    "File is too large to import ({} bytes, limit {MAX_THEME_FILE_BYTES}).",
                    metadata.len()
                ),
            ));
            continue;
        }
        match fs::read_to_string(&path) {
            Ok(content) => files.push(WarpThemeFile {
                label,
                content,
                source_label: "Warp themes".into(),
                content_hash_discriminator: manual_selection,
            }),
            Err(_) => skipped.push(skip(&label, "Could not read file.")),
        }
    }
    if files.len() >= MAX_THEME_FILES {
        skipped.push(skip(
            "Warp themes",
            "Only the first 200 theme files were scanned.",
        ));
    }
    let source_label = if manual_selection && files.len() == 1 {
        files.first().map(|file| file.label.clone())
    } else {
        Some("Warp themes".into())
    };
    Ok(WarpThemeSourcesResult {
        canceled: false,
        source_label,
        files,
        skipped_files: skipped,
    })
}

fn scan_directory(
    root: &Path,
    directory: &Path,
    depth: usize,
    visited: &mut usize,
    files: &mut Vec<PathBuf>,
    skipped: &mut Vec<WarpThemeSkippedFile>,
) {
    if *visited >= MAX_DIRECTORIES || files.len() >= MAX_THEME_FILES {
        return;
    }
    *visited += 1;
    let mut entries = match fs::read_dir(directory) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .take(MAX_ENTRIES_PER_DIRECTORY + 1)
            .collect::<Vec<_>>(),
        Err(_) => {
            skipped.push(skip(
                &relative_label(root, directory),
                "Could not read folder.",
            ));
            return;
        }
    };
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
    if entries.len() > MAX_ENTRIES_PER_DIRECTORY {
        entries.truncate(MAX_ENTRIES_PER_DIRECTORY);
        skipped.push(skip(
            &relative_label(root, directory),
            "Only the first 500 folder entries were scanned.",
        ));
    }
    for entry in entries {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if (file_type.is_file() || file_type.is_symlink()) && is_yaml(&path) {
            files.push(path);
        } else if file_type.is_dir() {
            if depth >= MAX_DIRECTORY_DEPTH {
                skipped.push(skip(
                    &relative_label(root, &path),
                    "Nested folder depth limit reached.",
                ));
            } else {
                scan_directory(root, &path, depth + 1, visited, files, skipped);
            }
        }
        if files.len() >= MAX_THEME_FILES {
            return;
        }
    }
}

fn is_yaml(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("yaml" | "yml")
    )
}
fn relative_label(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or(root)
        .to_string_lossy()
        .into_owned()
}
fn skip(label: &str, reason: &str) -> WarpThemeSkippedFile {
    WarpThemeSkippedFile {
        label: label.into(),
        reason: reason.into(),
    }
}

fn warp_theme_directories(home: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return [
            ".warp",
            ".warp-preview",
            ".warp-oss",
            ".warp-dev",
            ".warp-local",
            ".warp-integration",
        ]
        .into_iter()
        .map(|name| home.join(name).join("themes"))
        .collect();
    }
    #[cfg(target_os = "linux")]
    {
        let data = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".local/share"));
        return [
            "warp-terminal",
            "warp-terminal-preview",
            "warp-oss",
            "warp-terminal-dev",
            "warp-terminal-local",
            "warp-terminal-integration",
        ]
        .into_iter()
        .map(|name| data.join(name).join("themes"))
        .collect();
    }
    #[cfg(target_os = "windows")]
    {
        let root = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.to_path_buf())
            .join("warp");
        return [
            "Warp",
            "WarpPreview",
            "WarpOss",
            "WarpDev",
            "WarpLocal",
            "WarpIntegration",
        ]
        .into_iter()
        .map(|name| root.join(name).join("data/themes"))
        .collect();
    }
    #[allow(unreachable_code)]
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn yaml_filter_is_case_insensitive() {
        assert!(is_yaml(Path::new("theme.YML")));
        assert!(!is_yaml(Path::new("theme.json")));
    }
}
