use serde::{Deserialize, Serialize};
use tauri::{State, Url};

use super::browser_child_webview::browser_permission_overrides::{
    BrowserPermissionDecision, NativeBrowserPermissionOverrideRegistry,
};

const FIDO_HID_USAGE_PAGE: u32 = 0xf1d0;
const MAX_CANDIDATES: usize = 64;
const MAX_IDENTIFIER_BYTES: usize = 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserDeviceSelectionKind {
    Hid,
    WebauthnAccount,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDeviceCandidate {
    id: String,
    #[serde(default)]
    usage_pages: Vec<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDeviceSelectionInput {
    #[serde(default)]
    profile_id: String,
    origin: String,
    kind: BrowserDeviceSelectionKind,
    candidates: Vec<BrowserDeviceCandidate>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserDeviceSelectionStatus {
    Selected,
    Denied,
    Ambiguous,
    Unsupported,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDeviceSelectionResult {
    status: BrowserDeviceSelectionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_id: Option<String>,
    code: &'static str,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDeviceAccessCapabilities {
    platform: &'static str,
    persistent_overrides: bool,
    webauthn_engine: &'static str,
    hid_permission_hook: &'static str,
    hid_selection_hook: &'static str,
    webauthn_account_selection_hook: &'static str,
    reason: &'static str,
}

#[tauri::command]
pub fn browser_device_access_capabilities() -> BrowserDeviceAccessCapabilities {
    platform_capabilities()
}

#[tauri::command]
pub fn browser_device_selection_resolve(
    state: State<'_, NativeBrowserPermissionOverrideRegistry>,
    input: BrowserDeviceSelectionInput,
) -> Result<BrowserDeviceSelectionResult, String> {
    resolve_selection(&state, input)
}

fn resolve_selection(
    overrides: &NativeBrowserPermissionOverrideRegistry,
    input: BrowserDeviceSelectionInput,
) -> Result<BrowserDeviceSelectionResult, String> {
    resolve_selection_with_hook(overrides, input, selection_hook_available)
}

fn resolve_selection_with_hook(
    overrides: &NativeBrowserPermissionOverrideRegistry,
    input: BrowserDeviceSelectionInput,
    hook_available: impl FnOnce(BrowserDeviceSelectionKind) -> bool,
) -> Result<BrowserDeviceSelectionResult, String> {
    validate_input(&input)?;
    let permission = match input.kind {
        BrowserDeviceSelectionKind::Hid => "hid",
        BrowserDeviceSelectionKind::WebauthnAccount => "webauthn",
    };
    if !is_secure_browser_origin(&input.origin) {
        return Ok(selection_result(
            BrowserDeviceSelectionStatus::Denied,
            None,
            "insecure_origin",
        ));
    }
    if overrides.decision(&input.profile_id, &input.origin, permission)
        != Some(BrowserPermissionDecision::Allow)
    {
        return Ok(selection_result(
            BrowserDeviceSelectionStatus::Denied,
            None,
            "explicit_grant_required",
        ));
    }

    // Why: Wry does not expose Electron-equivalent HID/account selection callbacks;
    // never imply that a policy decision can select a native device by itself.
    if !hook_available(input.kind) {
        return Ok(selection_result(
            BrowserDeviceSelectionStatus::Unsupported,
            None,
            "native_selection_hook_unavailable",
        ));
    }

    let eligible: Vec<&BrowserDeviceCandidate> = input
        .candidates
        .iter()
        .filter(|candidate| match input.kind {
            BrowserDeviceSelectionKind::Hid => candidate.usage_pages.contains(&FIDO_HID_USAGE_PAGE),
            BrowserDeviceSelectionKind::WebauthnAccount => true,
        })
        .collect();
    match eligible.as_slice() {
        [candidate] => Ok(selection_result(
            BrowserDeviceSelectionStatus::Selected,
            Some(candidate.id.clone()),
            "selected",
        )),
        [] => Ok(selection_result(
            BrowserDeviceSelectionStatus::Denied,
            None,
            "no_eligible_candidate",
        )),
        _ => Ok(selection_result(
            BrowserDeviceSelectionStatus::Ambiguous,
            None,
            "user_selection_required",
        )),
    }
}

fn validate_input(input: &BrowserDeviceSelectionInput) -> Result<(), String> {
    if input.candidates.len() > MAX_CANDIDATES {
        return Err(format!(
            "browser device candidates exceed {MAX_CANDIDATES} entries"
        ));
    }
    if input.profile_id.len() > 160 || input.origin.len() > 2048 {
        return Err("browser device selection scope is too large".to_string());
    }
    if input.candidates.iter().any(|candidate| {
        candidate.id.trim().is_empty() || candidate.id.len() > MAX_IDENTIFIER_BYTES
    }) {
        return Err("browser device candidate identifier is invalid".to_string());
    }
    Ok(())
}

fn is_secure_browser_origin(value: &str) -> bool {
    let Ok(url) = Url::parse(value.trim()) else {
        return false;
    };
    if url.username() != "" || url.password().is_some() {
        return false;
    }
    url.scheme() == "https"
        || (url.scheme() == "http"
            && matches!(
                url.host_str(),
                Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
            ))
}

fn selection_result(
    status: BrowserDeviceSelectionStatus,
    selected_id: Option<String>,
    code: &'static str,
) -> BrowserDeviceSelectionResult {
    BrowserDeviceSelectionResult {
        status,
        selected_id,
        code,
    }
}

fn selection_hook_available(_kind: BrowserDeviceSelectionKind) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn platform_capabilities() -> BrowserDeviceAccessCapabilities {
    BrowserDeviceAccessCapabilities {
        platform: "macos",
        persistent_overrides: true,
        webauthn_engine: "native-platform-dependent",
        hid_permission_hook: "unavailable",
        hid_selection_hook: "unavailable",
        webauthn_account_selection_hook: "unavailable",
        reason: "WKWebView does not expose programmable HID or WebAuthn account selection hooks",
    }
}

#[cfg(target_os = "windows")]
fn platform_capabilities() -> BrowserDeviceAccessCapabilities {
    BrowserDeviceAccessCapabilities {
        platform: "windows",
        persistent_overrides: true,
        webauthn_engine: "native-platform-dependent",
        hid_permission_hook: "unavailable",
        hid_selection_hook: "unavailable",
        webauthn_account_selection_hook: "unavailable",
        reason: "WebView2 permission events do not expose FIDO HID identity or account selection",
    }
}

#[cfg(target_os = "linux")]
fn platform_capabilities() -> BrowserDeviceAccessCapabilities {
    BrowserDeviceAccessCapabilities {
        platform: "linux",
        persistent_overrides: true,
        webauthn_engine: "native-platform-dependent",
        hid_permission_hook: "unavailable",
        hid_selection_hook: "unavailable",
        webauthn_account_selection_hook: "unavailable",
        reason: "WebKitGTK does not expose programmable WebHID or WebAuthn account selection hooks",
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn platform_capabilities() -> BrowserDeviceAccessCapabilities {
    BrowserDeviceAccessCapabilities {
        platform: "unknown",
        persistent_overrides: true,
        webauthn_engine: "unsupported",
        hid_permission_hook: "unavailable",
        hid_selection_hook: "unavailable",
        webauthn_account_selection_hook: "unavailable",
        reason: "browser device access is unsupported on this platform",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::browser_child_webview::browser_permission_overrides::{
        BrowserPermissionOverrideInput, BrowserPermissionOverrideState,
    };

    fn input(kind: BrowserDeviceSelectionKind, origin: &str) -> BrowserDeviceSelectionInput {
        BrowserDeviceSelectionInput {
            profile_id: "bprof_security".to_string(),
            origin: origin.to_string(),
            kind,
            candidates: vec![BrowserDeviceCandidate {
                id: "security-key-1".to_string(),
                usage_pages: vec![FIDO_HID_USAGE_PAGE],
            }],
        }
    }

    #[test]
    fn denies_sensitive_devices_without_an_explicit_persisted_grant() {
        let result = resolve_selection(
            &NativeBrowserPermissionOverrideRegistry::default(),
            input(
                BrowserDeviceSelectionKind::Hid,
                "https://login.example.test",
            ),
        )
        .unwrap();
        assert_eq!(result.status, BrowserDeviceSelectionStatus::Denied);
        assert_eq!(result.code, "explicit_grant_required");
    }

    #[test]
    fn rejects_insecure_origins_even_when_a_grant_exists() {
        let registry = NativeBrowserPermissionOverrideRegistry::default();
        registry
            .sync(&[BrowserPermissionOverrideInput {
                profile_id: Some("bprof_security".to_string()),
                origin: "http://example.test".to_string(),
                name: "hid".to_string(),
                state: BrowserPermissionOverrideState::Granted,
                updated_at: "2026-07-17T08:00:00Z".to_string(),
            }])
            .unwrap();
        let result = resolve_selection(
            &registry,
            input(BrowserDeviceSelectionKind::Hid, "http://example.test"),
        )
        .unwrap();
        assert_eq!(result.code, "insecure_origin");
    }

    #[test]
    fn reports_typed_unsupported_when_wry_has_no_selection_hook() {
        let registry = NativeBrowserPermissionOverrideRegistry::default();
        registry
            .sync(&[BrowserPermissionOverrideInput {
                profile_id: Some("bprof_security".to_string()),
                origin: "https://login.example.test".to_string(),
                name: "hid".to_string(),
                state: BrowserPermissionOverrideState::Granted,
                updated_at: "2026-07-17T08:00:00Z".to_string(),
            }])
            .unwrap();
        let result = resolve_selection(
            &registry,
            input(
                BrowserDeviceSelectionKind::Hid,
                "https://login.example.test",
            ),
        )
        .unwrap();
        assert_eq!(result.status, BrowserDeviceSelectionStatus::Unsupported);
        assert_eq!(result.selected_id, None);
    }

    #[test]
    fn accepts_https_and_localhost_only() {
        assert!(is_secure_browser_origin("https://example.test/path"));
        assert!(is_secure_browser_origin("http://localhost/path"));
        assert!(!is_secure_browser_origin("http://example.test"));
        assert!(!is_secure_browser_origin("https://user@example.test"));
        assert!(is_secure_browser_origin("https://example.test:8443"));
    }

    #[test]
    fn a_native_hook_can_only_select_one_fido_hid_candidate() {
        let registry = granted_registry("hid");
        let mut request = input(
            BrowserDeviceSelectionKind::Hid,
            "https://login.example.test",
        );
        request.candidates.insert(
            0,
            BrowserDeviceCandidate {
                id: "keyboard".to_string(),
                usage_pages: vec![1],
            },
        );
        let result = resolve_selection_with_hook(&registry, request, |_| true).unwrap();
        assert_eq!(result.status, BrowserDeviceSelectionStatus::Selected);
        assert_eq!(result.selected_id.as_deref(), Some("security-key-1"));
    }

    #[test]
    fn a_native_hook_never_auto_selects_ambiguous_webauthn_accounts() {
        let registry = granted_registry("webauthn");
        let mut request = input(
            BrowserDeviceSelectionKind::WebauthnAccount,
            "https://login.example.test",
        );
        request.candidates.push(BrowserDeviceCandidate {
            id: "credential-2".to_string(),
            usage_pages: Vec::new(),
        });
        let result = resolve_selection_with_hook(&registry, request, |_| true).unwrap();
        assert_eq!(result.status, BrowserDeviceSelectionStatus::Ambiguous);
        assert_eq!(result.selected_id, None);
        assert_eq!(result.code, "user_selection_required");
    }

    fn granted_registry(permission: &str) -> NativeBrowserPermissionOverrideRegistry {
        let registry = NativeBrowserPermissionOverrideRegistry::default();
        registry
            .sync(&[BrowserPermissionOverrideInput {
                profile_id: Some("bprof_security".to_string()),
                origin: "https://login.example.test".to_string(),
                name: permission.to_string(),
                state: BrowserPermissionOverrideState::Granted,
                updated_at: "2026-07-17T08:00:00Z".to_string(),
            }])
            .unwrap();
        registry
    }
}
