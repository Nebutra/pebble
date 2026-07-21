use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{State, Url};

const MAX_PERMISSION_OVERRIDES: usize = 2048;
const MAX_PERMISSION_PROFILE_ID_BYTES: usize = 160;
const MAX_PERMISSION_ORIGIN_BYTES: usize = 2048;
const MAX_PERMISSION_NAME_BYTES: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BrowserPermissionDecision {
    Allow,
    Deny,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum BrowserPermissionOverrideState {
    Prompt,
    Granted,
    Denied,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPermissionOverrideInput {
    #[serde(default)]
    pub(crate) profile_id: Option<String>,
    pub(crate) origin: String,
    pub(crate) name: String,
    pub(crate) state: BrowserPermissionOverrideState,
    pub(crate) updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPermissionOverridesSyncInput {
    overrides: Vec<BrowserPermissionOverrideInput>,
}

#[derive(Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPermissionOverridesSyncResult {
    applied: usize,
    ignored: usize,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct BrowserPermissionOverrideKey {
    profile_id: String,
    origin: String,
    permission: &'static str,
}

#[derive(Clone, Copy, Debug)]
struct StoredBrowserPermissionOverride {
    // Why: macOS hydrates the same records for cross-platform state parity,
    // while only Linux/Windows currently expose native permission callbacks.
    #[cfg_attr(
        not(any(test, target_os = "linux", target_os = "windows")),
        allow(dead_code)
    )]
    decision: Option<BrowserPermissionDecision>,
    updated_at: DateTime<Utc>,
}

#[derive(Clone, Default)]
pub struct NativeBrowserPermissionOverrideRegistry(
    Arc<Mutex<HashMap<BrowserPermissionOverrideKey, StoredBrowserPermissionOverride>>>,
);

#[tauri::command]
pub fn browser_permission_overrides_sync(
    state: State<'_, NativeBrowserPermissionOverrideRegistry>,
    input: BrowserPermissionOverridesSyncInput,
) -> Result<BrowserPermissionOverridesSyncResult, String> {
    state.sync(&input.overrides)
}

impl NativeBrowserPermissionOverrideRegistry {
    pub(crate) fn sync(
        &self,
        records: &[BrowserPermissionOverrideInput],
    ) -> Result<BrowserPermissionOverridesSyncResult, String> {
        if records.len() > MAX_PERMISSION_OVERRIDES {
            return Err(format!(
                "browser permission overrides exceed {MAX_PERMISSION_OVERRIDES} entries"
            ));
        }
        let mut overrides = self
            .0
            .lock()
            .map_err(|_| "browser permission override state poisoned".to_string())?;
        let mut applied = 0;
        let mut ignored = 0;
        for record in records {
            let Some((key, value)) = normalize_permission_override(record) else {
                ignored += 1;
                continue;
            };
            if overrides
                .get(&key)
                .is_some_and(|existing| existing.updated_at > value.updated_at)
            {
                ignored += 1;
                continue;
            }
            overrides.insert(key, value);
            applied += 1;
        }
        Ok(BrowserPermissionOverridesSyncResult { applied, ignored })
    }

    pub(crate) fn decision(
        &self,
        profile_id: &str,
        raw_origin: &str,
        permission: &'static str,
    ) -> Option<BrowserPermissionDecision> {
        // Why: `prompt` is persisted as an explicit reset, so it intentionally
        // falls through to the native default instead of becoming an allow.
        let origin = normalize_permission_origin(raw_origin)?;
        self.0
            .lock()
            .ok()?
            .get(&BrowserPermissionOverrideKey {
                profile_id: profile_id.to_string(),
                origin,
                permission,
            })
            .and_then(|entry| entry.decision)
    }
}

fn normalize_permission_override(
    record: &BrowserPermissionOverrideInput,
) -> Option<(
    BrowserPermissionOverrideKey,
    StoredBrowserPermissionOverride,
)> {
    let profile_id = normalize_profile_id(record.profile_id.as_deref())?;
    let origin = normalize_permission_origin(&record.origin)?;
    let permission = normalize_permission_name(&record.name)?;
    let updated_at = DateTime::parse_from_rfc3339(record.updated_at.trim())
        .ok()?
        .with_timezone(&Utc);
    let decision = match record.state {
        BrowserPermissionOverrideState::Prompt => None,
        BrowserPermissionOverrideState::Granted => Some(BrowserPermissionDecision::Allow),
        BrowserPermissionOverrideState::Denied => Some(BrowserPermissionDecision::Deny),
    };
    Some((
        BrowserPermissionOverrideKey {
            profile_id,
            origin,
            permission,
        },
        StoredBrowserPermissionOverride {
            decision,
            updated_at,
        },
    ))
}

fn normalize_profile_id(value: Option<&str>) -> Option<String> {
    let value = value.unwrap_or_default().trim();
    (value.len() <= MAX_PERMISSION_PROFILE_ID_BYTES).then(|| value.to_string())
}

fn normalize_permission_origin(value: &str) -> Option<String> {
    if value.len() > MAX_PERMISSION_ORIGIN_BYTES {
        return None;
    }
    let url = Url::parse(value.trim()).ok()?;
    let origin = url.origin().ascii_serialization();
    (origin != "null").then_some(origin)
}

fn normalize_permission_name(value: &str) -> Option<&'static str> {
    if value.len() > MAX_PERMISSION_NAME_BYTES {
        return None;
    }
    let normalized = value.trim().to_ascii_lowercase().replace('_', "-");
    match normalized.as_str() {
        "camera" | "microphone" | "media" => Some("media"),
        "clipboard" | "clipboard-read" | "clipboardread" => Some("clipboard-read"),
        "display-capture" | "display-media" | "displaycapture" => Some("display-capture"),
        "geolocation" => Some("geolocation"),
        "hid" | "webhid" => Some("hid"),
        "notification" | "notifications" => Some("notifications"),
        "persistent-storage" | "persistentstorage" => Some("persistent-storage"),
        "webauthn" | "web-authn" => Some("webauthn"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_profile_scoped_aliases_to_canonical_origins() {
        let registry = NativeBrowserPermissionOverrideRegistry::default();
        let result = registry
            .sync(&[
                permission_override(
                    Some("bprof_1"),
                    "https://example.test/settings",
                    "camera",
                    BrowserPermissionOverrideState::Denied,
                    "2026-07-17T08:00:00Z",
                ),
                permission_override(
                    Some("bprof_1"),
                    "https://example.test",
                    "clipboard",
                    BrowserPermissionOverrideState::Granted,
                    "2026-07-17T08:00:01Z",
                ),
            ])
            .expect("permission records should sync");

        assert_eq!(
            result,
            BrowserPermissionOverridesSyncResult {
                applied: 2,
                ignored: 0
            }
        );
        assert_eq!(
            registry.decision("bprof_1", "https://example.test/camera", "media"),
            Some(BrowserPermissionDecision::Deny)
        );
        assert_eq!(
            registry.decision("bprof_1", "https://example.test/copy", "clipboard-read"),
            Some(BrowserPermissionDecision::Allow)
        );
        assert_eq!(
            registry.decision("bprof_2", "https://example.test/camera", "media"),
            None
        );
    }

    #[test]
    fn newer_prompt_resets_an_override_and_stale_events_cannot_restore_it() {
        let registry = NativeBrowserPermissionOverrideRegistry::default();
        registry
            .sync(&[permission_override(
                None,
                "https://example.test",
                "geolocation",
                BrowserPermissionOverrideState::Granted,
                "2026-07-17T08:00:00Z",
            )])
            .expect("initial permission should sync");
        registry
            .sync(&[permission_override(
                None,
                "https://example.test",
                "geolocation",
                BrowserPermissionOverrideState::Prompt,
                "2026-07-17T08:00:02Z",
            )])
            .expect("prompt reset should sync");
        let stale = registry
            .sync(&[permission_override(
                None,
                "https://example.test",
                "geolocation",
                BrowserPermissionOverrideState::Granted,
                "2026-07-17T08:00:01Z",
            )])
            .expect("stale events are ignored without failing the stream");

        assert_eq!(stale.applied, 0);
        assert_eq!(stale.ignored, 1);
        assert_eq!(
            registry.decision("", "https://example.test/map", "geolocation"),
            None
        );
    }

    #[test]
    fn ignores_invalid_origins_unknown_names_and_timestamps() {
        let registry = NativeBrowserPermissionOverrideRegistry::default();
        let result = registry
            .sync(&[
                permission_override(
                    None,
                    "not an origin",
                    "camera",
                    BrowserPermissionOverrideState::Granted,
                    "2026-07-17T08:00:00Z",
                ),
                permission_override(
                    None,
                    "https://example.test",
                    "serial-port",
                    BrowserPermissionOverrideState::Granted,
                    "2026-07-17T08:00:00Z",
                ),
                permission_override(
                    None,
                    "https://example.test",
                    "camera",
                    BrowserPermissionOverrideState::Granted,
                    "yesterday",
                ),
            ])
            .expect("invalid records should not poison valid future updates");

        assert_eq!(result.applied, 0);
        assert_eq!(result.ignored, 3);
    }

    #[test]
    fn persists_sensitive_device_overrides_without_widening_the_origin() {
        let registry = NativeBrowserPermissionOverrideRegistry::default();
        registry
            .sync(&[
                permission_override(
                    Some("bprof_security"),
                    "https://login.example.test/start",
                    "webhid",
                    BrowserPermissionOverrideState::Granted,
                    "2026-07-17T08:00:00Z",
                ),
                permission_override(
                    Some("bprof_security"),
                    "https://login.example.test",
                    "web-authn",
                    BrowserPermissionOverrideState::Denied,
                    "2026-07-17T08:00:01Z",
                ),
            ])
            .expect("device permission records should sync");

        assert_eq!(
            registry.decision("bprof_security", "https://login.example.test/finish", "hid"),
            Some(BrowserPermissionDecision::Allow)
        );
        assert_eq!(
            registry.decision("bprof_security", "https://login.example.test", "webauthn"),
            Some(BrowserPermissionDecision::Deny)
        );
        assert_eq!(
            registry.decision("bprof_security", "https://other.example.test", "hid"),
            None
        );
    }

    fn permission_override(
        profile_id: Option<&str>,
        origin: &str,
        name: &str,
        state: BrowserPermissionOverrideState,
        updated_at: &str,
    ) -> BrowserPermissionOverrideInput {
        BrowserPermissionOverrideInput {
            profile_id: profile_id.map(str::to_string),
            origin: origin.to_string(),
            name: name.to_string(),
            state,
            updated_at: updated_at.to_string(),
        }
    }
}
