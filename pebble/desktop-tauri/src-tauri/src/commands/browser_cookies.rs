use std::{collections::BTreeSet, fs};

use cookie::SameSite;
use serde::{Deserialize, Serialize};
use tauri::{webview::Cookie, AppHandle, Manager};
use time::OffsetDateTime;

const BROWSER_WEBVIEW_LABEL_PREFIX: &str = "browser-";
const MAX_COOKIE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_COOKIE_ENTRIES: usize = 50_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserClearCookiesInput {
    pub label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserImportCookieFileInput {
    pub label: String,
    pub profile_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCookieEntry {
    domain: String,
    name: String,
    value: String,
    path: Option<String>,
    secure: Option<BoolLike>,
    http_only: Option<BoolLike>,
    same_site: Option<serde_json::Value>,
    expiration_date: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum BoolLike {
    Bool(bool),
    Number(i64),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCookieImportSummary {
    total_cookies: usize,
    imported_cookies: usize,
    skipped_cookies: usize,
    domains: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCookieImportResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<BrowserCookieImportSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[tauri::command]
pub async fn browser_guest_clear_cookies(
    app: AppHandle,
    input: BrowserClearCookiesInput,
) -> Result<u32, String> {
    let label = validate_browser_webview_label(&input.label)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    // Why: Tauri documents cookie enumeration as an async-command operation on
    // Windows. Keep this command async even though the runtime API is synchronous.
    let cookies = webview.cookies().map_err(|error| error.to_string())?;
    let mut deleted = 0_u32;
    for cookie in cookies {
        webview
            .delete_cookie(cookie)
            .map_err(|error| error.to_string())?;
        deleted = deleted.saturating_add(1);
    }
    Ok(deleted)
}

#[tauri::command]
pub async fn browser_guest_import_cookie_file(
    app: AppHandle,
    input: BrowserImportCookieFileInput,
) -> Result<BrowserCookieImportResult, String> {
    let label = validate_browser_webview_label(&input.label)?;
    if input.profile_id.trim().is_empty() || input.profile_id.len() > 200 {
        return Err("invalid browser profile id".to_string());
    }
    let Some(path) = rfd::FileDialog::new()
        .set_title("Import Cookies")
        .add_filter("Cookie Files", &["json"])
        .pick_file()
    else {
        return Ok(import_error("canceled"));
    };
    let metadata =
        fs::metadata(&path).map_err(|_| "Could not read the selected file.".to_string())?;
    if metadata.len() > MAX_COOKIE_FILE_BYTES {
        return Ok(import_error("Cookie file exceeds the 16 MB limit."));
    }
    let bytes = fs::read(&path).map_err(|_| "Could not read the selected file.".to_string())?;
    let entries = parse_cookie_entries(&bytes)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    let total = entries.len();
    let mut imported = 0_usize;
    let mut skipped = 0_usize;
    let mut domains = BTreeSet::new();

    for entry in entries {
        let Some((cookie, domain)) = build_import_cookie(entry) else {
            skipped += 1;
            continue;
        };
        match webview.set_cookie(cookie) {
            Ok(()) => {
                imported += 1;
                domains.insert(domain);
            }
            Err(_) => skipped += 1,
        }
    }
    if imported == 0 {
        return Ok(import_error(&format!(
            "No cookies could be imported. {skipped} entries were skipped."
        )));
    }
    Ok(BrowserCookieImportResult {
        ok: true,
        profile_id: Some(input.profile_id),
        summary: Some(BrowserCookieImportSummary {
            total_cookies: total,
            imported_cookies: imported,
            skipped_cookies: skipped,
            domains: domains.into_iter().collect(),
        }),
        reason: None,
    })
}

fn parse_cookie_entries(bytes: &[u8]) -> Result<Vec<RawCookieEntry>, String> {
    let entries = serde_json::from_slice::<Vec<RawCookieEntry>>(bytes)
        .map_err(|_| "Expected a JSON array of cookie objects.".to_string())?;
    if entries.is_empty() {
        return Err("Cookie file is empty.".to_string());
    }
    if entries.len() > MAX_COOKIE_ENTRIES {
        return Err("Cookie file contains too many entries.".to_string());
    }
    Ok(entries)
}

fn build_import_cookie(entry: RawCookieEntry) -> Option<(Cookie<'static>, String)> {
    let domain = entry.domain.trim();
    let name = entry.name.trim();
    if !is_valid_cookie_domain(domain) || !is_valid_cookie_name(name) {
        return None;
    }
    let value = strip_non_printable_ascii(&entry.value);
    let path = entry.path.as_deref().unwrap_or("/").trim();
    if path.is_empty() || !path.starts_with('/') || path.len() > 2048 {
        return None;
    }
    let secure = bool_like(entry.secure.as_ref());
    let mut builder = Cookie::build((name.to_string(), value))
        .domain(domain.to_string())
        .path(path.to_string())
        .secure(secure)
        .http_only(bool_like(entry.http_only.as_ref()));
    if let Some(same_site) = normalize_same_site(entry.same_site.as_ref()) {
        builder = builder.same_site(same_site);
    }
    if let Some(expiration) = entry
        .expiration_date
        .filter(|value| value.is_finite() && *value > 0.0)
        .and_then(|value| OffsetDateTime::from_unix_timestamp(value as i64).ok())
    {
        builder = builder.expires(expiration);
    }
    Some((
        builder.build().into_owned(),
        domain.trim_start_matches('.').to_string(),
    ))
}

fn is_valid_cookie_domain(domain: &str) -> bool {
    !domain.is_empty()
        && domain.len() <= 253
        && domain.is_ascii()
        && domain.trim_start_matches('.').split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

fn is_valid_cookie_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && name.bytes().all(|byte| {
            (0x21..=0x7e).contains(&byte)
                && !matches!(
                    byte,
                    b'(' | b')'
                        | b'<'
                        | b'>'
                        | b'@'
                        | b','
                        | b';'
                        | b':'
                        | b'\\'
                        | b'"'
                        | b'/'
                        | b'['
                        | b']'
                        | b'?'
                        | b'='
                        | b'{'
                        | b'}'
                )
        })
}

fn strip_non_printable_ascii(value: &str) -> String {
    value.chars().filter(|c| (' '..='~').contains(c)).collect()
}

fn bool_like(value: Option<&BoolLike>) -> bool {
    matches!(
        value,
        Some(BoolLike::Bool(true)) | Some(BoolLike::Number(1))
    )
}

fn normalize_same_site(value: Option<&serde_json::Value>) -> Option<SameSite> {
    match value {
        Some(serde_json::Value::String(value)) => match value.to_ascii_lowercase().as_str() {
            "strict" => Some(SameSite::Strict),
            "lax" => Some(SameSite::Lax),
            "none" | "no_restriction" => Some(SameSite::None),
            _ => None,
        },
        Some(serde_json::Value::Number(value)) if value.as_i64() == Some(0) => Some(SameSite::None),
        Some(serde_json::Value::Number(value)) if value.as_i64() == Some(1) => Some(SameSite::Lax),
        Some(serde_json::Value::Number(value)) if value.as_i64() == Some(2) => {
            Some(SameSite::Strict)
        }
        _ => None,
    }
}

fn import_error(reason: &str) -> BrowserCookieImportResult {
    BrowserCookieImportResult {
        ok: false,
        profile_id: None,
        summary: None,
        reason: Some(reason.to_string()),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_cookie_clearing_to_browser_child_labels() {
        assert_eq!(
            validate_browser_webview_label("browser-default-1").as_deref(),
            Ok("browser-default-1")
        );
        assert!(validate_browser_webview_label("main").is_err());
        assert!(validate_browser_webview_label("browser-<script>").is_err());
    }

    #[test]
    fn validates_and_sanitizes_imported_cookie_fields() {
        let entry = RawCookieEntry {
            domain: ".example.com".to_string(),
            name: "session".to_string(),
            value: "secret\nvalue".to_string(),
            path: Some("/account".to_string()),
            secure: Some(BoolLike::Bool(true)),
            http_only: Some(BoolLike::Number(1)),
            same_site: Some(serde_json::Value::String("lax".to_string())),
            expiration_date: Some(2_000_000_000.0),
        };
        let (cookie, domain) = build_import_cookie(entry).expect("valid cookie");
        assert_eq!(cookie.value(), "secretvalue");
        assert_eq!(cookie.domain(), Some("example.com"));
        assert_eq!(cookie.path(), Some("/account"));
        assert_eq!(cookie.secure(), Some(true));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.same_site(), Some(SameSite::Lax));
        assert_eq!(domain, "example.com");
    }

    #[test]
    fn rejects_path_traversal_and_invalid_cookie_names() {
        assert!(!is_valid_cookie_name("bad=name"));
        assert!(!is_valid_cookie_domain("example..com"));
    }
}
