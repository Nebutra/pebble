use std::collections::BTreeSet;
use std::env;
use std::fs;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::process::{Command, Stdio};

use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use aes::Aes128;
#[cfg(any(target_os = "windows", test))]
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
#[cfg(target_os = "windows")]
use base64::Engine;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use pbkdf2::pbkdf2_hmac;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use sha1::Sha1;

use super::{
    build_import_cookie, import_error, BoolLike, BrowserCookieImportResult,
    BrowserCookieImportSummary, RawCookieEntry, MAX_COOKIE_ENTRIES,
};

const MAX_FIREFOX_COOKIE_DB_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SAFARI_COOKIE_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAC_EPOCH_DELTA_SECONDS: f64 = 978_307_200.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserImportFromBrowserInput {
    label: String,
    profile_id: String,
    browser_family: String,
    browser_profile: Option<String>,
}

#[tauri::command]
pub async fn browser_guest_import_from_browser(
    app: AppHandle,
    input: BrowserImportFromBrowserInput,
) -> Result<BrowserCookieImportResult, String> {
    let label = super::validate_browser_webview_label(&input.label)?;
    if input.profile_id.trim().is_empty() || input.profile_id.len() > 200 {
        return Err("invalid browser profile id".to_string());
    }
    if input.browser_family == "safari" {
        return import_safari_cookies(app, label, input.profile_id).await;
    }
    if is_chromium_family(&input.browser_family) {
        return import_chromium_cookies(
            app,
            label,
            input.profile_id,
            input.browser_family,
            input
                .browser_profile
                .unwrap_or_else(|| "Default".to_string()),
        )
        .await;
    }
    if input.browser_family != "firefox" {
        return Ok(import_error("Unsupported browser cookie import family."));
    }
    let profile = input.browser_profile.as_deref().unwrap_or_default();
    if !is_safe_profile_directory(profile) {
        return Err("invalid Firefox profile directory".to_string());
    }
    let source = firefox_profiles_root().join(profile).join("cookies.sqlite");
    let source_metadata = fs::metadata(&source)
        .map_err(|_| "Could not read the selected Firefox profile.".to_string())?;
    if source_metadata.len() > MAX_FIREFOX_COOKIE_DB_BYTES {
        return Ok(import_error("Firefox cookie database exceeds 256 MB."));
    }
    // Firefox snapshots and SQLite reads can be large; keep them off Tauri's async command thread.
    let entries = tauri::async_runtime::spawn_blocking(move || {
        let snapshot = FirefoxCookieSnapshot::create(&source)?;
        read_firefox_cookies(snapshot.database_path())
    })
    .await
    .map_err(|_| "Firefox cookie import worker failed.".to_string())??;
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
            "No Firefox cookies could be imported. {skipped} entries were skipped."
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

async fn import_chromium_cookies(
    app: AppHandle,
    label: String,
    profile_id: String,
    family: String,
    profile: String,
) -> Result<BrowserCookieImportResult, String> {
    if !is_safe_profile_directory(&profile) {
        return Err("invalid Chromium profile directory".to_string());
    }
    let definition = chromium_browser_definition(&family)
        .ok_or_else(|| "unsupported Chromium browser family".to_string())?;
    let source = resolve_chromium_cookie_path(definition.root, &profile)
        .ok_or_else(|| "Could not find the selected Chromium cookie store.".to_string())?;
    let entries = tauri::async_runtime::spawn_blocking(move || {
        let snapshot = ChromiumCookieSnapshot::create(&source)?;
        read_chromium_cookies(snapshot.database_path(), &definition)
    })
    .await
    .map_err(|_| "Chromium cookie import worker failed.".to_string())??;
    import_cookie_entries(&app, &label, profile_id, definition.label, entries)
}

#[derive(Clone, Copy)]
struct ChromiumBrowserDefinition {
    label: &'static str,
    root: &'static str,
    service: &'static str,
    account: &'static str,
}

fn chromium_browser_definition(family: &str) -> Option<ChromiumBrowserDefinition> {
    #[cfg(target_os = "macos")]
    let values = match family {
        "chrome" => (
            "Google Chrome",
            "Google/Chrome",
            "Chrome Safe Storage",
            "Chrome",
        ),
        "edge" => (
            "Microsoft Edge",
            "Microsoft Edge",
            "Microsoft Edge Safe Storage",
            "Microsoft Edge",
        ),
        "arc" => ("Arc", "Arc/User Data", "Arc Safe Storage", "Arc"),
        "chromium" => (
            "Brave",
            "BraveSoftware/Brave-Browser",
            "Brave Safe Storage",
            "Brave",
        ),
        "comet" => ("Comet", "Comet", "Comet Safe Storage", "Comet"),
        "helium" => ("Helium", "net.imput.helium", "Helium Storage Key", "Helium"),
        _ => return None,
    };
    #[cfg(target_os = "linux")]
    let values = match family {
        "chrome" => (
            "Google Chrome",
            "google-chrome",
            "Chrome Safe Storage",
            "Chrome",
        ),
        "edge" => (
            "Microsoft Edge",
            "microsoft-edge",
            "Microsoft Edge Safe Storage",
            "Microsoft Edge",
        ),
        "chromium" => (
            "Brave",
            "BraveSoftware/Brave-Browser",
            "Brave Safe Storage",
            "Brave",
        ),
        _ => return None,
    };
    #[cfg(target_os = "windows")]
    let values = match family {
        "chrome" => (
            "Google Chrome",
            "Google/Chrome/User Data",
            "Chrome Safe Storage",
            "Chrome",
        ),
        "edge" => (
            "Microsoft Edge",
            "Microsoft/Edge/User Data",
            "Microsoft Edge Safe Storage",
            "Microsoft Edge",
        ),
        "chromium" => (
            "Brave",
            "BraveSoftware/Brave-Browser/User Data",
            "Brave Safe Storage",
            "Brave",
        ),
        "comet" => ("Comet", "Comet/User Data", "Comet Safe Storage", "Comet"),
        _ => return None,
    };
    Some(ChromiumBrowserDefinition {
        label: values.0,
        root: values.1,
        service: values.2,
        account: values.3,
    })
}

fn is_chromium_family(family: &str) -> bool {
    matches!(
        family,
        "chrome" | "edge" | "arc" | "chromium" | "comet" | "helium"
    )
}

fn resolve_chromium_cookie_path(root: &str, profile: &str) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let profile_root = home_dir()
        .join("Library/Application Support")
        .join(root)
        .join(profile);
    #[cfg(target_os = "linux")]
    let profile_root = home_dir().join(".config").join(root).join(profile);
    #[cfg(target_os = "windows")]
    let profile_root = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(root)
        .join(profile);
    [
        profile_root.join("Network/Cookies"),
        profile_root.join("Cookies"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn read_chromium_cookies(
    path: &Path,
    definition: &ChromiumBrowserDefinition,
) -> Result<Vec<RawCookieEntry>, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "Could not open the Chromium cookie database.".to_string())?;
    let mut statement = connection.prepare(
        "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies LIMIT ?1",
    ).map_err(|_| "Chromium cookie schema is not supported.".to_string())?;
    let keys = chromium_decryption_keys(definition)?;
    let rows = statement
        .query_map([MAX_COOKIE_ENTRIES as i64 + 1], |row| {
            let plaintext: String = row.get(2)?;
            let encrypted: Vec<u8> = row.get(3)?;
            let value = if !plaintext.is_empty() {
                Some(plaintext)
            } else {
                decrypt_chromium_cookie(&encrypted, &keys)
            };
            Ok(value.map(|value| RawCookieEntry {
                domain: row.get(0).unwrap_or_default(),
                name: row.get(1).unwrap_or_default(),
                value,
                path: row.get(4).ok(),
                expiration_date: chromium_expiration_to_unix(
                    row.get::<_, i64>(5).unwrap_or_default(),
                ),
                secure: Some(BoolLike::Number(row.get(6).unwrap_or_default())),
                http_only: Some(BoolLike::Number(row.get(7).unwrap_or_default())),
                same_site: Some(serde_json::Value::Number(
                    row.get::<_, i64>(8).unwrap_or_default().into(),
                )),
            }))
        })
        .map_err(|_| "Could not read Chromium cookies.".to_string())?;
    let mut entries = Vec::new();
    for row in rows {
        if let Some(entry) =
            row.map_err(|_| "Chromium cookie database contains unsupported entries.".to_string())?
        {
            entries.push(entry);
        }
    }
    if entries.len() > MAX_COOKIE_ENTRIES {
        return Err("Chromium profile contains too many cookies.".to_string());
    }
    Ok(entries)
}

enum ChromiumDecryptionKeys {
    Cbc {
        primary: [u8; 16],
        fallback: Option<[u8; 16]>,
    },
    #[cfg(any(target_os = "windows", test))]
    Gcm([u8; 32]),
}

#[cfg(target_os = "macos")]
fn chromium_decryption_keys(
    definition: &ChromiumBrowserDefinition,
) -> Result<ChromiumDecryptionKeys, String> {
    let password = keyring::Entry::new(definition.service, definition.account)
        .map_err(|_| "Could not access the browser encryption key.".to_string())?
        .get_password()
        .map_err(|_| "Could not access the browser encryption key.".to_string())?;
    Ok(ChromiumDecryptionKeys::Cbc {
        primary: derive_chromium_cbc_key(&password, 1003),
        fallback: None,
    })
}

#[cfg(target_os = "linux")]
fn chromium_decryption_keys(
    definition: &ChromiumBrowserDefinition,
) -> Result<ChromiumDecryptionKeys, String> {
    let password = lookup_linux_safe_storage(definition).unwrap_or_default();
    Ok(ChromiumDecryptionKeys::Cbc {
        primary: derive_chromium_cbc_key(&password, 1),
        fallback: Some(derive_chromium_cbc_key("peanuts", 1)),
    })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn derive_chromium_cbc_key(password: &str, iterations: u32) -> [u8; 16] {
    let mut key = [0_u8; 16];
    pbkdf2_hmac::<Sha1>(password.as_bytes(), b"saltysalt", iterations, &mut key);
    key
}

#[cfg(target_os = "linux")]
fn lookup_linux_safe_storage(definition: &ChromiumBrowserDefinition) -> Option<String> {
    let output = Command::new("secret-tool")
        .args([
            "lookup",
            "service",
            definition.service,
            "account",
            definition.account,
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if output.status.success() {
        let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    let application = definition.account.to_ascii_lowercase().replace(' ', "");
    let output = Command::new("secret-tool")
        .args(["lookup", "application", &application])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(target_os = "windows")]
fn chromium_decryption_keys(
    definition: &ChromiumBrowserDefinition,
) -> Result<ChromiumDecryptionKeys, String> {
    let root = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(definition.root);
    let state = fs::read_to_string(root.join("Local State"))
        .map_err(|_| "Could not read Chromium Local State.".to_string())?;
    let encoded = serde_json::from_str::<serde_json::Value>(&state)
        .ok()
        .and_then(|value| {
            value
                .pointer("/os_crypt/encrypted_key")?
                .as_str()
                .map(str::to_string)
        })
        .ok_or_else(|| "Chromium Local State has no encrypted key.".to_string())?;
    let encrypted = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Chromium Local State key is malformed.".to_string())?;
    if !encrypted.starts_with(b"DPAPI") {
        return Err("Chromium Local State key has an unsupported protector.".to_string());
    }
    let protected = base64::engine::general_purpose::STANDARD.encode(&encrypted[5..]);
    let script = concat!(
        "try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop } catch { Add-Type -AssemblyName System.Security };",
        "$d=[Convert]::FromBase64String([Console]::In.ReadLine());",
        "$o=[System.Security.Cryptography.ProtectedData]::Unprotect($d,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);",
        "[Convert]::ToBase64String($o)"
    );
    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not start Windows DPAPI key provider.".to_string())?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "DPAPI stdin unavailable.".to_string())?
        .write_all(format!("{protected}\n").as_bytes())
        .map_err(|_| "Could not send key to DPAPI.".to_string())?;
    let output = child
        .wait_with_output()
        .map_err(|_| "Windows DPAPI key provider failed.".to_string())?;
    if !output.status.success() {
        return Err("Windows denied access to the browser encryption key.".to_string());
    }
    let key = base64::engine::general_purpose::STANDARD
        .decode(String::from_utf8_lossy(&output.stdout).trim())
        .map_err(|_| "Windows DPAPI returned a malformed key.".to_string())?;
    let key: [u8; 32] = key
        .try_into()
        .map_err(|_| "Windows DPAPI returned an unexpected key size.".to_string())?;
    Ok(ChromiumDecryptionKeys::Gcm(key))
}

#[cfg(any(target_os = "windows", test))]
fn decrypt_chromium_gcm(payload: &[u8], key: &[u8; 32]) -> Option<Vec<u8>> {
    if payload.len() < 12 + 16 {
        return None;
    }
    Aes256Gcm::new(key.into())
        .decrypt(Nonce::from_slice(&payload[..12]), &payload[12..])
        .ok()
}

fn decrypt_chromium_cookie(encrypted: &[u8], keys: &ChromiumDecryptionKeys) -> Option<String> {
    if encrypted.len() <= 3
        || encrypted[0] != b'v'
        || !encrypted[1].is_ascii_digit()
        || !encrypted[2].is_ascii_digit()
    {
        return None;
    }
    let decrypted = match keys {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        ChromiumDecryptionKeys::Cbc { primary, fallback } => {
            let ordered = if &encrypted[..3] == b"v10" {
                [fallback.as_ref(), Some(primary)]
            } else {
                [Some(primary), fallback.as_ref()]
            };
            ordered.into_iter().flatten().find_map(|key| {
                cbc::Decryptor::<Aes128>::new(key.into(), (&[b' '; 16]).into())
                    .decrypt_padded_vec_mut::<Pkcs7>(&encrypted[3..])
                    .ok()
            })?
        }
        #[cfg(any(target_os = "windows", test))]
        ChromiumDecryptionKeys::Gcm(key) => decrypt_chromium_gcm(&encrypted[3..], key)?,
        #[cfg(target_os = "windows")]
        ChromiumDecryptionKeys::Cbc { .. } => return None,
    };
    let value = if has_chromium_host_hash(&decrypted) {
        &decrypted[32..]
    } else {
        &decrypted
    };
    String::from_utf8(value.to_vec()).ok()
}

fn has_chromium_host_hash(value: &[u8]) -> bool {
    value.len() > 32
        && value[..32]
            .iter()
            .filter(|byte| **byte < 0x20 || **byte > 0x7e)
            .count()
            >= 8
}

fn chromium_expiration_to_unix(value: i64) -> Option<f64> {
    if value <= 0 {
        return None;
    }
    Some(((value / 1_000_000) - 11_644_473_600).max(0) as f64)
}

struct ChromiumCookieSnapshot(FirefoxCookieSnapshot);

impl ChromiumCookieSnapshot {
    fn create(source: &Path) -> Result<Self, String> {
        FirefoxCookieSnapshot::create(source).map(Self)
    }
    fn database_path(&self) -> &Path {
        self.0.database_path()
    }
}

async fn import_safari_cookies(
    app: AppHandle,
    label: String,
    profile_id: String,
) -> Result<BrowserCookieImportResult, String> {
    if !cfg!(target_os = "macos") {
        return Ok(import_error(
            "Safari cookie import is only available on macOS.",
        ));
    }
    let source = safari_cookie_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "Could not find the Safari cookie store.".to_string())?;
    let metadata = fs::metadata(&source).map_err(|_| safari_cookie_read_error())?;
    if metadata.len() > MAX_SAFARI_COOKIE_FILE_BYTES {
        return Ok(import_error("Safari cookie store exceeds 256 MB."));
    }
    let entries = tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(source).map_err(|_| safari_cookie_read_error())?;
        decode_safari_binary_cookies(&bytes)
    })
    .await
    .map_err(|_| "Safari cookie import worker failed.".to_string())??;
    import_cookie_entries(&app, &label, profile_id, "Safari", entries)
}

fn import_cookie_entries(
    app: &AppHandle,
    label: &str,
    profile_id: String,
    browser_name: &str,
    entries: Vec<RawCookieEntry>,
) -> Result<BrowserCookieImportResult, String> {
    let webview = app
        .get_webview(label)
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
            "No {browser_name} cookies could be imported. {skipped} entries were skipped."
        )));
    }
    Ok(BrowserCookieImportResult {
        ok: true,
        profile_id: Some(profile_id),
        summary: Some(BrowserCookieImportSummary {
            total_cookies: total,
            imported_cookies: imported,
            skipped_cookies: skipped,
            domains: domains.into_iter().collect(),
        }),
        reason: None,
    })
}

fn decode_safari_binary_cookies(bytes: &[u8]) -> Result<Vec<RawCookieEntry>, String> {
    if bytes.len() < 8 || &bytes[..4] != b"cook" {
        return Err("Safari cookie store has an invalid header.".to_string());
    }
    let page_count =
        read_u32_be(bytes, 4).ok_or_else(|| "Invalid Safari page table.".to_string())? as usize;
    let table_end = 8_usize
        .checked_add(
            page_count
                .checked_mul(4)
                .ok_or_else(|| "Invalid Safari page count.".to_string())?,
        )
        .ok_or_else(|| "Invalid Safari page count.".to_string())?;
    if table_end > bytes.len() {
        return Err("Invalid Safari page table.".to_string());
    }
    let mut cursor = table_end;
    let mut entries = Vec::new();
    for index in 0..page_count {
        let size = read_u32_be(bytes, 8 + index * 4).unwrap_or(0) as usize;
        let end = cursor
            .checked_add(size)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "Invalid Safari cookie page size.".to_string())?;
        decode_safari_page(&bytes[cursor..end], &mut entries)?;
        cursor = end;
        if entries.len() > MAX_COOKIE_ENTRIES {
            return Err("Safari profile contains too many cookies.".to_string());
        }
    }
    Ok(entries)
}

fn decode_safari_page(page: &[u8], entries: &mut Vec<RawCookieEntry>) -> Result<(), String> {
    if page.len() < 16 || read_u32_be(page, 0) != Some(0x100) {
        return Ok(());
    }
    let count = read_u32_le(page, 4).unwrap_or(0) as usize;
    let offsets_end = 8_usize
        .checked_add(
            count
                .checked_mul(4)
                .ok_or_else(|| "Invalid Safari cookie count.".to_string())?,
        )
        .ok_or_else(|| "Invalid Safari cookie count.".to_string())?;
    if offsets_end > page.len() {
        return Err("Invalid Safari cookie offsets.".to_string());
    }
    for index in 0..count {
        if let Some(offset) = read_u32_le(page, 8 + index * 4).map(|value| value as usize) {
            if let Some(entry) = decode_safari_cookie(page.get(offset..).unwrap_or_default()) {
                entries.push(entry);
            }
        }
    }
    Ok(())
}

fn decode_safari_cookie(bytes: &[u8]) -> Option<RawCookieEntry> {
    let size = (read_u32_le(bytes, 0)? as usize).min(bytes.len());
    if size < 48 {
        return None;
    }
    let flags = read_u32_le(bytes, 8)?;
    let domain = read_c_string(bytes, read_u32_le(bytes, 16)? as usize, size)?;
    let name = read_c_string(bytes, read_u32_le(bytes, 20)? as usize, size)?;
    let path = read_c_string(bytes, read_u32_le(bytes, 24)? as usize, size)
        .unwrap_or_else(|| "/".to_string());
    let value = read_c_string(bytes, read_u32_le(bytes, 28)? as usize, size).unwrap_or_default();
    let expiration =
        f64::from_le_bytes(bytes.get(40..48)?.try_into().ok()?) + MAC_EPOCH_DELTA_SECONDS;
    if name.is_empty()
        || domain.is_empty()
        || expiration.is_finite()
            && expiration > 0.0
            && expiration <= chrono::Utc::now().timestamp() as f64
    {
        return None;
    }
    Some(RawCookieEntry {
        domain,
        name,
        value,
        path: Some(path),
        expiration_date: (expiration > MAC_EPOCH_DELTA_SECONDS).then_some(expiration),
        secure: Some(BoolLike::Bool(flags & 1 != 0)),
        http_only: Some(BoolLike::Bool(flags & 4 != 0)),
        same_site: Some(serde_json::Value::String("unspecified".to_string())),
    })
}

fn read_c_string(bytes: &[u8], offset: usize, end: usize) -> Option<String> {
    if offset >= end || end > bytes.len() {
        return None;
    }
    let tail = &bytes[offset..end];
    let length = tail.iter().position(|byte| *byte == 0)?;
    String::from_utf8(tail[..length].to_vec()).ok()
}

fn read_u32_be(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn safari_cookie_candidates() -> [PathBuf; 2] {
    let home = home_dir();
    [
        home.join("Library/Cookies/Cookies.binarycookies"),
        home.join("Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies"),
    ]
}

fn safari_cookie_read_error() -> String {
    "Could not read Safari cookies. Grant Pebble Full Disk Access in System Settings if access was denied.".to_string()
}

fn read_firefox_cookies(path: &Path) -> Result<Vec<RawCookieEntry>, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "Could not open the Firefox cookie database.".to_string())?;
    let has_same_site = connection
        .prepare("PRAGMA table_info(moz_cookies)")
        .and_then(|mut statement| {
            let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
            Ok(rows
                .filter_map(Result::ok)
                .any(|column| column == "sameSite"))
        })
        .unwrap_or(false);
    let same_site = if has_same_site { "sameSite" } else { "0" };
    let query = format!(
        "SELECT host, name, value, path, expiry, isSecure, isHttpOnly, {same_site} AS sameSite \
         FROM moz_cookies LIMIT {}",
        MAX_COOKIE_ENTRIES + 1
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|_| "Firefox cookie schema is not supported.".to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(RawCookieEntry {
                domain: row.get(0)?,
                name: row.get(1)?,
                value: row.get(2)?,
                path: row.get(3)?,
                expiration_date: row
                    .get::<_, Option<i64>>(4)?
                    .map(|timestamp| timestamp as f64),
                secure: Some(BoolLike::Number(row.get::<_, i64>(5)?)),
                http_only: Some(BoolLike::Number(row.get::<_, i64>(6)?)),
                same_site: Some(serde_json::Value::Number(row.get::<_, i64>(7)?.into())),
            })
        })
        .map_err(|_| "Could not read Firefox cookies.".to_string())?;
    let entries = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Firefox cookie database contains unsupported entries.".to_string())?;
    if entries.len() > MAX_COOKIE_ENTRIES {
        return Err("Firefox profile contains too many cookies.".to_string());
    }
    Ok(entries)
}

struct FirefoxCookieSnapshot {
    directory: PathBuf,
    database: PathBuf,
}

impl FirefoxCookieSnapshot {
    fn create(source: &Path) -> Result<Self, String> {
        let directory =
            env::temp_dir().join(format!("pebble-firefox-cookies-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory)
            .map_err(|_| "Could not create Firefox cookie snapshot.".to_string())?;
        let database = directory.join("cookies.sqlite");
        fs::copy(source, &database)
            .map_err(|_| "Could not snapshot Firefox cookies.".to_string())?;
        for suffix in ["-wal", "-shm"] {
            let sidecar = PathBuf::from(format!("{}{suffix}", source.to_string_lossy()));
            if sidecar.exists() {
                let _ = fs::copy(&sidecar, directory.join(format!("cookies.sqlite{suffix}")));
            }
        }
        Ok(Self {
            directory,
            database,
        })
    }

    fn database_path(&self) -> &Path {
        &self.database
    }
}

impl Drop for FirefoxCookieSnapshot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn firefox_profiles_root() -> PathBuf {
    if cfg!(target_os = "macos") {
        return home_dir()
            .join("Library")
            .join("Application Support")
            .join("Firefox")
            .join("Profiles");
    }
    if cfg!(target_os = "windows") {
        return env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join("Mozilla")
            .join("Firefox")
            .join("Profiles");
    }
    home_dir().join(".mozilla").join("firefox")
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn is_safe_profile_directory(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && !value.contains('\0')
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains("..")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use cbc::cipher::BlockEncryptMut;

    #[test]
    fn reads_firefox_cookie_schema_into_validated_entries() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("cookies.sqlite");
        let connection = Connection::open(&path).expect("sqlite");
        connection
            .execute_batch(
                "CREATE TABLE moz_cookies (
                   host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER,
                   isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER
                 );
                 INSERT INTO moz_cookies VALUES (
                   '.example.com', 'session', 'secret', '/', 2000000000, 1, 1, 2
                 );",
            )
            .expect("fixture");
        drop(connection);

        let entries = read_firefox_cookies(&path).expect("cookies");
        assert_eq!(entries.len(), 1);
        let (cookie, domain) =
            build_import_cookie(entries.into_iter().next().expect("entry")).expect("valid cookie");
        assert_eq!(cookie.name(), "session");
        assert_eq!(cookie.value(), "secret");
        assert_eq!(cookie.secure(), Some(true));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.same_site(), Some(cookie::SameSite::Strict));
        assert_eq!(domain, "example.com");
    }

    #[test]
    fn rejects_profile_directory_escape_sequences() {
        assert!(is_safe_profile_directory("abc.default-release"));
        assert!(!is_safe_profile_directory("../default"));
        assert!(!is_safe_profile_directory("folder/default"));
        assert!(!is_safe_profile_directory("folder\\default"));
    }

    #[test]
    fn decodes_safari_binary_cookie_flags_and_epoch() {
        let cookie = safari_cookie_fixture();
        let mut page = vec![0_u8; 12];
        page[0..4].copy_from_slice(&0x100_u32.to_be_bytes());
        page[4..8].copy_from_slice(&1_u32.to_le_bytes());
        page[8..12].copy_from_slice(&12_u32.to_le_bytes());
        page.extend_from_slice(&cookie);
        let mut file = b"cook".to_vec();
        file.extend_from_slice(&1_u32.to_be_bytes());
        file.extend_from_slice(&(page.len() as u32).to_be_bytes());
        file.extend_from_slice(&page);

        let entries = decode_safari_binary_cookies(&file).expect("Safari fixture");
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.domain, ".example.com");
        assert_eq!(entry.name, "session");
        assert_eq!(entry.value, "secret");
        assert!(matches!(entry.secure, Some(BoolLike::Bool(true))));
        assert!(matches!(entry.http_only, Some(BoolLike::Bool(true))));
        assert!(entry
            .expiration_date
            .is_some_and(|value| value > 2_000_000_000.0));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn decrypts_chromium_cookie_and_strips_host_hash() {
        let iterations = if cfg!(target_os = "macos") { 1003 } else { 1 };
        let mut key = [0_u8; 16];
        pbkdf2_hmac::<Sha1>(b"safe-storage-password", b"saltysalt", iterations, &mut key);
        let mut plaintext = vec![0_u8; 32];
        plaintext.extend_from_slice(b"session-secret");
        let ciphertext = cbc::Encryptor::<Aes128>::new((&key).into(), (&[b' '; 16]).into())
            .encrypt_padded_vec_mut::<Pkcs7>(&plaintext);
        let mut encrypted = b"v10".to_vec();
        encrypted.extend_from_slice(&ciphertext);

        let keys = ChromiumDecryptionKeys::Cbc {
            primary: key,
            fallback: None,
        };

        assert_eq!(
            decrypt_chromium_cookie(&encrypted, &keys).as_deref(),
            Some("session-secret")
        );
        assert_eq!(
            chromium_expiration_to_unix(13_644_473_600_000_000),
            Some(2_000_000_000.0)
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn decrypts_chromium_v10_with_linux_fallback_key() {
        let fallback = derive_chromium_cbc_key("peanuts", 1);
        let primary = derive_chromium_cbc_key("wrong-secret-service-key", 1);
        let ciphertext = cbc::Encryptor::<Aes128>::new((&fallback).into(), (&[b' '; 16]).into())
            .encrypt_padded_vec_mut::<Pkcs7>(b"linux-session");
        let mut encrypted = b"v10".to_vec();
        encrypted.extend_from_slice(&ciphertext);

        let keys = ChromiumDecryptionKeys::Cbc {
            primary,
            fallback: Some(fallback),
        };
        assert_eq!(
            decrypt_chromium_cookie(&encrypted, &keys).as_deref(),
            Some("linux-session")
        );
    }

    #[test]
    fn decrypts_windows_chromium_aes_gcm_layout() {
        let key = [7_u8; 32];
        let nonce = [3_u8; 12];
        let mut plaintext = vec![0_u8; 32];
        plaintext.extend_from_slice(b"windows-session");
        let ciphertext = Aes256Gcm::new((&key).into())
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_slice())
            .expect("encrypt fixture");
        let mut encrypted = b"v20".to_vec();
        encrypted.extend_from_slice(&nonce);
        encrypted.extend_from_slice(&ciphertext);

        assert_eq!(
            decrypt_chromium_cookie(&encrypted, &ChromiumDecryptionKeys::Gcm(key)).as_deref(),
            Some("windows-session")
        );
    }

    fn safari_cookie_fixture() -> Vec<u8> {
        let strings = b".example.com\0session\0/\0secret\0";
        let domain_offset = 48_u32;
        let name_offset = domain_offset + 13;
        let path_offset = name_offset + 8;
        let value_offset = path_offset + 2;
        let size = 48 + strings.len();
        let mut cookie = vec![0_u8; 48];
        cookie[0..4].copy_from_slice(&(size as u32).to_le_bytes());
        cookie[8..12].copy_from_slice(&5_u32.to_le_bytes());
        cookie[16..20].copy_from_slice(&domain_offset.to_le_bytes());
        cookie[20..24].copy_from_slice(&name_offset.to_le_bytes());
        cookie[24..28].copy_from_slice(&path_offset.to_le_bytes());
        cookie[28..32].copy_from_slice(&value_offset.to_le_bytes());
        cookie[40..48].copy_from_slice(&1_100_000_000_f64.to_le_bytes());
        cookie.extend_from_slice(strings);
        cookie
    }
}
