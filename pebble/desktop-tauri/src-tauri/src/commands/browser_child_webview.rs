use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{
    webview::DownloadEvent, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State,
    WebviewUrl,
};

#[path = "browser_download_file_progress.rs"]
mod browser_download_file_progress;
#[path = "browser_webview_download_windows.rs"]
mod browser_webview_download_windows;
#[path = "browser_webview_screenshot.rs"]
mod browser_webview_screenshot;

use browser_webview_screenshot::{capture_platform_webview, validate_screenshot_crop};

const BROWSER_WEBVIEW_LABEL_PREFIX: &str = "browser-";
const BROWSER_DOWNLOAD_EVENT: &str = "pebble://browser-download";
const MAX_PROFILE_KEY_LENGTH: usize = 160;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChildWebviewCreateInput {
    pub label: String,
    pub url: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub profile_key: Option<String>,
    pub browser_tab_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChildWebviewCreateResult {
    pub label: String,
    pub isolated_profile: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserScreenshotFormat {
    Png,
    Jpeg,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChildWebviewScreenshotInput {
    pub label: String,
    pub format: BrowserScreenshotFormat,
    pub crop: Option<BrowserScreenshotCrop>,
    pub device_scale_factor: Option<f64>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshotCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChildWebviewScreenshotResult {
    pub data: String,
    pub format: BrowserScreenshotFormat,
}

#[derive(Clone, Debug)]
struct PendingNativeDownload {
    id: String,
    browser_tab_id: String,
    url: String,
    filename: String,
    path: PathBuf,
}

#[derive(Default)]
struct NativeDownloadState {
    by_url: HashMap<String, VecDeque<PendingNativeDownload>>,
    reserved_paths: HashSet<PathBuf>,
    #[cfg(target_os = "windows")]
    active_webviews: HashMap<String, String>,
}

#[derive(Clone, Default)]
pub struct NativeBrowserDownloadRegistry(Arc<Mutex<NativeDownloadState>>);

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum NativeBrowserDownloadEvent {
    Requested {
        native_download_id: String,
        browser_tab_id: String,
        url: String,
        filename: String,
        path: String,
    },
    Progress {
        native_download_id: String,
        browser_tab_id: String,
        received_bytes: u64,
        total_bytes: Option<u64>,
    },
    Finished {
        native_download_id: String,
        browser_tab_id: String,
        url: String,
        filename: String,
        path: String,
        success: bool,
    },
}

#[tauri::command]
pub fn browser_child_webview_create(
    app: AppHandle,
    download_registry: State<'_, NativeBrowserDownloadRegistry>,
    input: BrowserChildWebviewCreateInput,
) -> Result<BrowserChildWebviewCreateResult, String> {
    let label = validate_browser_webview_label(&input.label)?;
    let url = validate_browser_url(&input.url)?;
    let browser_tab_id = validate_browser_tab_id(&input.browser_tab_id)?;
    validate_bounds(&input)?;
    let profile_key = validate_profile_key(input.profile_key.as_deref())?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is not available".to_string())?;
    let mut builder = tauri::webview::WebviewBuilder::new(label.clone(), WebviewUrl::External(url))
        .devtools(true);
    if let Some(profile_key) = profile_key.as_deref() {
        let data_directory = browser_profile_data_directory(&app, profile_key)?;
        std::fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
        builder = builder
            .data_directory(data_directory)
            .data_store_identifier(stable_profile_identifier(profile_key));
    }
    let download_app = app.clone();
    let download_directory = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    let download_state = download_registry.0.clone();
    let tracking_state = download_state.clone();
    let tracking_app = app.clone();
    builder = builder.on_download(move |_webview, event| {
        handle_browser_download_event(
            &download_app,
            &download_directory,
            &browser_tab_id,
            &download_state,
            event,
        )
    });
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(input.x, input.y),
            LogicalSize::new(input.width, input.height),
        )
        .map_err(|error| error.to_string())?;
    browser_webview_download_windows::attach_download_tracking(
        &webview,
        label.clone(),
        tracking_app,
        tracking_state,
    )?;
    Ok(BrowserChildWebviewCreateResult {
        label,
        isolated_profile: profile_key.is_some(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChildWebviewCancelDownloadInput {
    pub native_download_id: String,
}

#[tauri::command]
pub async fn browser_child_webview_cancel_download(
    app: AppHandle,
    download_registry: State<'_, NativeBrowserDownloadRegistry>,
    input: BrowserChildWebviewCancelDownloadInput,
) -> Result<bool, String> {
    let native_download_id = input.native_download_id.trim();
    if native_download_id.is_empty() || native_download_id.len() > 256 {
        return Err("invalid native browser download id".to_string());
    }
    browser_webview_download_windows::cancel_download(
        &app,
        &download_registry.0,
        native_download_id,
    )
    .await
}

fn handle_browser_download_event(
    app: &AppHandle,
    download_directory: &Path,
    browser_tab_id: &str,
    state: &Arc<Mutex<NativeDownloadState>>,
    event: DownloadEvent<'_>,
) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let url_text = url.to_string();
            let mut downloads = match state.lock() {
                Ok(downloads) => downloads,
                Err(_) => return false,
            };
            let filename = browser_download_filename(destination, &url_text);
            let path = reserve_browser_download_path(download_directory, &filename, &downloads);
            *destination = path.clone();
            downloads.reserved_paths.insert(path.clone());
            let pending = PendingNativeDownload {
                id: format!("native-download-{}", uuid::Uuid::new_v4()),
                browser_tab_id: browser_tab_id.to_string(),
                url: url_text.clone(),
                filename: filename.clone(),
                path: path.clone(),
            };
            let payload = NativeBrowserDownloadEvent::Requested {
                native_download_id: pending.id.clone(),
                browser_tab_id: pending.browser_tab_id.clone(),
                url: pending.url.clone(),
                filename,
                path: path.to_string_lossy().into_owned(),
            };
            downloads
                .by_url
                .entry(url_text)
                .or_default()
                .push_back(pending.clone());
            drop(downloads);
            let _ = app.emit(BROWSER_DOWNLOAD_EVENT, payload);
            browser_download_file_progress::start_file_progress_tracking(
                app.clone(),
                Arc::clone(state),
                pending,
            );
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let url_text = url.to_string();
            let mut state = match state.lock() {
                Ok(state) => state,
                Err(_) => return true,
            };
            let pending = state
                .by_url
                .get_mut(&url_text)
                .and_then(VecDeque::pop_front);
            let Some(pending) = pending else {
                return true;
            };
            if state.by_url.get(&url_text).is_some_and(VecDeque::is_empty) {
                state.by_url.remove(&url_text);
            }
            state.reserved_paths.remove(&pending.path);
            #[cfg(target_os = "windows")]
            {
                state.active_webviews.remove(&pending.id);
                browser_webview_download_windows::forget_download(&pending.id);
            }
            let resolved_path = path.unwrap_or(pending.path);
            let payload = NativeBrowserDownloadEvent::Finished {
                native_download_id: pending.id,
                browser_tab_id: pending.browser_tab_id,
                url: pending.url,
                filename: pending.filename,
                path: resolved_path.to_string_lossy().into_owned(),
                success,
            };
            let _ = app.emit(BROWSER_DOWNLOAD_EVENT, payload);
            true
        }
        _ => true,
    }
}

fn browser_download_filename(destination: &Path, url: &str) -> String {
    let candidate = destination
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            url.split('?')
                .next()
                .and_then(|value| value.rsplit('/').next())
                .filter(|name| !name.trim().is_empty())
                .map(str::to_string)
        });
    sanitize_browser_download_filename(candidate.as_deref())
}

fn sanitize_browser_download_filename(value: Option<&str>) -> String {
    let value = value.unwrap_or("download").trim();
    if value.is_empty() || value == "." || value == ".." {
        return "download".to_string();
    }
    let cleaned: String = value
        .chars()
        .take(180)
        .map(|character| {
            if character.is_control() || matches!(character, '/' | '\\' | ':') {
                '_'
            } else {
                character
            }
        })
        .collect();
    if cleaned.trim_matches(['.', ' ']).is_empty() {
        "download".to_string()
    } else {
        cleaned
    }
}

fn reserve_browser_download_path(
    directory: &Path,
    filename: &str,
    state: &NativeDownloadState,
) -> PathBuf {
    let original = Path::new(filename);
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("download");
    let extension = original.extension().and_then(|value| value.to_str());
    for suffix in 0..10_000_u32 {
        let candidate_name = if suffix == 0 {
            filename.to_string()
        } else if let Some(extension) = extension {
            format!("{stem} ({suffix}).{extension}")
        } else {
            format!("{stem} ({suffix})")
        };
        let candidate = directory.join(candidate_name);
        if !candidate.exists() && !state.reserved_paths.contains(&candidate) {
            return candidate;
        }
    }
    directory.join(format!("download-{}", uuid::Uuid::new_v4()))
}

#[tauri::command]
pub async fn browser_child_webview_screenshot(
    app: AppHandle,
    input: BrowserChildWebviewScreenshotInput,
) -> Result<BrowserChildWebviewScreenshotResult, String> {
    let label = validate_browser_webview_label(&input.label)?;
    let crop = validate_screenshot_crop(input.crop)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    let format = input.format;
    let device_scale_factor = validate_device_scale_factor(input.device_scale_factor)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let _ = sender.send(capture_platform_webview(
                platform_webview,
                format,
                crop,
                device_scale_factor,
            ));
        })
        .map_err(|error| error.to_string())?;
    let bytes = receiver
        .await
        .map_err(|_| "browser screenshot callback was dropped".to_string())??;
    if bytes.is_empty() {
        return Err("browser screenshot returned empty image data".to_string());
    }
    Ok(BrowserChildWebviewScreenshotResult {
        data: BASE64_STANDARD.encode(bytes),
        format,
    })
}

fn validate_device_scale_factor(value: Option<f64>) -> Result<f64, String> {
    let value = value.unwrap_or(1.0);
    if !value.is_finite() || !(0.25..=8.0).contains(&value) {
        return Err("invalid browser screenshot device scale factor".to_string());
    }
    Ok(value)
}

fn validate_browser_webview_label(value: &str) -> Result<String, String> {
    let label = value.trim();
    if !label.starts_with(BROWSER_WEBVIEW_LABEL_PREFIX) || label.len() > 256 {
        return Err("invalid browser webview label".to_string());
    }
    if !label.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '/' | ':')
    }) {
        return Err("invalid browser webview label".to_string());
    }
    Ok(label.to_string())
}

fn validate_browser_url(value: &str) -> Result<tauri::Url, String> {
    let url = value
        .trim()
        .parse::<tauri::Url>()
        .map_err(|_| "invalid browser URL".to_string())?;
    let allowed = matches!(url.scheme(), "http" | "https" | "file")
        || (url.scheme() == "about" && url.as_str() == "about:blank");
    if !allowed {
        return Err("unsupported browser URL scheme".to_string());
    }
    Ok(url)
}

fn validate_bounds(input: &BrowserChildWebviewCreateInput) -> Result<(), String> {
    if !input.x.is_finite()
        || !input.y.is_finite()
        || !input.width.is_finite()
        || !input.height.is_finite()
        || input.width < 1.0
        || input.height < 1.0
    {
        return Err("invalid browser webview bounds".to_string());
    }
    Ok(())
}

fn validate_profile_key(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let key = value.trim();
    if key.is_empty() || key.len() > MAX_PROFILE_KEY_LENGTH {
        return Err("invalid browser profile key".to_string());
    }
    if !key
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("invalid browser profile key".to_string());
    }
    Ok(Some(key.to_string()))
}

fn validate_browser_tab_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err("invalid browser tab id".to_string());
    }
    Ok(value.to_string())
}

fn browser_profile_data_directory(app: &AppHandle, profile_key: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("browser-profiles").join(profile_key))
        .map_err(|error| error.to_string())
}

fn stable_profile_identifier(value: &str) -> [u8; 16] {
    let mut first = 0xcbf29ce484222325_u64;
    let mut second = 0x84222325cbf29ce4_u64;
    for byte in value.bytes() {
        first ^= u64::from(byte);
        first = first.wrapping_mul(0x100000001b3);
        second ^= u64::from(byte).wrapping_add(0x9d);
        second = second.wrapping_mul(0x100000001b3);
    }
    let mut identifier = [0_u8; 16];
    identifier[..8].copy_from_slice(&first.to_be_bytes());
    identifier[8..].copy_from_slice(&second.to_be_bytes());
    identifier
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_supported_browser_urls_only() {
        assert!(validate_browser_url("https://www.nebutra.com/pebble").is_ok());
        assert!(validate_browser_url("about:blank").is_ok());
        assert!(validate_browser_url("javascript:alert(1)").is_err());
        assert!(validate_browser_url("data:text/html,unsafe").is_err());
    }

    #[test]
    fn validates_profile_keys_for_native_storage_paths() {
        assert_eq!(
            validate_profile_key(Some("pebble-browser-session-123"))
                .expect("valid profile key")
                .as_deref(),
            Some("pebble-browser-session-123")
        );
        assert!(validate_profile_key(Some("../outside")).is_err());
    }

    #[test]
    fn profile_identifiers_are_stable_and_distinct() {
        assert_eq!(
            stable_profile_identifier("profile-a"),
            stable_profile_identifier("profile-a")
        );
        assert_ne!(
            stable_profile_identifier("profile-a"),
            stable_profile_identifier("profile-b")
        );
    }

    #[test]
    fn validates_optional_screenshot_crop_geometry() {
        assert!(validate_screenshot_crop(None).is_ok());
        assert!(validate_screenshot_crop(Some(BrowserScreenshotCrop {
            x: 10.0,
            y: 20.0,
            width: 300.0,
            height: 200.0,
        }))
        .is_ok());
        assert!(validate_screenshot_crop(Some(BrowserScreenshotCrop {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 20.0,
        }))
        .is_err());
        assert!(validate_screenshot_crop(Some(BrowserScreenshotCrop {
            x: -1.0,
            y: 0.0,
            width: 20.0,
            height: 20.0,
        }))
        .is_err());
        assert_eq!(validate_device_scale_factor(Some(2.0)), Ok(2.0));
        assert!(validate_device_scale_factor(Some(0.0)).is_err());
        assert!(validate_device_scale_factor(Some(9.0)).is_err());
    }

    #[test]
    fn reserves_collision_safe_browser_download_paths() {
        let directory = Path::new("/tmp/downloads");
        let mut state = NativeDownloadState::default();
        state.reserved_paths.insert(directory.join("archive.zip"));
        assert_eq!(
            reserve_browser_download_path(directory, "archive.zip", &state),
            directory.join("archive (1).zip")
        );
        assert_eq!(
            browser_download_filename(Path::new(""), "https://example.com/report.pdf?token=x"),
            "report.pdf"
        );
        assert_eq!(
            browser_download_filename(Path::new(""), "https://example.com/.."),
            "download"
        );
        assert_eq!(
            sanitize_browser_download_filename(Some("a/b:c.txt")),
            "a_b_c.txt"
        );
    }

    #[test]
    fn file_progress_tracking_stops_after_download_is_removed() {
        let pending = PendingNativeDownload {
            id: "native-download-1".to_string(),
            browser_tab_id: "tab-1".to_string(),
            url: "https://example.com/archive.zip".to_string(),
            filename: "archive.zip".to_string(),
            path: PathBuf::from("/tmp/archive.zip"),
        };
        let state = Arc::new(Mutex::new(NativeDownloadState::default()));
        state
            .lock()
            .expect("download state")
            .by_url
            .entry(pending.url.clone())
            .or_default()
            .push_back(pending.clone());
        assert!(browser_download_file_progress::is_download_active(
            &state,
            &pending.id
        ));
        state.lock().expect("download state").by_url.clear();
        assert!(!browser_download_file_progress::is_download_active(
            &state,
            &pending.id
        ));
    }
}
