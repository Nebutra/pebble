use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Manager;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "nebutra.pebble.jira";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
static REQUEST_LIMIT: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraSite {
    id: String,
    site_url: String,
    email: String,
    display_name: String,
    account_id: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct JiraSiteFile {
    version: u8,
    active_site_id: Option<String>,
    selected_site_id: Option<String>,
    sites: Vec<JiraSite>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraConnectInput {
    site_url: String,
    email: String,
    api_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraSiteInput {
    site_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraSelectSiteInput {
    site_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraRequestInput {
    site_id: String,
    method: String,
    path: String,
    body: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraNativeResponse {
    status: u16,
    body: Value,
}

#[tauri::command]
pub async fn jira_connect(app: tauri::AppHandle, input: JiraConnectInput) -> Result<Value, String> {
    let site_url = normalize_site_url(&input.site_url)?;
    let email = input.email.trim();
    let token = input.api_token.trim();
    if email.is_empty() || token.is_empty() {
        return Ok(
            serde_json::json!({ "ok": false, "error": "Site URL, email, and API token are required." }),
        );
    }
    let viewer =
        match request_with_credentials(&site_url, email, token, "GET", "/rest/api/3/myself", None)
            .await
        {
            Ok(viewer) => viewer,
            Err(error) => {
                return Ok(serde_json::json!({ "ok": false, "error": sanitize_jira_error(error) }))
            }
        };
    if viewer.status < 200 || viewer.status >= 300 {
        return Ok(
            serde_json::json!({ "ok": false, "error": jira_http_error(viewer.status, &viewer.body) }),
        );
    }
    let account_id = value_string(&viewer.body, "accountId");
    let display_name = value_string(&viewer.body, "displayName");
    let site_id = site_id(&site_url, email);
    jira_entry(&site_id)?
        .set_password(token)
        .map_err(|error| format!("Could not store Jira credential: {error}"))?;
    let mut file = read_site_file(&app)?;
    let site = JiraSite {
        id: site_id.clone(),
        site_url,
        email: email.to_string(),
        display_name: if display_name.is_empty() {
            email.to_string()
        } else {
            display_name.clone()
        },
        account_id: account_id.clone(),
    };
    file.sites.retain(|entry| entry.id != site_id);
    file.sites.push(site);
    file.active_site_id = Some(site_id.clone());
    file.selected_site_id = Some(site_id);
    write_site_file(&app, &file)?;
    Ok(serde_json::json!({ "ok": true, "viewer": viewer_from_json(&viewer.body, email) }))
}

#[tauri::command]
pub fn jira_disconnect(app: tauri::AppHandle, input: Option<JiraSiteInput>) -> Result<(), String> {
    let mut file = read_site_file(&app)?;
    let selected = input
        .and_then(|value| value.site_id)
        .or_else(|| file.active_site_id.clone());
    if let Some(site_id) = selected {
        file.sites.retain(|site| site.id != site_id);
        match jira_entry(&site_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(format!("Could not remove Jira credential: {error}")),
        }
    } else {
        for site in &file.sites {
            let _ = jira_entry(&site.id)
                .and_then(|entry| entry.delete_credential().map_err(|error| error.to_string()));
        }
        file.sites.clear();
    }
    file.active_site_id = file.sites.first().map(|site| site.id.clone());
    file.selected_site_id = file.active_site_id.clone();
    write_site_file(&app, &file)
}

#[tauri::command]
pub fn jira_select_site(
    app: tauri::AppHandle,
    input: JiraSelectSiteInput,
) -> Result<Value, String> {
    let mut file = read_site_file(&app)?;
    if input.site_id != "all" && !file.sites.iter().any(|site| site.id == input.site_id) {
        return Err("Jira site was not found.".to_string());
    }
    file.selected_site_id = Some(input.site_id);
    write_site_file(&app, &file)?;
    jira_status(app)
}

#[tauri::command]
pub fn jira_status(app: tauri::AppHandle) -> Result<Value, String> {
    let file = read_site_file(&app)?;
    let active = file
        .active_site_id
        .as_ref()
        .and_then(|id| file.sites.iter().find(|site| &site.id == id));
    Ok(serde_json::json!({
        "connected": !file.sites.is_empty(),
        "viewer": active.map(site_viewer),
        "sites": file.sites,
        "activeSiteId": file.active_site_id,
        "selectedSiteId": file.selected_site_id,
    }))
}

#[tauri::command]
pub async fn jira_test_connection(
    app: tauri::AppHandle,
    input: Option<JiraSiteInput>,
) -> Result<Value, String> {
    let file = read_site_file(&app)?;
    let site = resolve_site(&file, input.and_then(|value| value.site_id).as_deref())?;
    let token = match jira_entry(&site.id).and_then(|entry| {
        entry
            .get_password()
            .map_err(|error| format!("Jira credential could not be read: {error}"))
    }) {
        Ok(token) => token,
        Err(error) => return Ok(serde_json::json!({ "ok": false, "error": error })),
    };
    let response = match request_with_credentials(
        &site.site_url,
        &site.email,
        &token,
        "GET",
        "/rest/api/3/myself",
        None,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => return Ok(serde_json::json!({ "ok": false, "error": error })),
    };
    if (200..300).contains(&response.status) {
        Ok(
            serde_json::json!({ "ok": true, "viewer": viewer_from_json(&response.body, &site.email) }),
        )
    } else {
        Ok(
            serde_json::json!({ "ok": false, "error": jira_http_error(response.status, &response.body) }),
        )
    }
}

#[tauri::command]
pub async fn jira_request(
    app: tauri::AppHandle,
    input: JiraRequestInput,
) -> Result<JiraNativeResponse, String> {
    validate_request_path(&input.path)?;
    let file = read_site_file(&app)?;
    let site = resolve_site(&file, Some(&input.site_id))?;
    let token = jira_entry(&site.id)?
        .get_password()
        .map_err(|error| format!("Jira credential could not be read: {error}"))?;
    request_with_credentials(
        &site.site_url,
        &site.email,
        &token,
        &input.method,
        &input.path,
        input.body,
    )
    .await
}

async fn request_with_credentials(
    site_url: &str,
    email: &str,
    token: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<JiraNativeResponse, String> {
    let method = match method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("Invalid Jira request method.".to_string()),
    };
    let _permit = REQUEST_LIMIT
        .get_or_init(|| tokio::sync::Semaphore::new(4))
        .acquire()
        .await
        .map_err(|_| "Jira request queue is unavailable.".to_string())?;
    let url = format!("{}{}", site_url.trim_end_matches('/'), path);
    let authorization = STANDARD.encode(format!("{email}:{token}"));
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .request(method, url)
        .header("Authorization", format!("Basic {authorization}"))
        .header("Accept", "application/json")
        .header("User-Agent", "Pebble");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Jira request failed: {error}"))?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Could not read Jira response: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("Jira response exceeded the size limit.".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            Value::String(String::from_utf8_lossy(&bytes).chars().take(2000).collect())
        })
    };
    Ok(JiraNativeResponse { status, body })
}

fn normalize_site_url(value: &str) -> Result<String, String> {
    let input = value.trim();
    let input = if input.contains("://") {
        input.to_string()
    } else {
        format!("https://{input}")
    };
    let mut url = reqwest::Url::parse(&input).map_err(|_| "Invalid Jira site URL.".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("Jira site URL must use HTTP or HTTPS.".to_string());
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn validate_request_path(path: &str) -> Result<(), String> {
    if !path.starts_with("/rest/api/3/")
        || path.len() > 16 * 1024
        || path.contains(['\r', '\n', '\0'])
    {
        return Err("Invalid Jira API path.".to_string());
    }
    Ok(())
}

fn site_id(site_url: &str, email: &str) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    URL_SAFE_NO_PAD.encode(Sha256::digest(format!(
        "{site_url}\n{}",
        email.to_lowercase()
    )))[..24]
        .to_string()
}

fn jira_entry(site_id: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, site_id).map_err(|error| error.to_string())
}

fn site_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("jira-sites.json"))
        .map_err(|error| error.to_string())
}

fn read_site_file(app: &tauri::AppHandle) -> Result<JiraSiteFile, String> {
    let path = site_file_path(app)?;
    if !path.exists() {
        return Ok(JiraSiteFile {
            version: 1,
            ..Default::default()
        });
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("Jira site metadata is too large.".to_string());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Jira site metadata is invalid.".to_string())
}

fn write_site_file(app: &tauri::AppHandle, file: &JiraSiteFile) -> Result<(), String> {
    let path = site_file_path(app)?;
    let parent = path.parent().ok_or("Jira metadata path has no parent.")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".jira-{}.tmp", Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(file).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    replace_file(&temporary, &path)
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    let backup = target.with_extension("jira-backup");
    if target.exists() {
        fs::rename(target, &backup).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(source, target) {
        let _ = fs::rename(backup, target);
        return Err(error.to_string());
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

fn resolve_site<'a>(file: &'a JiraSiteFile, site_id: Option<&str>) -> Result<&'a JiraSite, String> {
    let id = site_id
        .filter(|value| !value.is_empty())
        .or(file.active_site_id.as_deref())
        .ok_or("Jira is not connected.")?;
    file.sites
        .iter()
        .find(|site| site.id == id)
        .ok_or("Jira site was not found.".to_string())
}

fn value_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
fn site_viewer(site: &JiraSite) -> Value {
    serde_json::json!({ "accountId": site.account_id, "displayName": site.display_name, "email": site.email })
}
fn viewer_from_json(value: &Value, fallback_email: &str) -> Value {
    let avatars = value.get("avatarUrls").and_then(Value::as_object);
    let display_name = value_string(value, "displayName");
    let display_name = if display_name.is_empty() {
        fallback_email.to_string()
    } else {
        display_name
    };
    serde_json::json!({
        "accountId": value_string(value, "accountId"),
        "displayName": display_name,
        "email": value.get("emailAddress").and_then(Value::as_str).unwrap_or(fallback_email),
        "avatarUrl": avatars.and_then(|map| map.get("48x48").or_else(|| map.get("32x32"))).and_then(Value::as_str),
    })
}
fn jira_http_error(status: u16, body: &Value) -> String {
    format!(
        "Error {status}: {}",
        body.get("errorMessages")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_str)
            .unwrap_or("Jira request failed")
    )
}
fn sanitize_jira_error(error: String) -> String {
    if error.to_lowercase().contains("authorization") {
        "Jira request failed.".to_string()
    } else {
        error
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_site_and_matches_electron_site_id() {
        let url = normalize_site_url("example.atlassian.net/").unwrap();
        assert_eq!(url, "https://example.atlassian.net");
        assert_eq!(site_id(&url, "User@Example.com").len(), 24);
    }
    #[test]
    fn request_paths_cannot_escape_the_jira_api() {
        assert!(validate_request_path("/rest/api/3/issue/ABC-1").is_ok());
        assert!(validate_request_path("https://attacker.test/").is_err());
        assert!(validate_request_path("/rest/api/2/issue").is_err());
    }
}
