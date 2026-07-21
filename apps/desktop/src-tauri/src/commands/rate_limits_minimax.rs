use regex::Regex;

use super::{now_ms, ProviderRateLimits, RateLimitWindow, UsageMetadata};
use crate::commands::minimax_credentials::read_cookie;

const USAGE_ENDPOINT: &str = "https://platform.minimax.io/v1/api/openplatform/coding_plan/remains";
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

fn result(status: &str, error: Option<String>, failure_kind: Option<&str>) -> ProviderRateLimits {
    ProviderRateLimits {
        provider: "minimax".to_string(),
        session: None,
        weekly: None,
        fable_weekly: None,
        monthly: None,
        buckets: None,
        rate_limit_reset_credits: None,
        updated_at: now_ms(),
        error,
        status: status.to_string(),
        usage_metadata: Some(UsageMetadata {
            source: Some("web".to_string()),
            attempted_sources: vec!["web".to_string()],
            failure_kind: failure_kind.map(str::to_string),
            credential_source: Some("os-credential-store".to_string()),
        }),
    }
}

fn parse_cookie_pairs(cookie: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for part in cookie.split(';') {
        let normalized = Regex::new(r"(?i)^Cookie:\s*")
            .unwrap()
            .replace(part.trim(), "");
        if let Some((name, value)) = normalized.split_once('=') {
            let name = name.trim();
            let value = value.trim();
            if !name.is_empty() && !value.is_empty() {
                pairs.push((name.to_string(), value.to_string()));
            }
        }
    }
    let quoted = Regex::new(r#"(?:^|[;\s])([A-Za-z0-9_.-]+)\s*:\s*["']([^"']+)["']"#)
        .expect("MiniMax quoted cookie regex is valid");
    for capture in quoted.captures_iter(cookie) {
        pairs.push((capture[1].to_string(), capture[2].to_string()));
    }
    pairs
}

fn cookie_value(cookie: &str, name: &str) -> Option<String> {
    parse_cookie_pairs(cookie)
        .into_iter()
        .find_map(|(candidate, value)| (candidate == name).then_some(value))
}

fn normalized_cookie(cookie: &str) -> String {
    parse_cookie_pairs(cookie)
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn browser_user_agent() -> &'static str {
    if cfg!(target_os = "windows") {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0"
    } else if cfg!(target_os = "macos") {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0"
    } else {
        "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0"
    }
}

fn number(value: Option<&serde_json::Value>) -> Option<f64> {
    value.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
            .filter(|number| number.is_finite())
    })
}

fn parse_models(models: Option<&str>) -> Vec<String> {
    let parsed = models
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if parsed.is_empty() {
        vec!["general".to_string()]
    } else {
        parsed
    }
}

pub fn map_minimax_usage(
    payload: &serde_json::Value,
    preferred_models: &[String],
) -> Option<RateLimitWindow> {
    let items = payload.get("model_remains")?.as_array()?;
    let snapshots = items
        .iter()
        .filter_map(|item| {
            let model = item.get("model_name")?.as_str()?.to_string();
            let remaining = number(item.get("current_interval_remaining_percent"))?;
            let end_time = number(item.get("end_time"))?;
            Some((
                model,
                RateLimitWindow {
                    used_percent: (100.0 - remaining).round().clamp(0.0, 100.0),
                    window_minutes: 300,
                    resets_at: Some(end_time as i64),
                    reset_description: None,
                },
            ))
        })
        .collect::<Vec<_>>();
    for preferred in preferred_models {
        if let Some((_, window)) = snapshots.iter().find(|(model, _)| model == preferred) {
            return Some(window.clone());
        }
    }
    (snapshots.len() == 1).then(|| snapshots[0].1.clone())
}

#[tauri::command]
pub async fn rate_limits_fetch_minimax(
    group_id: Option<String>,
    models: Option<String>,
) -> ProviderRateLimits {
    let cookie = match read_cookie() {
        Ok(cookie) => cookie,
        Err(error) if error == "MiniMax session cookie not configured" => {
            return result("unavailable", Some(error), Some("missing-credentials"))
        }
        Err(error) => return result("error", Some(error), Some("unknown")),
    };
    let cookie = normalized_cookie(&cookie);
    if cookie_value(&cookie, "_token").is_none() {
        return result(
            "error",
            Some("MiniMax auth cookie not found — paste a Cookie header with _token".to_string()),
            Some("missing-credentials"),
        );
    }
    let group_id = group_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| cookie_value(&cookie, "minimax_group_id_v2"));
    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(error) => return result("error", Some(error.to_string()), Some("unknown")),
    };
    let mut request = client
        .get(USAGE_ENDPOINT)
        .header("Accept", "application/json, text/plain, */*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Referer", "https://platform.minimax.io/console/usage")
        .header("User-Agent", browser_user_agent())
        .header("Cookie", cookie);
    if let Some(group_id) = group_id {
        request = request.header("X-Group-Id", group_id);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => return result("error", Some(error.to_string()), Some("network")),
    };
    if matches!(response.status().as_u16(), 401 | 403) {
        return result(
            "error",
            Some("MiniMax session expired. Replace the MiniMax cookie in Settings.".to_string()),
            Some("stale-token"),
        );
    }
    if !response.status().is_success() {
        return result(
            "error",
            Some(format!(
                "MiniMax usage fetch failed ({})",
                response.status().as_u16()
            )),
            Some("server"),
        );
    }
    let payload: serde_json::Value = match response.json().await {
        Ok(payload) => payload,
        Err(error) => return result("error", Some(error.to_string()), Some("parse")),
    };
    if let Some(code) = payload
        .get("base_resp")
        .and_then(|base| base.get("status_code"))
        .and_then(|value| value.as_i64())
        .filter(|code| *code != 0)
    {
        let message = payload
            .get("base_resp")
            .and_then(|base| base.get("status_msg"))
            .and_then(|value| value.as_str())
            .unwrap_or("MiniMax returned an error");
        return result(
            "error",
            Some(format!("{message} (code {code})")),
            Some("usage-unavailable"),
        );
    }
    let preferred = parse_models(models.as_deref());
    let Some(session) = map_minimax_usage(&payload, &preferred) else {
        return result(
            "error",
            Some("MiniMax usage data for the configured model was not found".to_string()),
            Some("usage-unavailable"),
        );
    };
    let mut mapped = result("ok", None, None);
    mapped.session = Some(session);
    mapped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_header_and_quoted_cookie_exports() {
        assert_eq!(
            normalized_cookie("Cookie: _token=abc; minimax_group_id_v2=group"),
            "_token=abc; minimax_group_id_v2=group"
        );
        assert_eq!(
            cookie_value(r#"_token : "abc""#, "_token").as_deref(),
            Some("abc")
        );
    }

    #[test]
    fn maps_preferred_model_to_fixed_five_hour_window() {
        let payload = serde_json::json!({
            "model_remains": [
                { "model_name": "other", "current_interval_remaining_percent": 80, "end_time": 1000 },
                { "model_name": "general", "current_interval_remaining_percent": "35", "end_time": "2000" }
            ]
        });
        let window = map_minimax_usage(&payload, &["general".to_string()]).unwrap();
        assert_eq!(window.used_percent, 65.0);
        assert_eq!(window.window_minutes, 300);
        assert_eq!(window.resets_at, Some(2000));
    }

    #[test]
    fn does_not_guess_when_multiple_unpreferred_models_exist() {
        let payload = serde_json::json!({
            "model_remains": [
                { "model_name": "one", "current_interval_remaining_percent": 80, "end_time": 1000 },
                { "model_name": "two", "current_interval_remaining_percent": 20, "end_time": 2000 }
            ]
        });
        assert!(map_minimax_usage(&payload, &["general".to_string()]).is_none());
    }
}
