//! Grok credit usage.
//!
//! Grok bills coding usage as credits against a weekly or monthly period rather
//! than as rolling rate-limit windows, so `billingCycle` picks which window this
//! fills and the session window stays empty.

use std::path::PathBuf;

use super::{now_ms, ProviderRateLimits, RateLimitWindow};

const DEFAULT_BASE_URL: &str = "https://cli-chat-proxy.grok.com/v1";
const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const WEEKLY_WINDOW_MINUTES: u32 = 10_080;
const MONTHLY_WINDOW_MINUTES: u32 = 43_200;

fn result(status: &str, error: Option<String>) -> ProviderRateLimits {
    ProviderRateLimits {
        provider: "grok".to_string(),
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

fn credentials_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("GROK_AUTH_PATH").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| "Could not resolve the home directory for Grok credentials".to_string())?;
    Ok(PathBuf::from(home).join(".grok").join("auth.json"))
}

fn number(value: Option<&serde_json::Value>) -> Option<f64> {
    value.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
            .filter(|number| number.is_finite())
    })
}

/// Accepts seconds, milliseconds, or an ISO string. The 10^11 threshold splits
/// seconds from milliseconds — it sits above any plausible second-based
/// timestamp and below any plausible millisecond one.
fn timestamp_ms(value: Option<&serde_json::Value>) -> Option<i64> {
    let value = value?;
    if let Some(raw) = value.as_f64().filter(|number| number.is_finite()) {
        if raw <= 0.0 {
            return None;
        }
        return Some(if raw < 100_000_000_000.0 {
            (raw * 1_000.0) as i64
        } else {
            raw as i64
        });
    }
    let text = value.as_str()?;
    if let Ok(raw) = text.parse::<f64>() {
        return timestamp_ms(Some(&serde_json::json!(raw)));
    }
    super::chrono_free_parse_iso_ms(text)
}

/// Grok reports the cycle as WEEKLY or MONTHLY; anything else is treated as
/// monthly because that is the default coding plan period.
fn cycle_minutes(body: &serde_json::Value) -> u32 {
    let cycle = body
        .get("billingCycle")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_ascii_uppercase();
    if cycle.contains("WEEK") {
        WEEKLY_WINDOW_MINUTES
    } else {
        MONTHLY_WINDOW_MINUTES
    }
}

fn used_percent(body: &serde_json::Value) -> Option<f64> {
    if let Some(percent) = number(body.get("creditUsagePercent")) {
        // Why: the field is a percentage in the CLI's own display, but a share
        // in [0,1] is the more common encoding, so treat <= 1 as a share unless
        // the limit math below disagrees.
        let percent = if percent > 1.0 { percent } else { percent * 100.0 };
        return Some(percent.clamp(0.0, 100.0));
    }
    let limit = number(body.get("monthlyLimit")).filter(|limit| *limit > 0.0)?;
    let used = number(body.get("totalUsed")).or_else(|| number(body.get("includedUsed")))?;
    Some(((used / limit) * 100.0).clamp(0.0, 100.0))
}

fn resets_at(body: &serde_json::Value, window_minutes: u32) -> Option<i64> {
    if let Some(period) = body.get("currentPeriod") {
        if let Some(end) = timestamp_ms(period.get("end")).or_else(|| timestamp_ms(period.get("periodEnd")))
        {
            return Some(end);
        }
    }
    let start = timestamp_ms(body.get("billingPeriodStart"))?;
    Some(start + i64::from(window_minutes) * 60_000)
}

/// Unwraps the payload whether the credits object is at the top level or nested
/// under the usual transport wrappers.
fn credits_body(body: &serde_json::Value) -> &serde_json::Value {
    for key in ["credits", "data", "billing", "result"] {
        if let Some(nested) = body.get(key) {
            if nested.get("monthlyLimit").is_some()
                || nested.get("creditUsagePercent").is_some()
                || nested.get("totalUsed").is_some()
            {
                return nested;
            }
        }
    }
    body
}

pub fn map_grok_billing_response(body: &serde_json::Value) -> ProviderRateLimits {
    let body = credits_body(body);
    let window_minutes = cycle_minutes(body);
    let window = used_percent(body).map(|used_percent| RateLimitWindow {
        used_percent,
        window_minutes,
        resets_at: resets_at(body, window_minutes),
        reset_description: None,
    });
    let Some(window) = window else {
        // Why: an empty bar reads as "plenty left". A provider that answered but
        // carried no quota has to surface as an error, not as zero usage.
        return result(
            "error",
            Some("Grok billing response did not include credit usage".to_string()),
        );
    };
    let weekly = (window_minutes == WEEKLY_WINDOW_MINUTES).then(|| window.clone());
    let monthly = (window_minutes != WEEKLY_WINDOW_MINUTES).then_some(window);
    ProviderRateLimits {
        provider: "grok".to_string(),
        session: None,
        weekly,
        fable_weekly: None,
        monthly,
        buckets: None,
        rate_limit_reset_credits: None,
        updated_at: now_ms(),
        error: None,
        status: "ok".to_string(),
        usage_metadata: None,
    }
}

#[tauri::command]
pub async fn rate_limits_fetch_grok() -> ProviderRateLimits {
    let credentials_path = match credentials_path() {
        Ok(path) => path,
        Err(error) => return result("error", Some(error)),
    };
    let raw = match std::fs::read_to_string(&credentials_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return result("unavailable", Some("Not signed in to Grok".to_string()))
        }
        Err(error) => return result("error", Some(error.to_string())),
    };
    let credentials: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => return result("error", Some(error.to_string())),
    };
    let Some(token) = ["access_token", "accessToken"]
        .iter()
        .find_map(|key| credentials.get(*key).and_then(|value| value.as_str()))
        .filter(|value| !value.is_empty())
    else {
        return result(
            "error",
            Some("Grok credentials file is missing an access token".to_string()),
        );
    };
    // The Grok CLI owns refresh-token rotation; Pebble stays read-only and asks
    // the user to reopen Grok rather than racing it for the refresh.
    let expires_at_ms = ["expires_at", "expiresAt"]
        .iter()
        .find_map(|key| timestamp_ms(credentials.get(*key)));
    if expires_at_ms
        .map(|expiry| expiry - now_ms() <= 5_000)
        .unwrap_or(false)
    {
        return result(
            "error",
            Some("Grok token expired — open Grok to refresh".to_string()),
        );
    }
    let base_url = std::env::var("GROK_CLI_CHAT_PROXY_BASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    let client = match reqwest::Client::builder().timeout(HTTP_TIMEOUT).build() {
        Ok(client) => client,
        Err(error) => return result("error", Some(error.to_string())),
    };
    let response = client
        .get(format!(
            "{}/billing?format=credits",
            base_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .header("Accept", "application/json")
        .header("x-grok-client-mode", "cli")
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => match response.json().await {
            Ok(body) => map_grok_billing_response(&body),
            Err(error) => result("error", Some(error.to_string())),
        },
        Ok(response) if response.status().as_u16() == 401 => result(
            "error",
            Some("Grok sign-in expired — run `grok login`".to_string()),
        ),
        Ok(response) => result(
            "error",
            Some(format!(
                "Grok billing request failed (HTTP {})",
                response.status().as_u16()
            )),
        ),
        Err(error) => result("error", Some(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monthly_body() -> serde_json::Value {
        serde_json::json!({
            "creditUsagePercent": 42.5,
            "monthlyLimit": 200.0,
            "totalUsed": 85.0,
            "includedUsed": 85.0,
            "billingCycle": "MONTHLY",
            "billingPeriodStart": 1_767_225_600i64
        })
    }

    #[test]
    fn maps_a_monthly_cycle_into_the_monthly_window() {
        let limits = map_grok_billing_response(&monthly_body());
        assert_eq!(limits.status, "ok");
        assert_eq!(limits.provider, "grok");
        let monthly = limits.monthly.expect("monthly window");
        assert_eq!(monthly.used_percent, 42.5);
        assert_eq!(monthly.window_minutes, MONTHLY_WINDOW_MINUTES);
        assert_eq!(
            monthly.resets_at,
            Some(1_767_225_600i64 * 1_000 + i64::from(MONTHLY_WINDOW_MINUTES) * 60_000)
        );
        assert!(limits.weekly.is_none());
        assert!(limits.session.is_none());
    }

    #[test]
    fn maps_a_weekly_cycle_into_the_weekly_window() {
        let mut body = monthly_body();
        body["billingCycle"] = serde_json::json!("WEEKLY");
        let limits = map_grok_billing_response(&body);
        let weekly = limits.weekly.expect("weekly window");
        assert_eq!(weekly.window_minutes, WEEKLY_WINDOW_MINUTES);
        assert!(limits.monthly.is_none());
    }

    #[test]
    fn derives_the_percentage_from_the_limit_when_the_percent_is_absent() {
        let mut body = monthly_body();
        body.as_object_mut().unwrap().remove("creditUsagePercent");
        let limits = map_grok_billing_response(&body);
        let monthly = limits.monthly.expect("monthly window");
        assert_eq!(monthly.used_percent, 42.5);
    }

    #[test]
    fn treats_a_share_as_a_percentage() {
        let mut body = monthly_body();
        body["creditUsagePercent"] = serde_json::json!(0.25);
        let limits = map_grok_billing_response(&body);
        assert_eq!(limits.monthly.expect("monthly window").used_percent, 25.0);
    }

    #[test]
    fn prefers_an_explicit_period_end_over_the_derived_reset() {
        let mut body = monthly_body();
        body["currentPeriod"] = serde_json::json!({ "end": 1_769_000_000i64 });
        let limits = map_grok_billing_response(&body);
        assert_eq!(
            limits.monthly.expect("monthly window").resets_at,
            Some(1_769_000_000i64 * 1_000)
        );
    }

    #[test]
    fn unwraps_a_nested_credits_payload() {
        let body = serde_json::json!({ "credits": monthly_body() });
        assert_eq!(map_grok_billing_response(&body).status, "ok");
    }

    // Why: a response that parses but carries no quota must not render as an
    // empty bar — that reads as "plenty left" when the truth is "unknown".
    #[test]
    fn reports_an_error_when_the_response_carries_no_usage() {
        let limits = map_grok_billing_response(&serde_json::json!({ "billingCycle": "MONTHLY" }));
        assert_eq!(limits.status, "error");
        assert!(limits.monthly.is_none());
        assert!(limits.error.is_some());
    }
}
