use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use regex::Regex;

use super::{now_ms, ProviderRateLimits, RateLimitBucket, RateLimitWindow, UsageMetadata};

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const LOAD_CODE_ASSIST_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const RETRIEVE_QUOTA_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Clone, Debug)]
struct GeminiCredentials {
    access_token: String,
    refresh_token: String,
    expiry_date: i64,
    source_path: Option<PathBuf>,
    fallback_project: Option<String>,
}

fn result(status: &str, error: Option<String>) -> ProviderRateLimits {
    ProviderRateLimits {
        provider: "gemini".to_string(),
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
            source: Some("oauth".to_string()),
            attempted_sources: vec!["oauth".to_string()],
            failure_kind: None,
            credential_source: Some("gemini-cli".to_string()),
        }),
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn auth_json_candidates(home: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(app_data) = std::env::var_os("APPDATA") {
        candidates.push(PathBuf::from(app_data).join("opencode").join("auth.json"));
    }
    if let Some(xdg_data) = std::env::var_os("XDG_DATA_HOME") {
        candidates.push(PathBuf::from(xdg_data).join("opencode").join("auth.json"));
    }
    candidates.push(home.join(".local/share/opencode/auth.json"));
    candidates.push(home.join("Library/Application Support/opencode/auth.json"));
    candidates
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn read_credentials() -> Result<Option<GeminiCredentials>, String> {
    let home = home_dir().ok_or_else(|| "Could not resolve Gemini home directory".to_string())?;
    for path in auth_json_candidates(&home) {
        let Some(parsed) = read_json(&path) else {
            continue;
        };
        let Some(google) = parsed.get("google") else {
            continue;
        };
        if google.get("type").and_then(|value| value.as_str()) != Some("oauth") {
            continue;
        }
        let refresh = google
            .get("refresh")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let parts = refresh.split('|').collect::<Vec<_>>();
        return Ok(Some(GeminiCredentials {
            access_token: google
                .get("access")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            refresh_token: parts.first().copied().unwrap_or("").to_string(),
            expiry_date: google
                .get("expires")
                .and_then(|value| value.as_i64())
                .unwrap_or(0),
            source_path: None,
            fallback_project: parts
                .get(1)
                .or_else(|| parts.get(2))
                .filter(|value| !value.is_empty())
                .map(|value| (*value).to_string()),
        }));
    }
    let path = home.join(".gemini/oauth_creds.json");
    let Some(parsed) = read_json(&path) else {
        return Ok(None);
    };
    let access_token = parsed
        .get("access_token")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Gemini CLI credentials are invalid".to_string())?;
    let refresh_token = parsed
        .get("refresh_token")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Gemini CLI credentials are invalid".to_string())?;
    let expiry_date = parsed
        .get("expiry_date")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| "Gemini CLI credentials are invalid".to_string())?;
    Ok(Some(GeminiCredentials {
        access_token: access_token.to_string(),
        refresh_token: refresh_token.to_string(),
        expiry_date,
        source_path: Some(path),
        fallback_project: None,
    }))
}

fn resolve_gemini_binary() -> Option<PathBuf> {
    let command = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    if let Ok(output) = Command::new(command).arg("gemini").output() {
        if output.status.success() {
            if let Some(path) = String::from_utf8_lossy(&output.stdout).lines().next() {
                let path = PathBuf::from(path.trim());
                if path.is_file() {
                    return fs::canonicalize(&path).ok().or(Some(path));
                }
            }
        }
    }
    let home = home_dir()?;
    [
        PathBuf::from("/usr/local/bin/gemini"),
        PathBuf::from("/opt/homebrew/bin/gemini"),
        home.join(".local/bin/gemini"),
        home.join("bin/gemini"),
    ]
    .into_iter()
    .find(|path| path.is_file())
    .and_then(|path| fs::canonicalize(&path).ok().or(Some(path)))
}

fn parse_client_credentials(contents: &str) -> Option<(String, String)> {
    let id = Regex::new(r#"OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]"#)
        .ok()?
        .captures(contents)?[1]
        .to_string();
    let secret = Regex::new(r#"OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]"#)
        .ok()?
        .captures(contents)?[1]
        .to_string();
    Some((id, secret))
}

fn read_client_credentials_file(path: &Path) -> Option<(String, String)> {
    parse_client_credentials(&fs::read_to_string(path).ok()?)
}

fn find_package_root(binary: &Path) -> Option<PathBuf> {
    let mut current = binary.parent()?.to_path_buf();
    for _ in 0..=8 {
        if read_json(&current.join("package.json"))
            .and_then(|value| {
                value
                    .get("name")
                    .and_then(|name| name.as_str())
                    .map(str::to_string)
            })
            .as_deref()
            == Some("@google/gemini-cli")
        {
            return Some(current);
        }
        for candidate in [
            current.join("lib/node_modules/@google/gemini-cli"),
            current.join("node_modules/@google/gemini-cli"),
        ] {
            if candidate.join("package.json").is_file() {
                return Some(candidate);
            }
        }
        let parent = current.parent()?.to_path_buf();
        if parent == current {
            break;
        }
        current = parent;
    }
    None
}

fn extract_client_credentials() -> Option<(String, String)> {
    let binary = resolve_gemini_binary()?;
    let bin_dir = binary.parent()?;
    let base = bin_dir.parent()?;
    let oauth_subpath = Path::new("dist/packages/product-core/code_assist/oauth2.js");
    let known = [
        base.join(
            "libexec/lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core",
        )
        .join(oauth_subpath),
        base.join("lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core")
            .join(oauth_subpath),
        base.join("share/gemini-cli/node_modules/@google/gemini-cli-core")
            .join(oauth_subpath),
        base.join("../gemini-cli-core").join(oauth_subpath),
        base.join("node_modules/@google/gemini-cli-core")
            .join(oauth_subpath),
    ];
    for path in known {
        if let Some(credentials) = read_client_credentials_file(&path) {
            return Some(credentials);
        }
    }
    let root = find_package_root(&binary)?;
    for path in [
        root.join("node_modules/@google/gemini-cli-core")
            .join(oauth_subpath),
        root.join(oauth_subpath),
    ] {
        if let Some(credentials) = read_client_credentials_file(&path) {
            return Some(credentials);
        }
    }
    let bundle = root.join("bundle");
    for entry in fs::read_dir(bundle).ok()? {
        let path = entry.ok()?.path();
        if path.extension().and_then(|value| value.to_str()) == Some("js") {
            if let Some(credentials) = read_client_credentials_file(&path) {
                return Some(credentials);
            }
        }
    }
    None
}

async fn refresh_access_token(
    client: &reqwest::Client,
    refresh_token: &str,
) -> Result<(String, Option<i64>), String> {
    let (client_id, client_secret) =
        tauri::async_runtime::spawn_blocking(extract_client_credentials)
            .await
            .map_err(|_| "Gemini CLI OAuth client inspection failed".to_string())?
            .ok_or_else(|| "Token refresh failed".to_string())?;
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|_| "Token refresh failed".to_string())?;
    if !response.status().is_success() {
        return Err("Token refresh failed".to_string());
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "Token refresh failed".to_string())?;
    let token = body
        .get("access_token")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Token refresh failed".to_string())?;
    Ok((
        token.to_string(),
        body.get("expires_in").and_then(|value| value.as_i64()),
    ))
}

fn save_refreshed_credentials(
    path: &Path,
    access_token: &str,
    expires_in: Option<i64>,
) -> Result<(), String> {
    let mut value =
        read_json(path).ok_or_else(|| "Gemini credentials could not be updated".to_string())?;
    value["access_token"] = serde_json::Value::String(access_token.to_string());
    if let Some(seconds) = expires_in {
        value["expiry_date"] = serde_json::Value::Number((now_ms() + seconds * 1_000).into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Gemini credentials path is invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(".oauth_creds.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(
        &temp,
        serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        error.to_string()
    })
}

async fn load_project_id(client: &reqwest::Client, token: &str) -> Result<String, String> {
    let response = client
        .post(LOAD_CODE_ASSIST_URL)
        .bearer_auth(token)
        .json(
            &serde_json::json!({ "metadata": { "ideType": "GEMINI_CLI", "pluginType": "GEMINI" } }),
        )
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to load Gemini project ID (HTTP {})",
            response.status().as_u16()
        ));
    }
    let body: serde_json::Value = response.json().await.map_err(|error| error.to_string())?;
    body.get("cloudaicompanionProject")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Gemini project ID not found in API response".to_string())
}

fn bucket_name(model_id: &str) -> String {
    match model_id {
        "gemini-3.1-pro" => "3.1 Pro".to_string(),
        "gemini-3.1-flash" => "3.1 Flash".to_string(),
        "gemini-3.1-flash-lite" => "3.1 Flash Lite".to_string(),
        "gemini-3.0-pro" => "3.0 Pro".to_string(),
        "gemini-3.0-flash" => "3.0 Flash".to_string(),
        "gemini-2.5-pro" => "Pro".to_string(),
        "gemini-2.5-flash" => "Flash".to_string(),
        "gemini-2.5-flash-lite" => "Flash Lite".to_string(),
        "gemini-2.0-pro" => "2.0 Pro".to_string(),
        "gemini-2.0-flash" => "2.0 Flash".to_string(),
        "gemini-2.0-flash-lite" => "2.0 Flash Lite".to_string(),
        "gemini-1.5-pro" => "1.5 Pro".to_string(),
        "gemini-1.5-flash" => "1.5 Flash".to_string(),
        "gemini-exp" | "gemini-experimental" => "Exp".to_string(),
        _ => model_id
            .trim_start_matches("gemini-")
            .split('-')
            .map(|part| {
                let mut characters = part.chars();
                characters
                    .next()
                    .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn is_known_model(model_id: &str) -> bool {
    matches!(
        model_id,
        "gemini-3.1-pro"
            | "gemini-3.1-flash"
            | "gemini-3.1-flash-lite"
            | "gemini-3.0-pro"
            | "gemini-3.0-flash"
            | "gemini-2.5-pro"
            | "gemini-2.5-flash"
            | "gemini-2.5-flash-lite"
            | "gemini-2.0-pro"
            | "gemini-2.0-flash"
            | "gemini-2.0-flash-lite"
            | "gemini-1.5-pro"
            | "gemini-1.5-flash"
            | "gemini-exp"
            | "gemini-experimental"
    )
}

fn parse_reset_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp_millis())
}

pub fn map_quota_response(data: &serde_json::Value) -> Vec<RateLimitBucket> {
    let raw = data
        .as_array()
        .or_else(|| data.get("buckets").and_then(|value| value.as_array()))
        .cloned()
        .unwrap_or_default();
    let mut buckets: Vec<(RateLimitBucket, String)> = Vec::new();
    for item in raw {
        let Some(remaining) = item
            .get("remainingFraction")
            .and_then(|value| value.as_f64())
            .filter(|value| value.is_finite())
        else {
            continue;
        };
        let Some(reset) = item.get("resetTime").and_then(|value| value.as_str()) else {
            continue;
        };
        let Some(model_id) = item.get("modelId").and_then(|value| value.as_str()) else {
            continue;
        };
        let bucket = RateLimitBucket {
            name: bucket_name(model_id),
            used_percent: ((1.0 - remaining) * 100.0).round().clamp(0.0, 100.0),
            window_minutes: 60,
            resets_at: parse_reset_ms(reset),
            reset_description: None,
        };
        let duplicate = buckets.iter().position(|(existing, _)| {
            existing.used_percent == bucket.used_percent && existing.resets_at == bucket.resets_at
        });
        if let Some(index) = duplicate {
            let existing_known = is_known_model(&buckets[index].1);
            let current_known = is_known_model(model_id);
            if (current_known && !existing_known)
                || (current_known == existing_known
                    && bucket.name.len() < buckets[index].0.name.len())
            {
                buckets[index] = (bucket, model_id.to_string());
            }
        } else {
            buckets.push((bucket, model_id.to_string()));
        }
    }
    buckets.into_iter().map(|(bucket, _)| bucket).collect()
}

async fn fetch_quota(
    client: &reqwest::Client,
    token: &str,
    project: &str,
) -> Result<ProviderRateLimits, u16> {
    let response = client
        .post(RETRIEVE_QUOTA_URL)
        .bearer_auth(token)
        .json(&serde_json::json!({ "project": project }))
        .send()
        .await
        .map_err(|_| 0u16)?;
    if !response.status().is_success() {
        return Err(response.status().as_u16());
    }
    let data: serde_json::Value = response.json().await.map_err(|_| 0u16)?;
    let buckets = map_quota_response(&data);
    let session = buckets
        .iter()
        .max_by(|left, right| left.used_percent.total_cmp(&right.used_percent))
        .map(|bucket| RateLimitWindow {
            used_percent: bucket.used_percent,
            window_minutes: bucket.window_minutes,
            resets_at: bucket.resets_at,
            reset_description: None,
        });
    let mut mapped = result("ok", None);
    mapped.session = session;
    mapped.buckets = Some(buckets);
    Ok(mapped)
}

#[tauri::command]
pub async fn rate_limits_fetch_gemini(enabled: bool) -> ProviderRateLimits {
    if !enabled {
        return result(
            "unavailable",
            Some("Gemini CLI OAuth is disabled in settings".to_string()),
        );
    }
    let mut credentials = match tauri::async_runtime::spawn_blocking(read_credentials).await {
        Ok(Ok(Some(credentials))) => credentials,
        Ok(Ok(None)) => {
            return result(
                "unavailable",
                Some("Gemini CLI credentials not found".to_string()),
            )
        }
        Ok(Err(error)) => return result("error", Some(error)),
        Err(_) => {
            return result(
                "error",
                Some("Gemini credential inspection failed".to_string()),
            )
        }
    };
    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(error) => return result("error", Some(error.to_string())),
    };
    if credentials.expiry_date < now_ms() || credentials.access_token.is_empty() {
        match refresh_access_token(&client, &credentials.refresh_token).await {
            Ok((token, expires_in)) => {
                credentials.access_token = token;
                if let Some(path) = credentials.source_path.as_deref() {
                    if let Err(error) =
                        save_refreshed_credentials(path, &credentials.access_token, expires_in)
                    {
                        return result("error", Some(error));
                    }
                }
            }
            Err(error) => return result("error", Some(error)),
        }
    }
    let project = load_project_id(&client, &credentials.access_token)
        .await
        .ok()
        .or(credentials.fallback_project.clone());
    let Some(project) = project else {
        return result("error", Some("Gemini project ID not found".to_string()));
    };
    match fetch_quota(&client, &credentials.access_token, &project).await {
        Ok(mapped) => mapped,
        Err(401) => match refresh_access_token(&client, &credentials.refresh_token).await {
            Ok((token, expires_in)) => {
                if let Some(path) = credentials.source_path.as_deref() {
                    if let Err(error) = save_refreshed_credentials(path, &token, expires_in) {
                        return result("error", Some(error));
                    }
                }
                let project = load_project_id(&client, &token).await.unwrap_or(project);
                fetch_quota(&client, &token, &project)
                    .await
                    .unwrap_or_else(|status| {
                        result("error", Some(format!("Quota fetch failed ({status})")))
                    })
            }
            Err(error) => result("error", Some(error)),
        },
        Err(status) => result("error", Some(format!("Quota fetch failed ({status})"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_and_deduplicates_quota_buckets() {
        let payload = serde_json::json!([
            { "remainingFraction": 0.75, "resetTime": "2026-04-24T13:00:00Z", "modelId": "unknown-long-model" },
            { "remainingFraction": 0.75, "resetTime": "2026-04-24T13:00:00Z", "modelId": "gemini-2.5-pro" },
            { "remainingFraction": 0.9, "resetTime": "2026-04-24T14:00:00Z", "modelId": "gemini-2.5-flash" },
            { "remainingFraction": "NaN", "resetTime": "bad", "modelId": "ignored" }
        ]);
        let buckets = map_quota_response(&payload);
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].name, "Pro");
        assert_eq!(buckets[0].used_percent, 25.0);
        assert_eq!(buckets[1].name, "Flash");
    }

    #[test]
    fn parses_oauth_client_constants_and_humanizes_unknown_models() {
        assert_eq!(
            parse_client_credentials(
                "const OAUTH_CLIENT_ID='id'; const OAUTH_CLIENT_SECRET=\"secret\";"
            ),
            Some(("id".to_string(), "secret".to_string()))
        );
        assert_eq!(bucket_name("gemini-3.0-ultra"), "3.0 Ultra");
    }
}
