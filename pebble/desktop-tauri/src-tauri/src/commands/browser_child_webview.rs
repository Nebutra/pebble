use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

const BROWSER_WEBVIEW_LABEL_PREFIX: &str = "browser-";
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChildWebviewCreateResult {
    pub label: String,
    pub isolated_profile: bool,
}

#[tauri::command]
pub fn browser_child_webview_create(
    app: AppHandle,
    input: BrowserChildWebviewCreateInput,
) -> Result<BrowserChildWebviewCreateResult, String> {
    let label = validate_browser_webview_label(&input.label)?;
    let url = validate_browser_url(&input.url)?;
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
    window
        .add_child(
            builder,
            LogicalPosition::new(input.x, input.y),
            LogicalSize::new(input.width, input.height),
        )
        .map_err(|error| error.to_string())?;
    Ok(BrowserChildWebviewCreateResult {
        label,
        isolated_profile: profile_key.is_some(),
    })
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
}
