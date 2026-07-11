//! Native rate-limit usage fetchers for Claude and Codex.
//!
//! Ports the read paths of Electron's `src/main/rate-limits/claude-fetcher.ts`
//! and `codex-fetcher.ts`: Claude usage comes from the Claude Code OAuth usage
//! endpoint using the CLI's own stored credentials; Codex usage comes from a
//! short-lived `codex app-server` JSON-RPC session plus the ChatGPT backend
//! reset-credit endpoints. Providers whose fetchers need credential stores
//! that have no native home yet (Gemini/Kimi/MiniMax/OpenCode) and WSL-hosted
//! runtimes stay explicit gaps in the TS bridge.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::agent_accounts::{
    read_claude_oauth_credentials, read_codex_access_token, resolve_codex_home,
};

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

/// Mirrors the renderer's `ProviderRateLimits` shape (src/shared/rate-limit-types.ts).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRateLimits {
    pub provider: String,
    pub session: Option<RateLimitWindow>,
    pub weekly: Option<RateLimitWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fable_weekly: Option<RateLimitWindow>,
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
        let digits: String = stripped.chars().take_while(|c| c.is_ascii_digit()).collect();
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

    let client = match reqwest::Client::builder().timeout(HTTP_TIMEOUT).build() {
        Ok(client) => client,
        Err(err) => {
            return failed_result(
                "claude",
                "error",
                format!("Could not build HTTP client: {err}"),
                "unknown",
                Some(credentials.source.to_string()),
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
            Ok(body) => map_claude_usage_response(&body, credentials.source),
            Err(err) => failed_result(
                "claude",
                "error",
                format!("Could not parse Claude usage response: {err}"),
                "parse",
                Some(credentials.source.to_string()),
            ),
        },
        Ok(response) => {
            let status = response.status().as_u16();
            failed_result(
                "claude",
                "error",
                format!("Claude usage endpoint returned HTTP {status}"),
                classify_http_failure(status),
                Some(credentials.source.to_string()),
            )
        }
        Err(err) => failed_result(
            "claude",
            "error",
            format!("Claude usage request failed: {err}"),
            "network",
            Some(credentials.source.to_string()),
        ),
    }
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
fn fetch_codex_rate_limits_blocking() -> ProviderRateLimits {
    let codex_command = match super::preflight::resolve_command_path("codex") {
        Some(path) => path,
        None => {
            return codex_failed(
                "unavailable",
                "Codex CLI not found".to_string(),
                "cli-unavailable",
            )
        }
    };

    // Why: read-only, untrusted approval mode — this hidden background fetch
    // must never be able to execute workspace commands (mirrors codex-fetcher.ts).
    let mut child = match Command::new(&codex_command)
        .args(["-s", "read-only", "-a", "untrusted", "app-server"])
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

async fn codex_backend_reset_credits() -> Option<RateLimitResetCredits> {
    let (token, account_id) =
        tauri::async_runtime::spawn_blocking(|| resolve_codex_home().as_deref().and_then(read_codex_access_token))
            .await
            .ok()??;
    let client = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().ok()?;
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
pub async fn rate_limits_fetch_codex() -> ProviderRateLimits {
    let mut result = tauri::async_runtime::spawn_blocking(fetch_codex_rate_limits_blocking)
        .await
        .unwrap_or_else(|_| {
            codex_failed("error", "Codex fetch task failed".to_string(), "unknown")
        });
    // Why: published Codex CLIs can read windows through app-server but strip
    // reset-credit metadata that the backend already returns.
    let needs_credits = result.status == "ok"
        && result
            .rate_limit_reset_credits
            .as_ref()
            .map(|credits| credits.next_expires_at.is_none())
            .unwrap_or(true);
    if needs_credits {
        if let Some(credits) = codex_backend_reset_credits().await {
            result.rate_limit_reset_credits = Some(credits);
        }
    }
    result
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

/// Redeem one earned Codex rate-limit reset credit. Idempotent server-side via
/// the caller-provided redeem_request_id.
#[tauri::command]
pub async fn rate_limits_consume_codex_reset_credit(
    idempotency_key: String,
) -> Result<CodexResetCreditOutcome, String> {
    if idempotency_key.trim().is_empty() {
        return Err("Codex reset idempotency key is required".to_string());
    }
    let auth = tauri::async_runtime::spawn_blocking(|| {
        resolve_codex_home().as_deref().and_then(read_codex_access_token)
    })
    .await
    .map_err(|_| "Codex credential probe failed".to_string())?;
    let Some((token, account_id)) = auth else {
        return Err("Codex not signed in".to_string());
    };

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
        return Err(format!("Codex reset failed: HTTP {}", response.status().as_u16()));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|err| format!("Codex reset response unreadable: {err}"))?;
    map_consume_outcome(body.get("code").and_then(|v| v.as_str()))
        .map(|outcome| CodexResetCreditOutcome { outcome })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(parse_reset_timestamp(Some(&serde_json::json!("nonsense"))), None);
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
