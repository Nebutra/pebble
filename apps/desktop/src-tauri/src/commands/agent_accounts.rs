//! Read-side auth status probes for the Codex and Claude CLIs.
//!
//! Codex identity comes from `$CODEX_HOME/auth.json` (id_token JWT claims),
//! Claude OAuth credentials come from the macOS Keychain item the Claude CLI
//! writes (`Claude Code-credentials`, config-dir-scoped on 2.1+) with
//! `~/.claude/.credentials.json` as the cross-platform fallback, and Claude
//! identity comes from `oauthAccount` in `~/.claude.json`. Interactive OAuth
//! login/add flows live in the managed-account commands and canonical Tauri
//! terminal bridge; this module intentionally remains read-only.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;

/// Same budget as preflight auth probes: a wedged `security` binary or a
/// locked keychain prompt must not stall callers indefinitely.
const KEYCHAIN_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

const ACTIVE_CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthStatus {
    pub authenticated: bool,
    /// "oauth" | "api-key" when authenticated.
    pub method: Option<String>,
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub plan_type: Option<String>,
    pub credential_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthStatus {
    pub authenticated: bool,
    /// "subscription-oauth" when an OAuth access token is present.
    pub method: Option<String>,
    pub email: Option<String>,
    pub organization_uuid: Option<String>,
    pub organization_name: Option<String>,
    /// "keychain" | "scoped-keychain" | "credentials-file" | "none".
    pub credential_source: String,
    pub has_refreshable_credentials: bool,
    pub keychain_unavailable: bool,
    pub subscription_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccountAuthStatus {
    pub codex: CodexAuthStatus,
    pub claude: ClaudeAuthStatus,
}

/// Probe both CLIs' host credential stores. Read-only: never mutates the
/// stores and never triggers a login.
#[tauri::command]
pub async fn agent_account_auth_status() -> AgentAccountAuthStatus {
    tauri::async_runtime::spawn_blocking(|| AgentAccountAuthStatus {
        codex: read_codex_auth_status(),
        claude: read_claude_auth_status(),
    })
    .await
    .unwrap_or_else(|_| AgentAccountAuthStatus {
        codex: unauthenticated_codex_status(),
        claude: unauthenticated_claude_status("none", false),
    })
}

// ---------------------------------------------------------------------------
// Codex — $CODEX_HOME/auth.json
// ---------------------------------------------------------------------------

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

pub fn resolve_codex_home() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("CODEX_HOME") {
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    home_dir().map(|home| home.join(".codex"))
}

fn unauthenticated_codex_status() -> CodexAuthStatus {
    CodexAuthStatus {
        authenticated: false,
        method: None,
        email: None,
        account_id: None,
        plan_type: None,
        credential_path: None,
    }
}

pub fn read_codex_auth_status() -> CodexAuthStatus {
    match resolve_codex_home() {
        Some(home) => read_codex_auth_status_at(&home),
        None => unauthenticated_codex_status(),
    }
}

/// Read the Codex CLI's own credential file. `tokens.access_token` proves an
/// OAuth login; a bare `OPENAI_API_KEY` field is api-key auth.
pub fn read_codex_auth_status_at(codex_home: &Path) -> CodexAuthStatus {
    let auth_path = codex_home.join("auth.json");
    let raw = match std::fs::read_to_string(&auth_path) {
        Ok(raw) => raw,
        Err(_) => return unauthenticated_codex_status(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(_) => return unauthenticated_codex_status(),
    };

    let tokens = parsed.get("tokens");
    let access_token = tokens
        .and_then(|t| t.get("access_token"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty());
    let api_key = parsed
        .get("OPENAI_API_KEY")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty());

    if access_token.is_none() && api_key.is_none() {
        return unauthenticated_codex_status();
    }

    let id_token = tokens
        .and_then(|t| t.get("id_token").or_else(|| t.get("idToken")))
        .and_then(|v| v.as_str());
    let claims = id_token.and_then(decode_jwt_payload);
    let auth_claims = claims
        .as_ref()
        .and_then(|c| c.get("https://api.openai.com/auth"));
    let profile_claims = claims
        .as_ref()
        .and_then(|c| c.get("https://api.openai.com/profile"));

    let email = claims
        .as_ref()
        .and_then(|c| c.get("email"))
        .or_else(|| profile_claims.and_then(|p| p.get("email")))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let account_id = tokens
        .and_then(|t| t.get("account_id").or_else(|| t.get("accountId")))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            auth_claims
                .and_then(|a| a.get("chatgpt_account_id"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });
    let plan_type = auth_claims
        .and_then(|a| a.get("chatgpt_plan_type"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    CodexAuthStatus {
        authenticated: true,
        method: Some(if access_token.is_some() {
            "oauth".to_string()
        } else {
            "api-key".to_string()
        }),
        email,
        account_id,
        plan_type,
        credential_path: Some(auth_path.to_string_lossy().to_string()),
    }
}

/// Read `tokens.access_token` (+ optional `tokens.account_id`) from a Codex
/// home for authenticated backend calls. Used by the rate-limit fetcher.
pub fn read_codex_access_token(codex_home: &Path) -> Option<(String, Option<String>)> {
    let raw = std::fs::read_to_string(codex_home.join("auth.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let tokens = parsed.get("tokens")?;
    let access_token = tokens.get("access_token")?.as_str()?.trim().to_string();
    if access_token.is_empty() {
        return None;
    }
    let account_id = tokens
        .get("account_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Some((access_token, account_id))
}

fn decode_jwt_payload(token: &str) -> Option<serde_json::Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

// ---------------------------------------------------------------------------
// Claude — macOS Keychain + ~/.claude/.credentials.json + ~/.claude.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeOauthCredentials {
    pub access_token: Option<String>,
    pub has_refreshable_credentials: bool,
    /// "keychain" | "scoped-keychain" | "credentials-file" | "none".
    pub source: &'static str,
    pub keychain_unavailable: bool,
    pub subscription_type: Option<String>,
}

fn empty_claude_credentials(keychain_unavailable: bool) -> ClaudeOauthCredentials {
    ClaudeOauthCredentials {
        access_token: None,
        has_refreshable_credentials: false,
        source: "none",
        keychain_unavailable,
        subscription_type: None,
    }
}

pub fn resolve_claude_config_dir() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    home_dir().map(|home| home.join(".claude"))
}

/// Claude Code 2.1+ scopes the Keychain service by config dir using the first
/// 8 hex chars of sha256(CLAUDE_CONFIG_DIR); the unsuffixed service is the
/// legacy/default item required for older Claude Code installations.
pub fn scoped_claude_keychain_service(config_dir: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(config_dir.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{ACTIVE_CLAUDE_KEYCHAIN_SERVICE}-{}", &hex[..8])
}

fn keychain_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "user".to_string())
}

/// `Ok(None)` means the item genuinely does not exist; `Err` means the
/// keychain itself could not be consulted (locked, timeout, missing binary).
pub(crate) fn read_keychain_password(service: &str) -> Result<Option<String>, String> {
    let mut child = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            service,
            "-a",
            &keychain_user(),
            "-w",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("could not run security: {err}"))?;

    let deadline = Instant::now() + KEYCHAIN_PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_string(&mut stdout);
                }
                let trimmed = stdout.trim();
                if status.success() && !trimmed.is_empty() {
                    return Ok(Some(trimmed.to_string()));
                }
                // `security` exits 44 (errSecItemNotFound) for a missing item.
                return Ok(None);
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("keychain probe timed out".to_string());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(err) => return Err(format!("keychain probe failed: {err}")),
        }
    }
}

pub(crate) fn parse_claude_oauth_json(raw: &str, source: &'static str) -> ClaudeOauthCredentials {
    let parsed: serde_json::Value = match serde_json::from_str(raw) {
        Ok(parsed) => parsed,
        Err(_) => return empty_claude_credentials(false),
    };
    let oauth = parsed.get("claudeAiOauth");
    let access_token = oauth
        .and_then(|o| o.get("accessToken"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    let has_refreshable_credentials = oauth
        .and_then(|o| o.get("refreshToken"))
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let subscription_type = oauth
        .and_then(|o| o.get("subscriptionType"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    ClaudeOauthCredentials {
        source: if access_token.is_some() || has_refreshable_credentials {
            source
        } else {
            "none"
        },
        access_token,
        has_refreshable_credentials,
        keychain_unavailable: false,
        subscription_type,
    }
}

fn read_claude_credentials_from_keychain(config_dir: Option<&Path>) -> ClaudeOauthCredentials {
    if !cfg!(target_os = "macos") {
        return empty_claude_credentials(false);
    }
    let mut keychain_unavailable = false;

    // Scoped item first (Claude Code 2.1+), then the legacy unsuffixed item.
    let mut services: Vec<(String, &'static str)> = Vec::new();
    if let Some(dir) = config_dir {
        services.push((
            scoped_claude_keychain_service(&dir.to_string_lossy()),
            "scoped-keychain",
        ));
    }
    services.push((ACTIVE_CLAUDE_KEYCHAIN_SERVICE.to_string(), "keychain"));

    for (service, source) in services {
        match read_keychain_password(&service) {
            Ok(Some(raw)) => {
                let credentials = parse_claude_oauth_json(&raw, source);
                if credentials.access_token.is_some() || credentials.has_refreshable_credentials {
                    return credentials;
                }
            }
            Ok(None) => {}
            Err(_) => keychain_unavailable = true,
        }
    }
    empty_claude_credentials(keychain_unavailable)
}

pub fn read_claude_credentials_file(config_dir: &Path) -> ClaudeOauthCredentials {
    match std::fs::read_to_string(config_dir.join(".credentials.json")) {
        Ok(raw) => parse_claude_oauth_json(&raw, "credentials-file"),
        Err(_) => empty_claude_credentials(false),
    }
}

/// Credential source order mirrors Electron's claude-fetcher: Keychain OAuth
/// first, then the plain credentials file. ANTHROPIC_API_KEY is deliberately
/// ignored — API keys 401 on the OAuth usage endpoint.
pub fn read_claude_oauth_credentials() -> ClaudeOauthCredentials {
    let config_dir = resolve_claude_config_dir();
    let from_keychain = read_claude_credentials_from_keychain(config_dir.as_deref());
    if from_keychain.access_token.is_some() || from_keychain.has_refreshable_credentials {
        return from_keychain;
    }
    if let Some(dir) = config_dir {
        let from_file = read_claude_credentials_file(&dir);
        if from_file.access_token.is_some() || from_file.has_refreshable_credentials {
            return from_file;
        }
    }
    from_keychain
}

fn unauthenticated_claude_status(
    credential_source: &str,
    keychain_unavailable: bool,
) -> ClaudeAuthStatus {
    ClaudeAuthStatus {
        authenticated: false,
        method: None,
        email: None,
        organization_uuid: None,
        organization_name: None,
        credential_source: credential_source.to_string(),
        has_refreshable_credentials: false,
        keychain_unavailable,
        subscription_type: None,
    }
}

/// Identity (email/org) lives in `oauthAccount` inside `~/.claude.json` (or
/// `<config dir>/.claude.json` / `.config.json`), not in the credential blob.
pub fn read_claude_oauth_account_identity(
    config_dir: &Path,
) -> (Option<String>, Option<String>, Option<String>) {
    let mut candidates: Vec<PathBuf> = vec![
        config_dir.join(".claude.json"),
        config_dir.join(".config.json"),
    ];
    // Default config dir (~/.claude): the CLI keeps its config at ~/.claude.json,
    // a *sibling* of the config dir, not inside it.
    if let Some(parent) = config_dir.parent() {
        candidates.push(parent.join(".claude.json"));
    }

    for path in candidates {
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(account) = parsed.get("oauthAccount") else {
            continue;
        };
        let read = |keys: &[&str]| -> Option<String> {
            keys.iter()
                .filter_map(|key| account.get(key).and_then(|v| v.as_str()))
                .map(str::trim)
                .find(|s| !s.is_empty())
                .map(str::to_string)
        };
        return (
            read(&["emailAddress", "email"]),
            read(&["organizationUuid", "organizationId"]),
            read(&["organizationName"]),
        );
    }
    (None, None, None)
}

pub fn read_claude_auth_status() -> ClaudeAuthStatus {
    let credentials = read_claude_oauth_credentials();
    let authenticated = credentials.access_token.is_some();
    let (email, organization_uuid, organization_name) = match resolve_claude_config_dir() {
        Some(dir) if authenticated => read_claude_oauth_account_identity(&dir),
        _ => (None, None, None),
    };
    ClaudeAuthStatus {
        authenticated,
        method: authenticated.then(|| "subscription-oauth".to_string()),
        email,
        organization_uuid,
        organization_name,
        credential_source: credentials.source.to_string(),
        has_refreshable_credentials: credentials.has_refreshable_credentials,
        keychain_unavailable: credentials.keychain_unavailable,
        subscription_type: credentials.subscription_type,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pebble-agent-accounts-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fake_jwt(payload: serde_json::Value) -> String {
        let encode = |value: &serde_json::Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(value).unwrap())
        };
        format!(
            "{}.{}.signature",
            encode(&serde_json::json!({ "alg": "RS256" })),
            encode(&payload)
        )
    }

    #[test]
    fn codex_missing_auth_json_is_unauthenticated() {
        let home = temp_dir("codex-missing");
        let status = read_codex_auth_status_at(&home);
        assert!(!status.authenticated);
        assert_eq!(status.method, None);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn codex_oauth_auth_json_yields_identity() {
        let home = temp_dir("codex-oauth");
        let id_token = fake_jwt(serde_json::json!({
            "email": "dev@example.com",
            "https://api.openai.com/auth": {
                "chatgpt_plan_type": "pro",
                "chatgpt_account_id": "acct-123"
            }
        }));
        std::fs::write(
            home.join("auth.json"),
            serde_json::json!({
                "tokens": {
                    "access_token": "at-1",
                    "id_token": id_token,
                    "account_id": "acct-123"
                }
            })
            .to_string(),
        )
        .unwrap();

        let status = read_codex_auth_status_at(&home);
        assert!(status.authenticated);
        assert_eq!(status.method.as_deref(), Some("oauth"));
        assert_eq!(status.email.as_deref(), Some("dev@example.com"));
        assert_eq!(status.account_id.as_deref(), Some("acct-123"));
        assert_eq!(status.plan_type.as_deref(), Some("pro"));

        let (token, account_id) = read_codex_access_token(&home).unwrap();
        assert_eq!(token, "at-1");
        assert_eq!(account_id.as_deref(), Some("acct-123"));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn codex_api_key_auth_json_is_api_key_method() {
        let home = temp_dir("codex-api-key");
        std::fs::write(
            home.join("auth.json"),
            serde_json::json!({ "OPENAI_API_KEY": "sk-test" }).to_string(),
        )
        .unwrap();
        let status = read_codex_auth_status_at(&home);
        assert!(status.authenticated);
        assert_eq!(status.method.as_deref(), Some("api-key"));
        assert!(read_codex_access_token(&home).is_none());
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn claude_credentials_file_parses_oauth_blob() {
        let dir = temp_dir("claude-file");
        std::fs::write(
            dir.join(".credentials.json"),
            serde_json::json!({
                "claudeAiOauth": {
                    "accessToken": "ca-token",
                    "refreshToken": "cr-token",
                    "subscriptionType": "max"
                }
            })
            .to_string(),
        )
        .unwrap();
        let credentials = read_claude_credentials_file(&dir);
        assert_eq!(credentials.access_token.as_deref(), Some("ca-token"));
        assert!(credentials.has_refreshable_credentials);
        assert_eq!(credentials.source, "credentials-file");
        assert_eq!(credentials.subscription_type.as_deref(), Some("max"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn claude_credentials_file_without_token_is_empty() {
        let dir = temp_dir("claude-empty");
        std::fs::write(dir.join(".credentials.json"), "{}").unwrap();
        let credentials = read_claude_credentials_file(&dir);
        assert!(credentials.access_token.is_none());
        assert_eq!(credentials.source, "none");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn claude_identity_reads_oauth_account_from_config_json() {
        let dir = temp_dir("claude-identity");
        std::fs::write(
            dir.join(".claude.json"),
            serde_json::json!({
                "oauthAccount": {
                    "emailAddress": "claude-dev@example.com",
                    "organizationUuid": "org-uuid",
                    "organizationName": "Example Org"
                }
            })
            .to_string(),
        )
        .unwrap();
        let (email, org_uuid, org_name) = read_claude_oauth_account_identity(&dir);
        assert_eq!(email.as_deref(), Some("claude-dev@example.com"));
        assert_eq!(org_uuid.as_deref(), Some("org-uuid"));
        assert_eq!(org_name.as_deref(), Some("Example Org"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scoped_keychain_service_matches_electron_hashing() {
        // sha256("/Users/dev/.claude")[..8] must match keychain.ts's suffix.
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest("/Users/dev/.claude".as_bytes());
        let expected_suffix: String = digest[..4].iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            scoped_claude_keychain_service("/Users/dev/.claude"),
            format!("Claude Code-credentials-{expected_suffix}")
        );
    }
}
