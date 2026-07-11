use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use super::{
    build_import_cookie, import_error, BoolLike, BrowserCookieImportResult,
    BrowserCookieImportSummary, RawCookieEntry, MAX_COOKIE_ENTRIES,
};

const MAX_FIREFOX_COOKIE_DB_BYTES: u64 = 256 * 1024 * 1024;

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
    if input.browser_family != "firefox" {
        return Ok(import_error(
            "Native import for this browser is not migrated to Tauri yet.",
        ));
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
}
