use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_UPLOAD_FILES: usize = 16;
const MAX_UPLOAD_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserUploadFile {
    name: String,
    mime_type: String,
    data_base64: String,
}

#[tauri::command]
pub async fn browser_read_upload_files(
    paths: Vec<String>,
) -> Result<Vec<BrowserUploadFile>, String> {
    tauri::async_runtime::spawn_blocking(move || read_upload_files(paths))
        .await
        .map_err(|error| format!("browser upload task failed: {error}"))?
}

fn read_upload_files(paths: Vec<String>) -> Result<Vec<BrowserUploadFile>, String> {
    if paths.is_empty() || paths.len() > MAX_UPLOAD_FILES {
        return Err(format!(
            "browser upload requires 1 to {MAX_UPLOAD_FILES} files"
        ));
    }
    let mut total_bytes = 0u64;
    let mut files = Vec::with_capacity(paths.len());
    for raw_path in paths {
        let path = PathBuf::from(raw_path);
        let metadata = std::fs::metadata(&path).map_err(|error| {
            format!("could not inspect upload file {}: {error}", path.display())
        })?;
        if !metadata.is_file() {
            return Err(format!(
                "browser upload path is not a file: {}",
                path.display()
            ));
        }
        if metadata.len() > MAX_UPLOAD_FILE_BYTES {
            return Err(format!(
                "browser upload file is too large: {}",
                path.display()
            ));
        }
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| "browser upload size overflow".to_string())?;
        if total_bytes > MAX_UPLOAD_TOTAL_BYTES {
            return Err("browser upload total exceeds 64 MiB".to_string());
        }
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("could not read upload file {}: {error}", path.display()))?;
        files.push(BrowserUploadFile {
            name: upload_file_name(&path)?,
            mime_type: upload_mime_type(&path).to_string(),
            data_base64: BASE64_STANDARD.encode(bytes),
        });
    }
    Ok(files)
}

fn upload_file_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("browser upload file name is invalid: {}", path.display()))
}

fn upload_mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("txt" | "md" | "csv") => "text/plain",
        Some("html" | "htm") => "text/html",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_bounded_upload_files() {
        let path = std::env::temp_dir().join(format!("pebble-upload-{}.txt", std::process::id()));
        std::fs::write(&path, b"pebble upload").unwrap();
        let files = read_upload_files(vec![path.to_string_lossy().to_string()]).unwrap();
        std::fs::remove_file(path).unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].mime_type, "text/plain");
        assert_eq!(files[0].data_base64, "cGViYmxlIHVwbG9hZA==");
    }

    #[test]
    fn rejects_empty_and_non_file_uploads() {
        assert!(read_upload_files(Vec::new()).is_err());
        assert!(
            read_upload_files(vec![std::env::temp_dir().to_string_lossy().to_string()]).is_err()
        );
    }
}
