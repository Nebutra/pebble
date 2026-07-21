use keyring::Entry;
use std::sync::Mutex;

const KEYRING_SERVICE: &str = "nebutra.pebble.minimax";
const KEYRING_USER: &str = "session-cookie";

static CACHED_COOKIE: Mutex<Option<String>> = Mutex::new(None);

fn entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|error| error.to_string())
}

pub fn read_cookie() -> Result<String, String> {
    if let Some(cookie) = CACHED_COOKIE
        .lock()
        .expect("MiniMax cookie cache poisoned")
        .clone()
    {
        return Ok(cookie);
    }
    match entry()?.get_password() {
        Ok(cookie) => {
            *CACHED_COOKIE.lock().expect("MiniMax cookie cache poisoned") = Some(cookie.clone());
            Ok(cookie)
        }
        Err(keyring::Error::NoEntry) => Err("MiniMax session cookie not configured".to_string()),
        Err(error) => Err(format!("MiniMax session cookie could not be read: {error}")),
    }
}

fn has_cookie() -> bool {
    CACHED_COOKIE
        .lock()
        .expect("MiniMax cookie cache poisoned")
        .is_some()
        || matches!(entry().map(|entry| entry.get_password()), Ok(Ok(_)))
}

#[tauri::command]
pub fn minimax_credentials_get_status() -> serde_json::Value {
    serde_json::json!({ "configured": has_cookie() })
}

#[tauri::command]
pub fn minimax_credentials_save_cookie(cookie: String) -> Result<serde_json::Value, String> {
    let cookie = cookie.trim();
    if cookie.is_empty() {
        return Err("MiniMax session cookie is required".to_string());
    }
    entry()?
        .set_password(cookie)
        .map_err(|error| format!("Failed to store MiniMax session cookie: {error}"))?;
    *CACHED_COOKIE.lock().expect("MiniMax cookie cache poisoned") = Some(cookie.to_string());
    Ok(serde_json::json!({ "configured": true }))
}

#[tauri::command]
pub fn minimax_credentials_clear_cookie() -> Result<serde_json::Value, String> {
    *CACHED_COOKIE.lock().expect("MiniMax cookie cache poisoned") = None;
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(serde_json::json!({ "configured": false })),
        Err(error) => Err(format!("Failed to clear MiniMax session cookie: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    fn use_mock_store() {
        static MOCK: OnceLock<()> = OnceLock::new();
        MOCK.get_or_init(|| {
            keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        });
    }

    #[test]
    fn credential_roundtrip_and_empty_rejection() {
        use_mock_store();
        minimax_credentials_clear_cookie().unwrap();
        assert_eq!(minimax_credentials_get_status()["configured"], false);
        assert!(minimax_credentials_save_cookie("   ".to_string()).is_err());
        minimax_credentials_save_cookie("  _token=secret  ".to_string()).unwrap();
        assert_eq!(read_cookie().unwrap(), "_token=secret");
        assert_eq!(minimax_credentials_get_status()["configured"], true);
        minimax_credentials_clear_cookie().unwrap();
    }
}
