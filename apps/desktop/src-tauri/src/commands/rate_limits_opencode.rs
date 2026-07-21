use regex::Regex;

use super::{now_ms, ProviderRateLimits, RateLimitWindow};

const OPENCODE_BASE_URL: &str = "https://opencode.ai";
const OPENCODE_SERVER_ID: &str = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const MAX_RESPONSE_BYTES: usize = 10_000_000;
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

fn result(status: &str, error: Option<String>) -> ProviderRateLimits {
    ProviderRateLimits {
        provider: "opencode-go".to_string(),
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

fn normalize_cookie(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.contains(';')
        || trimmed.to_ascii_lowercase().starts_with("auth=")
        || trimmed.to_ascii_lowercase().starts_with("__host-auth=")
    {
        return trimmed.to_string();
    }
    let token_like = trimmed.starts_with("Fe26.2**")
        || trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character));
    if token_like {
        format!("auth={trimmed}")
    } else {
        trimmed.to_string()
    }
}

fn filter_auth_cookie(raw: &str) -> String {
    raw.split(';')
        .filter_map(|pair| {
            let pair = pair.trim();
            let (name, _) = pair.split_once('=')?;
            matches!(name.trim(), "auth" | "__Host-auth").then(|| pair.to_string())
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn parse_workspace_ids(text: &str) -> Vec<String> {
    let regex = Regex::new(r#"\bid\s*:\s*["']((?:wrk|wk)_[A-Za-z0-9]+)["']"#)
        .expect("workspace regex is valid");
    let mut ids = Vec::new();
    for capture in regex.captures_iter(text) {
        let id = capture[1].to_string();
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

fn extract_top_level_number(object: &str, field: &str) -> Option<f64> {
    let pattern = Regex::new(&format!(
        r"^\b{}\b\s*:\s*(-?[0-9]+(?:\.[0-9]+)?)",
        regex::escape(field)
    ))
    .ok()?;
    let mut depth = 0usize;
    for (index, character) in object.char_indices() {
        match character {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            _ if depth == 1 => {
                if let Some(capture) = pattern.captures(&object[index..]) {
                    return capture.get(1)?.as_str().parse::<f64>().ok();
                }
            }
            _ => {}
        }
    }
    None
}

fn extract_usage_block<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let key_regex = Regex::new(&format!(r"\b{}\b\s*:", regex::escape(key))).ok()?;
    for key_match in key_regex.find_iter(text) {
        let search_start = key_match.end();
        let search_end = (search_start + 30).min(text.len());
        let Some(open_offset) = text.get(search_start..search_end)?.find('{') else {
            continue;
        };
        let open = search_start + open_offset;
        let mut depth = 0usize;
        for (offset, character) in text[open..].char_indices() {
            match character {
                '{' => depth += 1,
                '}' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        let block = &text[open..open + offset + 1];
                        if extract_top_level_number(block, "usagePercent").is_some()
                            && extract_top_level_number(block, "resetInSec").is_some()
                        {
                            return Some(block);
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    None
}

fn parse_usage(text: &str, key: &str) -> Option<(f64, f64)> {
    let block = extract_usage_block(text, key)?;
    Some((
        extract_top_level_number(block, "usagePercent")?.clamp(0.0, 100.0),
        extract_top_level_number(block, "resetInSec")?,
    ))
}

fn usage_window(usage: (f64, f64), window_minutes: u32) -> RateLimitWindow {
    RateLimitWindow {
        used_percent: usage.0,
        window_minutes,
        resets_at: Some(now_ms().saturating_add((usage.1 * 1_000.0) as i64)),
        reset_description: None,
    }
}

pub fn map_opencode_usage_page(text: &str) -> Option<ProviderRateLimits> {
    if text.is_empty() || text.len() > MAX_RESPONSE_BYTES {
        return None;
    }
    let session = parse_usage(text, "rollingUsage")?;
    let weekly = parse_usage(text, "weeklyUsage")?;
    let monthly = parse_usage(text, "monthlyUsage");
    Some(ProviderRateLimits {
        provider: "opencode-go".to_string(),
        session: Some(usage_window(session, 300)),
        weekly: Some(usage_window(weekly, 10_080)),
        fable_weekly: None,
        monthly: monthly.map(|usage| usage_window(usage, 43_200)),
        buckets: None,
        rate_limit_reset_credits: None,
        updated_at: now_ms(),
        error: None,
        status: "ok".to_string(),
        usage_metadata: None,
    })
}

async fn response_text(response: reqwest::Response) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("OpenCode Go response exceeded the size limit".to_string());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("OpenCode Go response exceeded the size limit".to_string());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "OpenCode Go response was not UTF-8".to_string())
}

#[tauri::command]
pub async fn rate_limits_fetch_opencode_go(
    cookie: String,
    workspace_id: Option<String>,
) -> ProviderRateLimits {
    let normalized = normalize_cookie(&cookie);
    if normalized.is_empty() {
        return result(
            "unavailable",
            Some("Session cookie not configured".to_string()),
        );
    }
    let auth_cookie = filter_auth_cookie(&normalized);
    if auth_cookie.is_empty() {
        return result(
            "error",
            Some(
                "No auth cookie found — paste the full Cookie header from opencode.ai DevTools"
                    .to_string(),
            ),
        );
    }
    let override_id = workspace_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if override_id.as_deref().is_some_and(|value| {
        !Regex::new(r"^(wrk|wk)_[A-Za-z0-9]+$")
            .unwrap()
            .is_match(value)
    }) {
        return result(
            "error",
            Some("Invalid workspace ID format: must match ^(wrk|wk)_[A-Za-z0-9]+$".to_string()),
        );
    }
    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(error) => return result("error", Some(error.to_string())),
    };
    let ids = if let Some(id) = override_id {
        vec![id]
    } else {
        let response = client
            .get(format!(
                "{OPENCODE_BASE_URL}/_server?id={OPENCODE_SERVER_ID}"
            ))
            .header("Cookie", &auth_cookie)
            .header("X-Server-Id", OPENCODE_SERVER_ID)
            .header(
                "X-Server-Instance",
                format!("server-fn:{}", uuid::Uuid::new_v4()),
            )
            .header(
                "Accept",
                "text/javascript, application/json;q=0.9, */*;q=0.8",
            )
            .header("Origin", OPENCODE_BASE_URL)
            .header("Referer", OPENCODE_BASE_URL)
            .send()
            .await;
        let response = match response {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                return result(
                    "error",
                    Some(format!(
                        "Workspaces fetch failed ({})",
                        response.status().as_u16()
                    )),
                )
            }
            Err(error) => return result("error", Some(error.to_string())),
        };
        match response_text(response).await {
            Ok(text) => parse_workspace_ids(&text),
            Err(error) => return result("error", Some(error)),
        }
    };
    if ids.is_empty() {
        return result(
            "error",
            Some("No workspace ID found — set a Workspace ID override in settings".to_string()),
        );
    }
    let mut last_error = "Could not parse usage data from any available workspace".to_string();
    for id in ids {
        let response = client
            .get(format!("{OPENCODE_BASE_URL}/workspace/{id}/go"))
            .header("Cookie", &auth_cookie)
            .header(
                "Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .header("Origin", OPENCODE_BASE_URL)
            .header("Referer", OPENCODE_BASE_URL)
            .send()
            .await;
        let response = match response {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                last_error = format!("Usage page fetch failed ({})", response.status().as_u16());
                continue;
            }
            Err(error) => {
                last_error = error.to_string();
                continue;
            }
        };
        match response_text(response).await {
            Ok(text) => {
                if let Some(mapped) = map_opencode_usage_page(&text) {
                    return mapped;
                }
                last_error = "Could not parse usage data from page".to_string();
            }
            Err(error) => last_error = error,
        }
    }
    result("error", Some(last_error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_and_filters_auth_cookie_without_forwarding_other_values() {
        assert_eq!(normalize_cookie("Fe26.2**token"), "auth=Fe26.2**token");
        assert_eq!(
            filter_auth_cookie("session=secret; auth=real; tracking=value"),
            "auth=real"
        );
    }

    #[test]
    fn parses_workspace_ids_without_duplicates() {
        assert_eq!(
            parse_workspace_ids("id: \"wrk_ONE\", id:'wk_TWO', id:\"wrk_ONE\""),
            vec!["wrk_ONE", "wk_TWO"]
        );
    }

    #[test]
    fn parses_react_flight_usage_and_skips_null_monthly_placeholder() {
        let page = r#"
          rollingUsage:$R[21]={status:"ok",resetInSec:7200,usagePercent:30},
          weeklyUsage:$R[22]={status:"ok",resetInSec:259200,usagePercent:51},
          monthlyUsage:null,
          monthlyUsage:$R[23]={status:"ok",resetInSec:1296000,usagePercent:89}
        "#;
        let mapped = map_opencode_usage_page(page).unwrap();
        assert_eq!(mapped.session.unwrap().used_percent, 30.0);
        assert_eq!(mapped.weekly.unwrap().used_percent, 51.0);
        assert_eq!(mapped.monthly.unwrap().used_percent, 89.0);
    }

    #[test]
    fn rejects_missing_required_usage_windows_and_oversized_pages() {
        assert!(map_opencode_usage_page("monthlyUsage:{usagePercent:1,resetInSec:1}").is_none());
        assert!(map_opencode_usage_page(&"x".repeat(MAX_RESPONSE_BYTES + 1)).is_none());
    }
}
