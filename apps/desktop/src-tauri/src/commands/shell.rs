use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_REPO_ICON_UPLOAD_BYTES: u64 = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOpenLocalPathResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoIconImageResult {
    data_url: String,
    file_name: String,
}

#[tauri::command]
pub fn shell_path_exists(path: String) -> bool {
    PathBuf::from(path).exists()
}

#[tauri::command]
pub fn shell_open_in_file_manager(path: String) -> ShellOpenLocalPathResult {
    let target = match validate_local_path_target(&path) {
        Ok(path) => path,
        Err(reason) => return shell_open_failure(reason),
    };
    if reveal_in_file_manager(&target) {
        shell_open_ok()
    } else {
        shell_open_failure("launch-failed")
    }
}

#[tauri::command]
pub fn shell_open_in_external_editor(
    path: String,
    command: Option<String>,
) -> ShellOpenLocalPathResult {
    let target = match validate_local_path_target(&path) {
        Ok(path) => path,
        Err(reason) => return shell_open_failure(reason),
    };
    if launch_external_editor(&target, command.as_deref()) {
        shell_open_ok()
    } else {
        shell_open_failure("launch-failed")
    }
}

#[tauri::command]
pub fn shell_open_file_path(path: String) -> bool {
    validate_local_path_target(&path)
        .map(|target| open_with_system_default(&target))
        .unwrap_or(false)
}

#[tauri::command]
pub fn shell_open_url(url: String) {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return;
    }
    let _ = open_raw_target(trimmed);
}

#[tauri::command]
pub fn shell_open_file_uri(uri: String) {
    let Some(path) = file_uri_to_path(&uri) else {
        return;
    };
    let _ = shell_open_file_path(path.to_string_lossy().into_owned());
}

#[tauri::command]
pub fn shell_pick_file(filter_name: String, extensions: Vec<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new();
    if !extensions.is_empty() {
        let extension_refs = extensions.iter().map(String::as_str).collect::<Vec<_>>();
        dialog = dialog.add_filter(filter_name, &extension_refs);
    }
    dialog
        .pick_file()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn shell_pick_directory(default_path: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(path) = default_path.filter(|path| !path.trim().is_empty()) {
        dialog = dialog.set_directory(path);
    }
    dialog
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn shell_pick_repo_icon_image() -> Result<Option<RepoIconImageResult>, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("Repo icon images", &["png"])
        .pick_file()
    else {
        return Ok(None);
    };
    if path.extension().and_then(|value| value.to_str()) != Some("png") {
        return Err("Repo icons must be PNG files.".to_string());
    }
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_REPO_ICON_UPLOAD_BYTES {
        return Err("Repo icon image must be 256KB or smaller.".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("repo-icon.png")
        .to_string();
    Ok(Some(RepoIconImageResult {
        data_url: format!("data:image/png;base64,{}", encode_base64(&bytes)),
        file_name,
    }))
}

#[tauri::command]
pub fn shell_copy_file(src_path: String, dest_path: String) -> Result<(), String> {
    let src = validate_absolute_path(&src_path).map_err(str::to_string)?;
    let dest = validate_absolute_path(&dest_path).map_err(str::to_string)?;
    let mut src_file = File::open(src).map_err(|error| error.to_string())?;
    let mut dest_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
        .map_err(|error| error.to_string())?;
    io::copy(&mut src_file, &mut dest_file)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn validate_local_path_target(path: &str) -> Result<PathBuf, &'static str> {
    let path = validate_absolute_path(path)?;
    if !path.exists() {
        return Err("not-found");
    }
    Ok(path)
}

fn validate_absolute_path(path: &str) -> Result<PathBuf, &'static str> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("not-absolute");
    }
    Ok(path)
}

fn reveal_in_file_manager(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        return Command::new("open").arg("-R").arg(path).spawn().is_ok();
    }
    #[cfg(target_os = "windows")]
    {
        return Command::new("explorer")
            .arg(format!("/select,{}", path.to_string_lossy()))
            .spawn()
            .is_ok();
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let target = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        Command::new("xdg-open").arg(target).spawn().is_ok()
    }
}

fn launch_external_editor(path: &Path, command: Option<&str>) -> bool {
    let command = command.map(str::trim).filter(|command| !command.is_empty());
    if let Some(command) = command {
        return Command::new(command).arg(path).spawn().is_ok();
    }
    open_with_system_default(path)
}

fn open_with_system_default(path: &Path) -> bool {
    open_raw_target(&path.to_string_lossy())
}

fn open_raw_target(target: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        return Command::new("open").arg(target).spawn().is_ok();
    }
    #[cfg(target_os = "windows")]
    {
        return Command::new("cmd")
            .args(["/C", "start", "", target])
            .spawn()
            .is_ok();
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        Command::new("xdg-open").arg(target).spawn().is_ok()
    }
}

fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    let raw = uri.strip_prefix("file://")?;
    let without_host = raw
        .strip_prefix("localhost/")
        .map(|value| format!("/{value}"))
        .unwrap_or_else(|| raw.to_string());
    let decoded = percent_decode(&without_host)?;
    #[cfg(target_os = "windows")]
    {
        let mut windows_decoded = decoded;
        if windows_decoded.len() > 3
            && windows_decoded.as_bytes()[0] == b'/'
            && windows_decoded.as_bytes()[2] == b':'
        {
            windows_decoded.remove(0);
        }
        return Some(PathBuf::from(windows_decoded));
    }
    #[cfg(not(target_os = "windows"))]
    Some(PathBuf::from(decoded))
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hi = hex_value(*bytes.get(index + 1)?)?;
            let lo = hex_value(*bytes.get(index + 2)?)?;
            output.push((hi << 4) | lo);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        output.push(TABLE[(b0 >> 2) as usize] as char);
        output.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(b2 & 0b0011_1111) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn shell_open_ok() -> ShellOpenLocalPathResult {
    ShellOpenLocalPathResult {
        ok: true,
        reason: None,
    }
}

fn shell_open_failure(reason: &'static str) -> ShellOpenLocalPathResult {
    ShellOpenLocalPathResult {
        ok: false,
        reason: Some(reason),
    }
}
