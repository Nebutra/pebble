//! Native rate-limit usage fetchers for Claude and Codex.
//!
//! Claude usage comes from the Claude Code OAuth usage
//! endpoint using the CLI's own stored credentials; Codex usage comes from a
//! short-lived `codex app-server` JSON-RPC session plus the ChatGPT backend
//! reset-credit endpoints. Kimi reads its CLI-owned OAuth file without rotating
//! credentials. Gemini, MiniMax, and OpenCode still need native credential
//! extraction or persisted browser-session adapters.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::agent_accounts::{
    parse_claude_oauth_json, read_claude_oauth_credentials, read_codex_access_token,
    resolve_codex_home,
};
use super::managed_claude_accounts::{read_managed_claude_credentials, validate_wsl_owned_path};

#[path = "rate_limits_gemini.rs"]
pub mod rate_limits_gemini;
#[path = "rate_limits_minimax.rs"]
pub mod rate_limits_minimax;
#[path = "rate_limits_opencode.rs"]
pub mod rate_limits_opencode;

const CLAUDE_OAUTH_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA_HEADER: &str = "oauth-2025-04-20";
// Why: the OAuth usage endpoint is the Claude Code usage API; matching the CLI
// user-agent keeps Pebble aligned with that contract (see claude-fetcher.ts).
const CLAUDE_CODE_USER_AGENT: &str = "claude-code/2.1.0";
const CODEX_BACKEND_RESET_CREDITS_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
// Why: matches Electron's host RPC budget — codex app-server startup plus the
// rateLimits read can take several seconds cold.
const CODEX_RPC_TIMEOUT: Duration = Duration::from_secs(20);
const SESSION_WINDOW_MINUTES: u32 = 300;
const WEEKLY_WINDOW_MINUTES: u32 = 10_080;
const KIMI_DEFAULT_BASE_URL: &str = "https://api.kimi.com/coding/v1";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    pub used_percent: f64,
    pub window_minutes: u32,
    pub resets_at: Option<i64>,
    /// Always None from Rust: the TS bridge renders the locale-aware
    /// description from resetsAt so formatting matches the renderer's locale.
    pub reset_description: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitBucket {
    pub name: String,
    pub used_percent: f64,
    pub window_minutes: u32,
    pub resets_at: Option<i64>,
    pub reset_description: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitResetCredits {
    pub available_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_earned_count: Option<u64>,
    pub next_expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub attempted_sources: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_source: Option<String>,
}

/// Mirrors the renderer's `ProviderRateLimits` shape (packages/product-core/shared/rate-limit-types.ts).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRateLimits {
    pub provider: String,
    pub session: Option<RateLimitWindow>,
    pub weekly: Option<RateLimitWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fable_weekly: Option<RateLimitWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monthly: Option<RateLimitWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buckets: Option<Vec<RateLimitBucket>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limit_reset_credits: Option<RateLimitResetCredits>,
    pub updated_at: i64,
    pub error: Option<String>,
    /// 'ok' | 'error' | 'unavailable'.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_metadata: Option<UsageMetadata>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn failed_result(
    provider: &str,
    status: &str,
    error: String,
    failure_kind: &str,
    credential_source: Option<String>,
) -> ProviderRateLimits {
    ProviderRateLimits {
        provider: provider.to_string(),
        session: None,
        weekly: None,
        fable_weekly: None,
        monthly: None,
        buckets: None,
        rate_limit_reset_credits: None,
        updated_at: now_ms(),
        error: Some(error),
        status: status.to_string(),
        usage_metadata: Some(UsageMetadata {
            source: None,
            attempted_sources: vec!["oauth".to_string()],
            failure_kind: Some(failure_kind.to_string()),
            credential_source,
        }),
    }
}

fn kimi_result(status: &str, error: Option<String>) -> ProviderRateLimits {
    ProviderRateLimits {
        provider: "kimi".to_string(),
        session: None,
        weekly: None,
        fable_weekly: None,
        monthly: None,
        buckets: None,
        rate_limit_reset_credits: None,
        updated_at: now_ms(),
        error,
        status: status.to_string(),
        usage_metadata: None,
    }
}

fn kimi_credentials_path() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("KIMI_CODE_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(home)
            .join("credentials")
            .join("kimi-code.json"));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| "Could not resolve the home directory for Kimi credentials".to_string())?;
    Ok(PathBuf::from(home)
        .join(".kimi-code")
        .join("credentials")
        .join("kimi-code.json"))
}

fn number(value: Option<&serde_json::Value>) -> Option<f64> {
    value.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
            .filter(|number| number.is_finite())
    })
}

fn kimi_window_minutes(window: Option<&serde_json::Value>) -> Option<u32> {
    let window = window?;
    let duration = number(window.get("duration"))?;
    if duration < 0.0 {
        return None;
    }
    let unit = window
        .get("timeUnit")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_ascii_uppercase();
    let minutes = if unit.contains("SECOND") {
        duration / 60.0
    } else if unit.contains("HOUR") {
        duration * 60.0
    } else if unit.contains("DAY") {
        duration * 1_440.0
    } else {
        duration
    };
    Some(minutes.round().clamp(0.0, u32::MAX as f64) as u32)
}

fn map_kimi_window(
    detail: Option<&serde_json::Value>,
    window_minutes: u32,
) -> Option<RateLimitWindow> {
    let detail = detail?;
    let limit = number(detail.get("limit"))?;
    if limit <= 0.0 {
        return None;
    }
    let used = number(detail.get("used"))
        .or_else(|| number(detail.get("remaining")).map(|remaining| limit - remaining))?;
    let reset = detail.get("resetTime").or_else(|| detail.get("resetAt"));
    Some(RateLimitWindow {
        used_percent: ((used / limit) * 100.0).clamp(0.0, 100.0),
        window_minutes,
        resets_at: parse_reset_timestamp(reset),
        reset_description: None,
    })
}

pub fn map_kimi_usage_response(body: &serde_json::Value) -> ProviderRateLimits {
    let weekly = map_kimi_window(body.get("usage"), WEEKLY_WINDOW_MINUTES);
    let mut session: Option<RateLimitWindow> = None;
    if let Some(limits) = body.get("limits").and_then(|value| value.as_array()) {
        for limit in limits {
            let minutes =
                kimi_window_minutes(limit.get("window")).unwrap_or(SESSION_WINDOW_MINUTES);
            let Some(candidate) = map_kimi_window(limit.get("detail"), minutes) else {
                continue;
            };
            let candidate_distance = minutes.abs_diff(SESSION_WINDOW_MINUTES);
            let current_distance = session
                .as_ref()
                .map(|window| window.window_minutes.abs_diff(SESSION_WINDOW_MINUTES));
            if current_distance
                .map(|distance| candidate_distance < distance)
                .unwrap_or(true)
            {
                session = Some(candidate);
            }
        }
    }
    let has_usage = session.is_some() || weekly.is_some();
    ProviderRateLimits {
        provider: "kimi".to_string(),
        session,
        weekly,
        fable_weekly: None,
        monthly: None,
        buckets: None,
        rate_limit_reset_credits: None,
        updated_at: now_ms(),
        error: (!has_usage)
            .then(|| "Kimi usage response did not include quota windows".to_string()),
        status: if has_usage { "ok" } else { "error" }.to_string(),
        usage_metadata: None,
    }
}

#[tauri::command]
pub async fn rate_limits_fetch_kimi() -> ProviderRateLimits {
    let credentials_path = match kimi_credentials_path() {
        Ok(path) => path,
        Err(error) => return kimi_result("error", Some(error)),
    };
    let raw = match std::fs::read_to_string(&credentials_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return kimi_result(
                "unavailable",
                Some("Not signed in to Kimi Code".to_string()),
            )
        }
        Err(error) => return kimi_result("error", Some(error.to_string())),
    };
    let credentials: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => return kimi_result("error", Some(error.to_string())),
    };
    let Some(token) = credentials
        .get("access_token")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
    else {
        return kimi_result(
            "error",
            Some("Kimi credentials file is missing an access token".to_string()),
        );
    };
    let expires_at = credentials
        .get("expires_at")
        .and_then(|value| value.as_i64());
    let now_seconds = now_ms() / 1_000;
    if expires_at
        .map(|expiry| expiry - now_seconds <= 5)
        .unwrap_or(true)
    {
        // The Kimi CLI owns refresh-token rotation; Pebble must stay read-only.
        return kimi_result(
            "error",
            Some("Kimi token expired — open Kimi to refresh".to_string()),
        );
    }
    let base_url =
        std::env::var("KIMI_CODE_BASE_URL").unwrap_or_else(|_| KIMI_DEFAULT_BASE_URL.to_string());
    let client = match reqwest::Client::builder().timeout(HTTP_TIMEOUT).build() {
        Ok(client) => client,
        Err(error) => return kimi_result("error", Some(error.to_string())),
    };
    let response = client
        .get(format!("{}/usages", base_url.trim_end_matches('/')))
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => match response.json().await {
            Ok(body) => map_kimi_usage_response(&body),
            Err(error) => kimi_result("error", Some(error.to_string())),
        },
        Ok(response) => kimi_result(
            "error",
            Some(format!(
                "Kimi usage request failed (HTTP {})",
                response.status().as_u16()
            )),
        ),
        Err(error) => kimi_result("error", Some(error.to_string())),
    }
}

// ---------------------------------------------------------------------------
// Claude — OAuth usage endpoint
// ---------------------------------------------------------------------------

/// Parse the endpoint's `resets_at`, which may be Unix seconds, Unix ms, or an
/// ISO timestamp string. The 10^10 threshold splits seconds from ms.
fn parse_reset_timestamp(value: Option<&serde_json::Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_f64() {
        if !number.is_finite() {
            return None;
        }
        return Some(if number > 10_000_000_000.0 {
            number as i64
        } else {
            (number * 1000.0) as i64
        });
    }
    let raw = value.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(number) = raw.parse::<f64>() {
        if number.is_finite() {
            return Some(if number > 10_000_000_000.0 {
                number as i64
            } else {
                (number * 1000.0) as i64
            });
        }
    }
    chrono_free_parse_iso_ms(raw)
}

/// Minimal RFC3339 → Unix ms parser so we do not pull a datetime crate for one
/// field. Accepts `YYYY-MM-DDTHH:MM:SS(.fff)?(Z|±HH:MM)`.
fn chrono_free_parse_iso_ms(raw: &str) -> Option<i64> {
    let bytes = raw.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[13] != b':' {
        return None;
    }
    let year: i64 = raw.get(0..4)?.parse().ok()?;
    let month: i64 = raw.get(5..7)?.parse().ok()?;
    let day: i64 = raw.get(8..10)?.parse().ok()?;
    let hour: i64 = raw.get(11..13)?.parse().ok()?;
    let minute: i64 = raw.get(14..16)?.parse().ok()?;
    let second: i64 = raw.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let rest = raw.get(19..)?;
    let (millis, tz) = if let Some(stripped) = rest.strip_prefix('.') {
        let digits: String = stripped
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let tz_part = &stripped[digits.len()..];
        let ms: i64 = format!("{:0<3}", digits.chars().take(3).collect::<String>())
            .parse()
            .ok()?;
        (ms, tz_part.to_string())
    } else {
        (0, rest.to_string())
    };
    let offset_minutes: i64 = if tz == "Z" || tz == "z" {
        0
    } else if (tz.starts_with('+') || tz.starts_with('-')) && tz.len() == 6 {
        let sign = if tz.starts_with('-') { -1 } else { 1 };
        let hours: i64 = tz.get(1..3)?.parse().ok()?;
        let minutes: i64 = tz.get(4..6)?.parse().ok()?;
        sign * (hours * 60 + minutes)
    } else {
        return None;
    };

    // Days-from-civil (Howard Hinnant's algorithm) keeps this exact for all
    // Gregorian dates without a calendar dependency.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1000 + millis)
}

fn map_usage_window(
    window: Option<&serde_json::Value>,
    window_minutes: u32,
) -> Option<RateLimitWindow> {
    let window = window?;
    let used_percent = window
        .get("utilization")
        .and_then(|v| v.as_f64())
        .or_else(|| window.get("used_percentage").and_then(|v| v.as_f64()))?;
    Some(RateLimitWindow {
        used_percent: used_percent.clamp(0.0, 100.0),
        window_minutes,
        resets_at: parse_reset_timestamp(window.get("resets_at")),
        reset_description: None,
    })
}

/// Map the OAuth usage response body into provider windows. Split out from the
/// network call so it is unit-testable against fixture JSON.
pub fn map_claude_usage_response(
    body: &serde_json::Value,
    credential_source: &str,
) -> ProviderRateLimits {
    // Why: a bare "fable" field does not prove the window length — only accept
    // explicit weekly/seven-day names for the distinct Fable meter.
    let fable_weekly = map_usage_window(body.get("fable_weekly"), WEEKLY_WINDOW_MINUTES)
        .or_else(|| map_usage_window(body.get("fable_seven_day"), WEEKLY_WINDOW_MINUTES))
        .or_else(|| map_usage_window(body.get("seven_day_fable"), WEEKLY_WINDOW_MINUTES));
    ProviderRateLimits {
        provider: "claude".to_string(),
        session: map_usage_window(body.get("five_hour"), SESSION_WINDOW_MINUTES),
        weekly: map_usage_window(body.get("seven_day"), WEEKLY_WINDOW_MINUTES),
        fable_weekly,
        monthly: None,
        buckets: None,
        rate_limit_reset_credits: None,
        updated_at: now_ms(),
        error: None,
        status: "ok".to_string(),
        usage_metadata: Some(UsageMetadata {
            source: Some("oauth".to_string()),
            attempted_sources: vec!["oauth".to_string()],
            failure_kind: None,
            credential_source: Some(credential_source.to_string()),
        }),
    }
}

fn classify_http_failure(status: u16) -> &'static str {
    match status {
        401 | 403 => "stale-token",
        429 => "rate-limited",
        500..=599 => "server",
        _ => "server",
    }
}

async fn fetch_claude_usage_with_token(
    token: String,
    credential_source: String,
) -> ProviderRateLimits {
    let client = match reqwest::Client::builder().timeout(HTTP_TIMEOUT).build() {
        Ok(client) => client,
        Err(err) => {
            return failed_result(
                "claude",
                "error",
                format!("Could not build HTTP client: {err}"),
                "unknown",
                Some(credential_source),
            )
        }
    };
    let response = client
        .get(CLAUDE_OAUTH_USAGE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", CLAUDE_OAUTH_BETA_HEADER)
        .header("User-Agent", CLAUDE_CODE_USER_AGENT)
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => match response.json().await {
            Ok(body) => map_claude_usage_response(&body, &credential_source),
            Err(err) => failed_result(
                "claude",
                "error",
                format!("Could not parse Claude usage response: {err}"),
                "parse",
                Some(credential_source),
            ),
        },
        Ok(response) => {
            let status = response.status().as_u16();
            failed_result(
                "claude",
                "error",
                format!("Claude usage endpoint returned HTTP {status}"),
                classify_http_failure(status),
                Some(credential_source),
            )
        }
        Err(err) => failed_result(
            "claude",
            "error",
            format!("Claude usage request failed: {err}"),
            "network",
            Some(credential_source),
        ),
    }
}

/// Fetch Claude subscription usage with the CLI's own stored OAuth credential.
/// Read-only against the credential store; never refreshes or rewrites it.
#[tauri::command]
pub async fn rate_limits_fetch_claude() -> ProviderRateLimits {
    let credentials =
        match tauri::async_runtime::spawn_blocking(read_claude_oauth_credentials).await {
            Ok(credentials) => credentials,
            Err(_) => {
                return failed_result(
                    "claude",
                    "error",
                    "Claude credential probe failed".to_string(),
                    "unknown",
                    None,
                )
            }
        };

    let Some(token) = credentials.access_token.clone() else {
        let (kind, message) = if credentials.keychain_unavailable {
            (
                "keychain-unavailable",
                "Could not read the macOS Keychain for Claude credentials",
            )
        } else if credentials.has_refreshable_credentials {
            // Why: a refresh token without an access token means the CLI owns
            // rotation; Pebble must not race it by refreshing natively.
            (
                "refreshable-credentials-without-token",
                "Claude credentials need the Claude CLI to refresh them",
            )
        } else {
            ("missing-credentials", "Claude is not signed in")
        };
        return failed_result(
            "claude",
            if kind == "missing-credentials" {
                "unavailable"
            } else {
                "error"
            },
            message.to_string(),
            kind,
            Some(credentials.source.to_string()),
        );
    };

    fetch_claude_usage_with_token(token, credentials.source.to_string()).await
}

#[tauri::command]
pub async fn rate_limits_fetch_claude_managed(account_id: String) -> ProviderRateLimits {
    let credentials = match tauri::async_runtime::spawn_blocking(move || {
        read_managed_claude_credentials(&account_id)
    })
    .await
    {
        Ok(Ok(credentials)) => credentials,
        Ok(Err(error)) => {
            return failed_result(
                "claude",
                "unavailable",
                error,
                "missing-credentials",
                Some("managed-keyring".to_string()),
            )
        }
        Err(_) => {
            return failed_result(
                "claude",
                "error",
                "Managed Claude credential probe failed".to_string(),
                "unknown",
                Some("managed-keyring".to_string()),
            )
        }
    };
    let parsed = parse_claude_oauth_json(&credentials, "managed-keyring");
    let Some(token) = parsed.access_token else {
        return failed_result(
            "claude",
            "unavailable",
            "Managed Claude credentials do not contain an access token".to_string(),
            if parsed.has_refreshable_credentials {
                "refreshable-credentials-without-token"
            } else {
                "missing-credentials"
            },
            Some("managed-keyring".to_string()),
        );
    };
    fetch_claude_usage_with_token(token, "managed-keyring".to_string()).await
}

const WSL_CLAUDE_CREDENTIAL_SCRIPT: &str =
    "cat \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json\" 2>/dev/null";

fn wsl_claude_credential_args(distro: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(distro) = distro.filter(|value| !value.trim().is_empty()) {
        args.extend(["-d".to_string(), distro.to_string()]);
    }
    args.extend(
        ["--", "sh", "-lc", WSL_CLAUDE_CREDENTIAL_SCRIPT]
            .into_iter()
            .map(str::to_string),
    );
    args
}

fn parse_wsl_claude_credentials(raw: &str) -> Result<(String, bool), String> {
    let parsed: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| "Claude credentials in WSL are not valid JSON".to_string())?;
    let oauth = parsed.get("claudeAiOauth");
    let token = oauth
        .and_then(|value| value.get("accessToken"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let refreshable = oauth
        .and_then(|value| value.get("refreshToken"))
        .and_then(|value| value.as_str())
        .is_some_and(|value| !value.trim().is_empty());
    token.map(|token| (token, refreshable)).ok_or_else(|| {
        if refreshable {
            "Claude credentials in WSL need the Claude CLI to refresh them".to_string()
        } else {
            "Claude is not signed in inside the selected WSL distribution".to_string()
        }
    })
}

fn read_wsl_claude_credentials(
    wsl_distro: Option<&str>,
    managed_auth_path: Option<&str>,
) -> Result<String, String> {
    if !cfg!(target_os = "windows") {
        return Err("WSL Claude usage is only available on Windows".to_string());
    }
    let mut args = wsl_claude_credential_args(wsl_distro);
    if let Some(path) = managed_auth_path.filter(|path| path.starts_with('/')) {
        let script = format!(
            "CLAUDE_CONFIG_DIR='{}' {}",
            path.replace('\'', "'\\''"),
            WSL_CLAUDE_CREDENTIAL_SCRIPT
        );
        if let Some(last) = args.last_mut() {
            *last = script;
        }
    }
    let output = Command::new("wsl.exe")
        .args(args)
        .output()
        .map_err(|error| format!("Could not start WSL for Claude credentials: {error}"))?;
    if !output.status.success() {
        return Err(
            "Claude credential file was not found inside the selected WSL distribution".to_string(),
        );
    }
    let raw = String::from_utf8(output.stdout)
        .map_err(|_| "Claude credentials in WSL are not UTF-8".to_string())?;
    parse_wsl_claude_credentials(&raw).map(|(token, _)| token)
}

#[tauri::command]
pub async fn rate_limits_fetch_claude_wsl(
    wsl_distro: Option<String>,
    account_id: Option<String>,
    managed_auth_path: Option<String>,
) -> ProviderRateLimits {
    let distro_for_source = wsl_distro.clone().unwrap_or_else(|| "default".to_string());
    if let (Some(account_id), Some(distro), Some(path)) = (
        account_id.as_deref(),
        wsl_distro.as_deref(),
        managed_auth_path.as_deref(),
    ) {
        if let Err(error) = validate_wsl_owned_path(account_id, distro, path) {
            return failed_result(
                "claude",
                "unavailable",
                error,
                "missing-credentials",
                Some(format!("wsl:{distro_for_source}")),
            );
        }
    }
    let token = match tauri::async_runtime::spawn_blocking(move || {
        read_wsl_claude_credentials(wsl_distro.as_deref(), managed_auth_path.as_deref())
    })
    .await
    {
        Ok(Ok(token)) => token,
        Ok(Err(error)) => {
            return failed_result(
                "claude",
                "unavailable",
                error,
                "missing-credentials",
                Some(format!("wsl:{distro_for_source}")),
            )
        }
        Err(_) => {
            return failed_result(
                "claude",
                "error",
                "WSL Claude credential probe failed".to_string(),
                "unknown",
                Some(format!("wsl:{distro_for_source}")),
            )
        }
    };
    fetch_claude_usage_with_token(token, format!("wsl:{distro_for_source}")).await
}

// ---------------------------------------------------------------------------
// Codex — `codex app-server` JSON-RPC + ChatGPT backend reset credits
// ---------------------------------------------------------------------------

fn codex_rpc_window(
    window: Option<&serde_json::Value>,
    window_minutes: u32,
) -> Option<RateLimitWindow> {
    let window = window?;
    let used_percent = window.get("usedPercent")?.as_f64()?;
    // Why: Codex returns resetsAt as Unix seconds, not milliseconds.
    let resets_at = window
        .get("resetsAt")
        .and_then(|v| v.as_i64())
        .map(|seconds| seconds * 1000);
    Some(RateLimitWindow {
        used_percent: used_percent.clamp(0.0, 100.0),
        window_minutes,
        resets_at,
        reset_description: None,
    })
}

fn map_reset_credits(value: Option<&serde_json::Value>) -> Option<RateLimitResetCredits> {
    let value = value?;
    let available_count = value.get("availableCount")?.as_u64()?;
    Some(RateLimitResetCredits {
        available_count,
        total_earned_count: value.get("totalEarnedCount").and_then(|v| v.as_u64()),
        next_expires_at: value.get("nextExpiresAt").and_then(|v| v.as_i64()),
    })
}

/// Map the `account/rateLimits/read` RPC result into provider windows.
pub fn map_codex_rpc_result(result: &serde_json::Value) -> ProviderRateLimits {
    let rate_limits = result.get("rateLimits");
    ProviderRateLimits {
        provider: "codex".to_string(),
        session: codex_rpc_window(
            rate_limits.and_then(|r| r.get("primary")),
            SESSION_WINDOW_MINUTES,
        ),
        weekly: codex_rpc_window(
            rate_limits.and_then(|r| r.get("secondary")),
            WEEKLY_WINDOW_MINUTES,
        ),
        fable_weekly: None,
        monthly: None,
        buckets: None,
        rate_limit_reset_credits: map_reset_credits(result.get("rateLimitResetCredits")),
        updated_at: now_ms(),
        error: None,
        status: "ok".to_string(),
        usage_metadata: Some(UsageMetadata {
            source: Some("cli".to_string()),
            attempted_sources: vec!["cli".to_string()],
            failure_kind: None,
            credential_source: Some("auth-json".to_string()),
        }),
    }
}

fn kill_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn codex_failed(status: &str, error: String, failure_kind: &str) -> ProviderRateLimits {
    let mut result = failed_result("codex", status, error, failure_kind, None);
    if let Some(meta) = result.usage_metadata.as_mut() {
        meta.attempted_sources = vec!["cli".to_string()];
    }
    result
}

/// Run one `codex app-server` JSON-RPC exchange and read the account rate
/// limits. Blocking; must run on the blocking pool.
fn codex_app_server_command(
    wsl_distro: Option<Option<&str>>,
    managed_home: Option<&PathBuf>,
) -> Result<Command, ProviderRateLimits> {
    if let Some(distro) = wsl_distro {
        if !cfg!(target_os = "windows") {
            return Err(codex_failed(
                "unavailable",
                "WSL Codex usage is only available on Windows".to_string(),
                "runtime-unavailable",
            ));
        }
        let mut command = Command::new("wsl.exe");
        command.args(wsl_codex_app_server_args(
            distro,
            managed_home.and_then(|path| path.to_str()),
        ));
        return Ok(command);
    }
    let Some(codex_command) = super::preflight::resolve_command_path("codex") else {
        return Err(codex_failed(
            "unavailable",
            "Codex CLI not found".to_string(),
            "cli-unavailable",
        ));
    };
    let mut command = Command::new(codex_command);
    command.args(["-s", "read-only", "-a", "untrusted", "app-server"]);
    Ok(command)
}

fn wsl_codex_app_server_args(distro: Option<&str>, managed_home: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(distro) = distro.filter(|value| !value.trim().is_empty()) {
        args.extend(["-d".to_string(), distro.to_string()]);
    }
    args.push("--".to_string());
    if let Some(home) = managed_home.filter(|value| value.starts_with('/')) {
        args.extend(["env".to_string(), format!("CODEX_HOME={home}")]);
    }
    args.extend(
        ["codex", "-s", "read-only", "-a", "untrusted", "app-server"]
            .into_iter()
            .map(str::to_string),
    );
    args
}

fn fetch_codex_rate_limits_blocking_for_target(
    wsl_distro: Option<Option<String>>,
    managed_home: Option<PathBuf>,
) -> ProviderRateLimits {
    // Why: read-only, untrusted approval mode — this hidden background fetch
    // must never be able to execute workspace commands (mirrors codex-fetcher.ts).
    let mut command = match codex_app_server_command(
        wsl_distro.as_ref().map(|value| value.as_deref()),
        managed_home.as_ref(),
    ) {
        Ok(command) => command,
        Err(result) => return result,
    };
    if let Some(home) = managed_home.as_ref() {
        command.env("CODEX_HOME", home);
    }
    let mut child = match command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            return codex_failed(
                "error",
                format!("Could not start codex app-server: {err}"),
                "cli-unavailable",
            )
        }
    };

    let Some(mut stdin) = child.stdin.take() else {
        kill_child(&mut child);
        return codex_failed(
            "error",
            "codex app-server stdin unavailable".to_string(),
            "unknown",
        );
    };
    let Some(stdout) = child.stdout.take() else {
        kill_child(&mut child);
        return codex_failed(
            "error",
            "codex app-server stdout unavailable".to_string(),
            "unknown",
        );
    };

    // Reader thread + channel so the RPC deadline also bounds blocked reads;
    // killing the child on timeout EOFs the reader.
    let (line_tx, line_rx) = mpsc::channel::<String>();
    let reader_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if line_tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // JSON-RPC/LSP handshake: initialize request → initialized notification →
    // account/rateLimits/read. Skipping the notification yields "Not initialized".
    let write_result = stdin.write_all(
        format!(
            "{}\n",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "clientInfo": { "name": "pebble", "version": "1.0.0" } }
            })
        )
        .as_bytes(),
    );
    if write_result.is_err() {
        kill_child(&mut child);
        let _ = reader_handle.join();
        return codex_failed(
            "error",
            "Could not write to codex app-server".to_string(),
            "unknown",
        );
    }

    let deadline = std::time::Instant::now() + CODEX_RPC_TIMEOUT;
    let mut sent_rate_limits_request = false;
    let outcome = loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break codex_failed("error", "Codex RPC timeout".to_string(), "unknown");
        }
        let line = match line_rx.recv_timeout(remaining) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                break codex_failed("error", "Codex RPC timeout".to_string(), "unknown");
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break codex_failed(
                    "error",
                    "codex app-server exited before responding".to_string(),
                    "unknown",
                );
            }
        };
        let Ok(message) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue; // Non-JSON output line — ignore.
        };
        let id = message.get("id").and_then(|v| v.as_i64());
        match id {
            Some(1) if !sent_rate_limits_request => {
                sent_rate_limits_request = true;
                let initialized = format!(
                    "{}\n",
                    serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} })
                );
                let request = format!(
                    "{}\n",
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "account/rateLimits/read",
                        "params": {}
                    })
                );
                if stdin.write_all(initialized.as_bytes()).is_err()
                    || stdin.write_all(request.as_bytes()).is_err()
                {
                    break codex_failed(
                        "error",
                        "Could not write to codex app-server".to_string(),
                        "unknown",
                    );
                }
            }
            Some(2) => {
                if let Some(error) = message.get("error") {
                    let detail = error
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Codex RPC error");
                    break codex_failed("error", detail.to_string(), "unknown");
                }
                let result = message
                    .get("result")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                break map_codex_rpc_result(&result);
            }
            _ => continue, // Server notifications and unrelated ids.
        }
    };

    kill_child(&mut child);
    drop(line_rx);
    let _ = reader_handle.join();
    outcome
}

async fn codex_backend_reset_credits(
    managed_home: Option<PathBuf>,
) -> Option<RateLimitResetCredits> {
    let (token, account_id) = tauri::async_runtime::spawn_blocking(move || {
        managed_home
            .or_else(resolve_codex_home)
            .as_deref()
            .and_then(read_codex_access_token)
    })
    .await
    .ok()??;
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .ok()?;
    let mut request = client
        .get(CODEX_BACKEND_RESET_CREDITS_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "codex-cli")
        .header("OpenAI-Beta", "codex-1")
        .header("originator", "Codex Desktop");
    if let Some(account_id) = account_id {
        request = request.header("ChatGPT-Account-Id", account_id);
    }
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: serde_json::Value = response.json().await.ok()?;
    map_backend_reset_credits(&body)
}

/// Map the ChatGPT backend reset-credits payload (snake_case) into the
/// renderer shape. Split out for unit tests.
pub fn map_backend_reset_credits(body: &serde_json::Value) -> Option<RateLimitResetCredits> {
    let credits = body.get("credits").and_then(|v| v.as_array());
    let available_count = body
        .get("available_count")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            credits.map(|credits| {
                credits
                    .iter()
                    .filter(|credit| {
                        credit.get("status").and_then(|v| v.as_str()) == Some("available")
                    })
                    .count() as u64
            })
        })?;
    let next_expires_at = credits.and_then(|credits| {
        credits
            .iter()
            .filter(|credit| credit.get("status").and_then(|v| v.as_str()) == Some("available"))
            .filter_map(|credit| {
                parse_reset_timestamp(credit.get("expires_at").or_else(|| credit.get("expiresAt")))
            })
            .min()
    });
    Some(RateLimitResetCredits {
        available_count,
        total_earned_count: body.get("total_earned_count").and_then(|v| v.as_u64()),
        next_expires_at,
    })
}

/// Fetch Codex usage through the CLI's app-server RPC; enrich with backend
/// reset-credit metadata when the RPC result omits it.
#[tauri::command]
pub async fn rate_limits_fetch_codex(managed_home_path: Option<String>) -> ProviderRateLimits {
    let managed_home = managed_home_path
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let fetch_home = managed_home.clone();
    let mut result = tauri::async_runtime::spawn_blocking(move || {
        fetch_codex_rate_limits_blocking_for_target(None, fetch_home)
    })
    .await
    .unwrap_or_else(|_| codex_failed("error", "Codex fetch task failed".to_string(), "unknown"));
    // Why: published Codex CLIs can read windows through app-server but strip
    // reset-credit metadata that the backend already returns.
    let needs_credits = result.status == "ok"
        && result
            .rate_limit_reset_credits
            .as_ref()
            .map(|credits| credits.next_expires_at.is_none())
            .unwrap_or(true);
    if needs_credits {
        if let Some(credits) = codex_backend_reset_credits(managed_home).await {
            result.rate_limit_reset_credits = Some(credits);
        }
    }
    result
}

#[tauri::command]
pub async fn rate_limits_fetch_codex_wsl(
    wsl_distro: Option<String>,
    managed_home_path: Option<String>,
) -> ProviderRateLimits {
    // Why: credentials and CLI state belong to the selected distro, so the
    // app-server must execute inside WSL instead of borrowing host auth files.
    let managed_home = managed_home_path
        .filter(|value| value.starts_with('/'))
        .map(PathBuf::from);
    tauri::async_runtime::spawn_blocking(move || {
        fetch_codex_rate_limits_blocking_for_target(Some(wsl_distro), managed_home)
    })
    .await
    .unwrap_or_else(|_| {
        codex_failed(
            "error",
            "WSL Codex fetch task failed".to_string(),
            "unknown",
        )
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexResetCreditOutcome {
    /// 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'.
    pub outcome: String,
}

pub fn map_consume_outcome(code: Option<&str>) -> Result<String, String> {
    match code {
        Some("reset") => Ok("reset".to_string()),
        Some("nothing_to_reset") => Ok("nothingToReset".to_string()),
        Some("no_credit") => Ok("noCredit".to_string()),
        Some("already_redeemed") => Ok("alreadyRedeemed".to_string()),
        other => Err(format!(
            "Unknown Codex reset outcome: {}",
            other.unwrap_or("missing")
        )),
    }
}

const WSL_CODEX_AUTH_SCRIPT: &str = "cat \"${CODEX_HOME:-$HOME/.codex}/auth.json\" 2>/dev/null";

fn wsl_codex_auth_args(distro: Option<&str>, managed_home: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(distro) = distro.filter(|value| !value.trim().is_empty()) {
        args.extend(["-d".to_string(), distro.to_string()]);
    }
    args.push("--".to_string());
    if let Some(home) = managed_home.filter(|value| value.starts_with('/')) {
        args.extend(["env".to_string(), format!("CODEX_HOME={home}")]);
    }
    args.extend(
        ["sh", "-lc", WSL_CODEX_AUTH_SCRIPT]
            .into_iter()
            .map(str::to_string),
    );
    args
}

fn parse_codex_auth_json(raw: &str) -> Result<(String, Option<String>), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "Codex auth in WSL is not valid JSON".to_string())?;
    let tokens = parsed
        .get("tokens")
        .ok_or_else(|| "Codex is not signed in inside the selected WSL distribution".to_string())?;
    let token = tokens
        .get("access_token")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Codex is not signed in inside the selected WSL distribution".to_string())?;
    let account_id = tokens
        .get("account_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    Ok((token, account_id))
}

fn read_wsl_codex_auth(
    wsl_distro: Option<&str>,
    managed_home: Option<&str>,
) -> Result<(String, Option<String>), String> {
    if !cfg!(target_os = "windows") {
        return Err("WSL Codex reset credits are only available on Windows".to_string());
    }
    let output = Command::new("wsl.exe")
        .args(wsl_codex_auth_args(wsl_distro, managed_home))
        .output()
        .map_err(|error| format!("Could not start WSL for Codex credentials: {error}"))?;
    if !output.status.success() {
        return Err(
            "Codex auth file was not found inside the selected WSL distribution".to_string(),
        );
    }
    let raw = String::from_utf8(output.stdout)
        .map_err(|_| "Codex auth in WSL is not UTF-8".to_string())?;
    parse_codex_auth_json(&raw)
}

async fn consume_codex_reset_credit_with_auth(
    idempotency_key: String,
    auth: (String, Option<String>),
) -> Result<CodexResetCreditOutcome, String> {
    let (token, account_id) = auth;
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|err| format!("Could not build HTTP client: {err}"))?;
    let mut request = client
        .post(format!("{CODEX_BACKEND_RESET_CREDITS_URL}/consume"))
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "codex-cli")
        .header("OpenAI-Beta", "codex-1")
        .header("originator", "Codex Desktop")
        .json(&serde_json::json!({ "redeem_request_id": idempotency_key }));
    if let Some(account_id) = account_id {
        request = request.header("ChatGPT-Account-Id", account_id);
    }
    let response = request
        .send()
        .await
        .map_err(|err| format!("Codex reset failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Codex reset failed: HTTP {}",
            response.status().as_u16()
        ));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|err| format!("Codex reset response unreadable: {err}"))?;
    map_consume_outcome(body.get("code").and_then(|value| value.as_str()))
        .map(|outcome| CodexResetCreditOutcome { outcome })
}

/// Redeem one earned Codex rate-limit reset credit. Idempotent server-side via
/// the caller-provided redeem_request_id.
#[tauri::command]
pub async fn rate_limits_consume_codex_reset_credit(
    idempotency_key: String,
    managed_home_path: Option<String>,
) -> Result<CodexResetCreditOutcome, String> {
    if idempotency_key.trim().is_empty() {
        return Err("Codex reset idempotency key is required".to_string());
    }
    let managed_home = managed_home_path
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let auth = tauri::async_runtime::spawn_blocking(move || {
        managed_home
            .or_else(resolve_codex_home)
            .as_deref()
            .and_then(read_codex_access_token)
    })
    .await
    .map_err(|_| "Codex credential probe failed".to_string())?;
    let Some((token, account_id)) = auth else {
        return Err("Codex not signed in".to_string());
    };

    consume_codex_reset_credit_with_auth(idempotency_key, (token, account_id)).await
}

#[tauri::command]
pub async fn rate_limits_consume_codex_reset_credit_wsl(
    idempotency_key: String,
    wsl_distro: Option<String>,
    managed_home_path: Option<String>,
) -> Result<CodexResetCreditOutcome, String> {
    if idempotency_key.trim().is_empty() {
        return Err("Codex reset idempotency key is required".to_string());
    }
    let auth = tauri::async_runtime::spawn_blocking(move || {
        read_wsl_codex_auth(wsl_distro.as_deref(), managed_home_path.as_deref())
    })
    .await
    .map_err(|_| "WSL Codex credential probe failed".to_string())??;
    consume_codex_reset_credit_with_auth(idempotency_key, auth).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_wsl_codex_app_server_argv_without_shell_interpolation() {
        assert_eq!(
            wsl_codex_app_server_args(Some("Ubuntu 24.04"), None),
            vec![
                "-d",
                "Ubuntu 24.04",
                "--",
                "codex",
                "-s",
                "read-only",
                "-a",
                "untrusted",
                "app-server"
            ]
        );
        assert_eq!(
            wsl_codex_app_server_args(None, None)
                .first()
                .map(String::as_str),
            Some("--")
        );
    }

    #[test]
    fn routes_wsl_codex_reads_through_the_selected_managed_home() {
        let home = "/home/dev/.local/share/pebble/codex-accounts/account-1/home";
        assert_eq!(
            wsl_codex_app_server_args(Some("Ubuntu"), Some(home)),
            vec![
                "-d".to_string(),
                "Ubuntu".to_string(),
                "--".to_string(),
                "env".to_string(),
                format!("CODEX_HOME={home}"),
                "codex".to_string(),
                "-s".to_string(),
                "read-only".to_string(),
                "-a".to_string(),
                "untrusted".to_string(),
                "app-server".to_string()
            ]
        );
        assert_eq!(
            wsl_codex_auth_args(Some("Ubuntu"), Some(home))[3..6],
            [
                "env".to_string(),
                format!("CODEX_HOME={home}"),
                "sh".to_string()
            ]
        );
    }

    #[test]
    fn builds_wsl_claude_credential_argv_without_distro_interpolation() {
        assert_eq!(
            wsl_claude_credential_args(Some("Ubuntu 24.04")),
            vec![
                "-d",
                "Ubuntu 24.04",
                "--",
                "sh",
                "-lc",
                WSL_CLAUDE_CREDENTIAL_SCRIPT
            ]
        );
    }

    #[test]
    fn parses_wsl_claude_oauth_credentials_without_exposing_refresh_token() {
        let raw = serde_json::json!({
            "claudeAiOauth": { "accessToken": "claude-token", "refreshToken": "refresh" }
        })
        .to_string();
        assert_eq!(
            parse_wsl_claude_credentials(&raw),
            Ok(("claude-token".to_string(), true))
        );
        assert!(parse_wsl_claude_credentials("{}").is_err());
    }

    #[test]
    fn builds_and_parses_wsl_codex_auth_without_shell_interpolation() {
        assert_eq!(
            wsl_codex_auth_args(Some("Ubuntu 24.04"), None),
            vec![
                "-d",
                "Ubuntu 24.04",
                "--",
                "sh",
                "-lc",
                WSL_CODEX_AUTH_SCRIPT
            ]
        );
        let raw = serde_json::json!({
            "tokens": { "access_token": "codex-token", "account_id": "acct-1" }
        })
        .to_string();
        assert_eq!(
            parse_codex_auth_json(&raw),
            Ok(("codex-token".to_string(), Some("acct-1".to_string())))
        );
    }

    #[test]
    fn maps_claude_usage_windows_and_fable_meter() {
        let body = serde_json::json!({
            "five_hour": { "utilization": 42.5, "resets_at": 1760000000 },
            "seven_day": { "used_percentage": 150, "resets_at": "1760000000000" },
            "fable_weekly": { "utilization": 7 }
        });
        let result = map_claude_usage_response(&body, "keychain");
        assert_eq!(result.status, "ok");
        let session = result.session.unwrap();
        assert_eq!(session.used_percent, 42.5);
        assert_eq!(session.window_minutes, 300);
        assert_eq!(session.resets_at, Some(1_760_000_000_000));
        let weekly = result.weekly.unwrap();
        assert_eq!(weekly.used_percent, 100.0); // clamped
        assert_eq!(weekly.resets_at, Some(1_760_000_000_000));
        assert_eq!(result.fable_weekly.unwrap().window_minutes, 10_080);
        assert_eq!(
            result.usage_metadata.unwrap().credential_source.as_deref(),
            Some("keychain")
        );
    }

    #[test]
    fn maps_kimi_usage_and_prefers_the_window_nearest_five_hours() {
        let body = serde_json::json!({
            "usage": { "limit": "1000", "remaining": "750", "resetTime": "2026-06-09T07:52:41Z" },
            "limits": [
                {
                    "window": { "duration": 24, "timeUnit": "TIME_UNIT_HOUR" },
                    "detail": { "limit": 200, "used": 100 }
                },
                {
                    "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
                    "detail": { "limit": "100", "remaining": "40", "resetAt": 1760000000 }
                }
            ]
        });
        let result = map_kimi_usage_response(&body);
        assert_eq!(result.status, "ok");
        let session = result.session.unwrap();
        assert_eq!(session.window_minutes, 300);
        assert_eq!(session.used_percent, 60.0);
        assert_eq!(session.resets_at, Some(1_760_000_000_000));
        let weekly = result.weekly.unwrap();
        assert_eq!(weekly.window_minutes, 10_080);
        assert_eq!(weekly.used_percent, 25.0);
    }

    #[test]
    fn rejects_empty_kimi_usage_payloads() {
        let result = map_kimi_usage_response(&serde_json::json!({}));
        assert_eq!(result.status, "error");
        assert!(result.session.is_none());
        assert!(result.weekly.is_none());
    }

    #[test]
    fn claude_windows_missing_usage_fields_map_to_none() {
        let body = serde_json::json!({ "five_hour": { "resets_at": 123 } });
        let result = map_claude_usage_response(&body, "credentials-file");
        assert!(result.session.is_none());
        assert!(result.weekly.is_none());
        assert!(result.fable_weekly.is_none());
    }

    #[test]
    fn parses_iso_reset_timestamps() {
        let value = serde_json::json!("2026-01-02T03:04:05Z");
        // 2026-01-02T03:04:05Z == 1767323045 seconds.
        assert_eq!(parse_reset_timestamp(Some(&value)), Some(1_767_323_045_000));
        let with_offset = serde_json::json!("2026-01-02T03:04:05.250+01:00");
        assert_eq!(
            parse_reset_timestamp(Some(&with_offset)),
            Some(1_767_319_445_250)
        );
        assert_eq!(
            parse_reset_timestamp(Some(&serde_json::json!("nonsense"))),
            None
        );
    }

    #[test]
    fn maps_codex_rpc_result_windows_and_credits() {
        let result = serde_json::json!({
            "rateLimits": {
                "primary": { "usedPercent": 12.0, "resetsAt": 1760000000, "windowDurationMins": 34 },
                "secondary": { "usedPercent": 88.0 }
            },
            "rateLimitResetCredits": { "availableCount": 2, "totalEarnedCount": 5, "nextExpiresAt": 1760000123000i64 }
        });
        let mapped = map_codex_rpc_result(&result);
        assert_eq!(mapped.status, "ok");
        let session = mapped.session.unwrap();
        // Fixed bucket duration, not the CLI's remaining-minutes field.
        assert_eq!(session.window_minutes, 300);
        assert_eq!(session.resets_at, Some(1_760_000_000_000));
        assert_eq!(mapped.weekly.unwrap().window_minutes, 10_080);
        let credits = mapped.rate_limit_reset_credits.unwrap();
        assert_eq!(credits.available_count, 2);
        assert_eq!(credits.total_earned_count, Some(5));
        assert_eq!(credits.next_expires_at, Some(1_760_000_123_000));
    }

    #[test]
    fn maps_backend_reset_credits_with_derived_counts() {
        let body = serde_json::json!({
            "total_earned_count": 3,
            "credits": [
                { "status": "available", "expires_at": 1760000000 },
                { "status": "available", "expires_at": 1750000000 },
                { "status": "spent", "expires_at": 1740000000 }
            ]
        });
        let credits = map_backend_reset_credits(&body).unwrap();
        assert_eq!(credits.available_count, 2);
        assert_eq!(credits.total_earned_count, Some(3));
        // Earliest available credit expiry wins.
        assert_eq!(credits.next_expires_at, Some(1_750_000_000_000));
        assert!(map_backend_reset_credits(&serde_json::json!({})).is_none());
    }

    #[test]
    fn consume_outcome_mapping_is_exhaustive_and_strict() {
        assert_eq!(map_consume_outcome(Some("reset")).unwrap(), "reset");
        assert_eq!(
            map_consume_outcome(Some("nothing_to_reset")).unwrap(),
            "nothingToReset"
        );
        assert_eq!(map_consume_outcome(Some("no_credit")).unwrap(), "noCredit");
        assert_eq!(
            map_consume_outcome(Some("already_redeemed")).unwrap(),
            "alreadyRedeemed"
        );
        assert!(map_consume_outcome(Some("mystery")).is_err());
        assert!(map_consume_outcome(None).is_err());
    }
}
