use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

const MAX_IMAGE_BASE64_CHARS: usize = 96 * 1024 * 1024;
const MAX_PDF_BASE64_CHARS: usize = 192 * 1024 * 1024;
const MAX_HAR_BASE64_CHARS: usize = 48 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureSaveInput {
    pub path: String,
    pub base_dir: Option<String>,
    pub data_base64: String,
    pub kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureReadInput {
    pub path: String,
    pub base_dir: Option<String>,
    pub kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureReadResult {
    pub path: String,
    pub data_base64: String,
}

#[tauri::command]
pub fn browser_capture_save(input: BrowserCaptureSaveInput) -> Result<String, String> {
    let extensions = capture_extensions(&input.kind)?;
    let limit = match input.kind.as_str() {
        "pdf" => MAX_PDF_BASE64_CHARS,
        "har" => MAX_HAR_BASE64_CHARS,
        _ => MAX_IMAGE_BASE64_CHARS,
    };
    if input.data_base64.is_empty() || input.data_base64.len() > limit {
        return Err("Browser capture payload is outside the save limit.".to_string());
    }
    let target = resolve_capture_path(&input.path, input.base_dir.as_deref())?;
    validate_capture_extension(&target, extensions)?;
    let bytes = STANDARD
        .decode(&input.data_base64)
        .map_err(|_| "Browser capture payload is not valid base64.".to_string())?;
    atomic_write(&target, &bytes)?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn browser_capture_read(
    input: BrowserCaptureReadInput,
) -> Result<BrowserCaptureReadResult, String> {
    let extensions = capture_extensions(&input.kind)?;
    let target = resolve_capture_path(&input.path, input.base_dir.as_deref())?;
    validate_capture_extension(&target, extensions)?;
    if fs::symlink_metadata(&target)
        .map_err(|error| format!("Browser capture baseline is unavailable: {error}"))?
        .file_type()
        .is_symlink()
    {
        return Err("Browser capture baseline cannot be a symbolic link.".to_string());
    }
    let canonical = fs::canonicalize(&target)
        .map_err(|error| format!("Browser capture baseline is unavailable: {error}"))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("Could not inspect browser capture baseline: {error}"))?;
    let limit = if input.kind == "snapshot" {
        MAX_SNAPSHOT_BYTES
    } else {
        (MAX_IMAGE_BASE64_CHARS as u64 / 4) * 3
    };
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit {
        return Err("Browser capture baseline is outside the read limit.".to_string());
    }
    let bytes = fs::read(&canonical)
        .map_err(|error| format!("Could not read browser capture baseline: {error}"))?;
    Ok(BrowserCaptureReadResult {
        path: canonical.to_string_lossy().into_owned(),
        data_base64: STANDARD.encode(bytes),
    })
}

fn capture_extensions(kind: &str) -> Result<&'static [&'static str], String> {
    match kind {
        "png" => Ok(&["png"]),
        "jpeg" => Ok(&["jpg", "jpeg"]),
        "pdf" => Ok(&["pdf"]),
        "har" => Ok(&["har"]),
        "snapshot" => Ok(&["txt"]),
        _ => Err("Browser capture kind must be png, jpeg, pdf, har, or snapshot.".to_string()),
    }
}

fn validate_capture_extension(target: &Path, extensions: &[&str]) -> Result<(), String> {
    let target_extension = target
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if extensions
        .iter()
        .any(|extension| target_extension.as_deref() == Some(extension))
    {
        return Ok(());
    }
    Err(format!(
        "Browser capture path must use one of: {}.",
        extensions
            .iter()
            .map(|extension| format!(".{extension}"))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn resolve_capture_path(value: &str, base_dir: Option<&str>) -> Result<PathBuf, String> {
    let requested = Path::new(value);
    if requested.as_os_str().is_empty() {
        return Err("Browser capture path is required.".to_string());
    }
    if requested.is_absolute() {
        return Ok(requested.to_path_buf());
    }
    if requested
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("Relative browser capture paths cannot escape the workspace.".to_string());
    }
    let base = base_dir
        .ok_or_else(|| "Relative browser capture paths require a local workspace.".to_string())?;
    Ok(Path::new(base).join(requested))
}

fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Browser capture path has no parent directory.".to_string())?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("Browser capture parent directory is unavailable: {error}"))?;
    if fs::symlink_metadata(target).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Browser capture path cannot be a symbolic link.".to_string());
    }
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Browser capture file name is invalid.".to_string())?;
    let temp = canonical_parent.join(format!(".{file_name}.pebble-{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)
        .map_err(|error| format!("Could not create browser capture file: {error}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not write browser capture file: {error}"))?;
    fs::rename(&temp, canonical_parent.join(file_name))
        .map_err(|error| format!("Could not finalize browser capture file: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_stay_inside_the_workspace() {
        assert_eq!(
            resolve_capture_path("captures/page.png", Some("/workspace")).unwrap(),
            Path::new("/workspace/captures/page.png")
        );
        assert!(resolve_capture_path("../page.png", Some("/workspace")).is_err());
        assert!(resolve_capture_path("page.png", None).is_err());
    }

    #[test]
    fn har_capture_requires_a_har_extension() {
        assert_eq!(capture_extensions("har").unwrap(), &["har"]);
        assert_eq!(capture_extensions("snapshot").unwrap(), &["txt"]);
        assert!(capture_extensions("json").is_err());
    }

    #[test]
    fn reads_bounded_snapshot_baselines_from_the_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("before.txt");
        fs::write(&path, b"main\n  heading").unwrap();
        let result = browser_capture_read(BrowserCaptureReadInput {
            path: "before.txt".to_string(),
            base_dir: Some(directory.path().to_string_lossy().into_owned()),
            kind: "snapshot".to_string(),
        })
        .unwrap();
        assert_eq!(
            STANDARD.decode(result.data_base64).unwrap(),
            b"main\n  heading"
        );
        assert!(browser_capture_read(BrowserCaptureReadInput {
            path: "before.txt".to_string(),
            base_dir: Some(directory.path().to_string_lossy().into_owned()),
            kind: "png".to_string(),
        })
        .is_err());
    }
}
