//! OS-native storage for the OpenAI speech API key.
//!
//! Electron stores this key with Chromium `safeStorage` in `~/.pebble`; that
//! ciphertext cannot be decrypted outside Chromium, so the Tauri shell owns its
//! own copy in the OS credential store (macOS Keychain, Windows Credential
//! Manager, Linux kernel keyutils). On Linux, keyutils entries do not persist
//! across reboots — the key must be re-entered after a restart.

use keyring::Entry;
use std::sync::Mutex;

const KEYRING_SERVICE: &str = "nebutra.pebble.speech";
const KEYRING_USER: &str = "openai-api-key";

// Why: keychain reads can prompt or block; cache the key after the first
// successful read so dictation stop (upload) never re-hits the OS store.
static CACHED_KEY: Mutex<Option<String>> = Mutex::new(None);

fn entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

pub fn save_key(api_key: &str) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("OpenAI API key is required".to_string());
    }
    entry()?
        .set_password(trimmed)
        .map_err(|e| format!("Failed to store OpenAI API key: {e}"))?;
    *CACHED_KEY.lock().expect("speech key cache poisoned") = Some(trimmed.to_string());
    Ok(())
}

pub fn read_key() -> Result<String, String> {
    if let Some(cached) = CACHED_KEY
        .lock()
        .expect("speech key cache poisoned")
        .clone()
    {
        return Ok(cached);
    }
    match entry()?.get_password() {
        Ok(key) => {
            *CACHED_KEY.lock().expect("speech key cache poisoned") = Some(key.clone());
            Ok(key)
        }
        Err(keyring::Error::NoEntry) => Err("OpenAI API key is not configured".to_string()),
        Err(e) => Err(format!("OpenAI API key could not be read: {e}")),
    }
}

pub fn has_key() -> bool {
    if CACHED_KEY
        .lock()
        .expect("speech key cache poisoned")
        .is_some()
    {
        return true;
    }
    matches!(entry().map(|e| e.get_password()), Ok(Ok(_)))
}

pub fn clear_key() -> Result<(), String> {
    *CACHED_KEY.lock().expect("speech key cache poisoned") = None;
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to clear OpenAI API key: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    fn use_mock_store() {
        // Why: the default credential builder can only be swapped once per
        // process; tests share the mock store instead of the real keychain.
        static MOCK: OnceLock<()> = OnceLock::new();
        MOCK.get_or_init(|| {
            keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        });
    }

    #[test]
    fn key_store_roundtrip() {
        use_mock_store();
        clear_key().expect("clear");
        assert!(!has_key());
        assert!(read_key().is_err());

        save_key("  sk-test-123  ").expect("save");
        assert!(has_key());
        assert_eq!(read_key().expect("read"), "sk-test-123");

        clear_key().expect("clear");
        assert!(!has_key());
        assert!(read_key().is_err());
    }

    #[test]
    fn rejects_empty_key() {
        use_mock_store();
        assert!(save_key("   ").is_err());
    }
}
