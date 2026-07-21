use std::borrow::Cow;
use std::fs;

use arboard::{Clipboard, ImageData};
#[cfg(target_os = "linux")]
use arboard::{GetExtLinux, LinuxClipboardKind, SetExtLinux};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use image::ImageFormat;
use serde::Serialize;
use tauri::{AppHandle, Manager};

const MAX_CLIPBOARD_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFileResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

#[tauri::command]
pub fn clipboard_read_text() -> Result<String, String> {
    let text = Clipboard::new()
        .map_err(clipboard_error)?
        .get_text()
        .map_err(clipboard_error)?;
    if text.len() > MAX_CLIPBOARD_TEXT_BYTES {
        return Err("Clipboard text exceeds the desktop safety limit.".to_string());
    }
    Ok(text)
}

#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    if text.len() > MAX_CLIPBOARD_TEXT_BYTES {
        return Err("Clipboard text exceeds the desktop safety limit.".to_string());
    }
    Clipboard::new()
        .map_err(clipboard_error)?
        .set_text(text)
        .map_err(clipboard_error)
}

#[tauri::command]
pub fn clipboard_read_selection_text() -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        let mut clipboard = Clipboard::new().map_err(clipboard_error)?;
        let text = clipboard
            .get()
            .clipboard(LinuxClipboardKind::Primary)
            .text()
            .map_err(clipboard_error)?;
        if text.len() > MAX_CLIPBOARD_TEXT_BYTES {
            return Err("Clipboard text exceeds the desktop safety limit.".to_string());
        }
        return Ok(text);
    }
    #[cfg(not(target_os = "linux"))]
    clipboard_read_text()
}

#[tauri::command]
pub fn clipboard_write_selection_text(text: String) -> Result<(), String> {
    if text.len() > MAX_CLIPBOARD_TEXT_BYTES {
        return Err("Clipboard text exceeds the desktop safety limit.".to_string());
    }
    #[cfg(target_os = "linux")]
    {
        return Clipboard::new()
            .map_err(clipboard_error)?
            .set()
            .clipboard(LinuxClipboardKind::Primary)
            .text(text)
            .map_err(clipboard_error);
    }
    #[cfg(not(target_os = "linux"))]
    clipboard_write_text(text)
}

#[tauri::command]
pub fn clipboard_write_file(file_path: String) -> Result<ClipboardFileResult, String> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() || trimmed.len() > 32_768 {
        return Ok(clipboard_file_rejected("invalid-path"));
    }
    let path = match fs::canonicalize(trimmed) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(clipboard_file_rejected("not-found"));
        }
        Err(_) => return Ok(clipboard_file_rejected("invalid-path")),
    };
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(clipboard_file_rejected("not-found"));
        }
        Err(_) => return Ok(clipboard_file_rejected("invalid-path")),
    };
    if metadata.is_dir() {
        return Ok(clipboard_file_rejected("is-directory"));
    }
    if !metadata.is_file() {
        return Ok(clipboard_file_rejected("invalid-path"));
    }
    Clipboard::new()
        .map_err(clipboard_error)?
        .set()
        .file_list(&[path])
        .map_err(clipboard_error)?;
    Ok(ClipboardFileResult {
        ok: true,
        reason: None,
    })
}

fn clipboard_file_rejected(reason: &'static str) -> ClipboardFileResult {
    ClipboardFileResult {
        ok: false,
        reason: Some(reason),
    }
}

#[tauri::command]
pub fn clipboard_save_image_as_temp_file(app: AppHandle) -> Result<Option<String>, String> {
    let image = match Clipboard::new().map_err(clipboard_error)?.get_image() {
        Ok(image) => image,
        Err(arboard::Error::ContentNotAvailable) => return Ok(None),
        Err(error) => return Err(clipboard_error(error)),
    };
    validate_image_size(image.width, image.height, image.bytes.len())?;
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("clipboard-images");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join(format!("pebble-paste-{}.png", uuid::Uuid::new_v4()));
    image::save_buffer_with_format(
        &path,
        &image.bytes,
        image.width as u32,
        image.height as u32,
        image::ColorType::Rgba8,
        ImageFormat::Png,
    )
    .map_err(|error| error.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn clipboard_save_image_bytes_as_temp_file(
    app: AppHandle,
    content_base64: String,
) -> Result<String, String> {
    let bytes = BASE64_STANDARD
        .decode(content_base64)
        .map_err(|_| "Clipboard image is not valid base64.".to_string())?;
    if bytes.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err("Clipboard image exceeds the desktop safety limit.".to_string());
    }
    // Why: decode once before persistence so malformed or non-image payloads
    // never become trusted paste artifacts consumed by terminal agents.
    image::load_from_memory(&bytes).map_err(|error| error.to_string())?;
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("clipboard-images");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join(format!("pebble-paste-{}.png", uuid::Uuid::new_v4()));
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn clipboard_write_image(data_url: String) -> Result<(), String> {
    let encoded = data_url
        .split_once(',')
        .filter(|(prefix, _)| prefix.starts_with("data:image/") && prefix.ends_with(";base64"))
        .map(|(_, encoded)| encoded)
        .ok_or_else(|| "Clipboard image must be a base64 image data URL.".to_string())?;
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "Clipboard image is not valid base64.".to_string())?;
    if bytes.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err("Clipboard image exceeds the desktop safety limit.".to_string());
    }
    let decoded = image::load_from_memory(&bytes).map_err(|error| error.to_string())?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    validate_image_size(width as usize, height as usize, rgba.len())?;
    Clipboard::new()
        .map_err(clipboard_error)?
        .set_image(ImageData {
            width: width as usize,
            height: height as usize,
            bytes: Cow::Owned(rgba.into_raw()),
        })
        .map_err(clipboard_error)
}

fn validate_image_size(width: usize, height: usize, bytes: usize) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > 16_384
        || height > 16_384
        || bytes > MAX_CLIPBOARD_IMAGE_BYTES
    {
        return Err("Clipboard image dimensions exceed the desktop safety limit.".to_string());
    }
    Ok(())
}

fn clipboard_error(error: arboard::Error) -> String {
    format!("Native clipboard operation failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversized_image_dimensions() {
        assert!(validate_image_size(20_000, 1, 4).is_err());
        assert!(validate_image_size(1, 1, 4).is_ok());
    }

    #[test]
    fn rejects_missing_and_directory_clipboard_files_before_opening_the_clipboard() {
        let missing = clipboard_write_file(
            std::env::temp_dir()
                .join("pebble-missing-clipboard-file")
                .to_string_lossy()
                .into_owned(),
        )
        .unwrap();
        assert!(!missing.ok);
        assert_eq!(missing.reason, Some("not-found"));

        let directory = tempfile::tempdir().unwrap();
        let rejected =
            clipboard_write_file(directory.path().to_string_lossy().into_owned()).unwrap();
        assert!(!rejected.ok);
        assert_eq!(rejected.reason, Some("is-directory"));
    }
}
