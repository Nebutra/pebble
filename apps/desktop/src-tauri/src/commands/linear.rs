use futures_util::StreamExt;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Manager;

const API_URL: &str = "https://api.linear.app/graphql";
const KEYRING_SERVICE: &str = "nebutra.pebble.linear";
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
static REQUEST_LIMIT: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearWorkspace {
    id: String,
    display_name: String,
    email: Option<String>,
    organization_id: String,
    organization_name: String,
    organization_url_key: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinearWorkspaceFile {
    version: u8,
    active_workspace_id: Option<String>,
    selected_workspace_id: Option<String>,
    workspaces: Vec<LinearWorkspace>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearConnectInput {
    api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearWorkspaceInput {
    workspace_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearSelectWorkspaceInput {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearRequestInput {
    workspace_id: String,
    query: String,
    variables: Option<Value>,
}

#[tauri::command]
pub async fn linear_connect(
    app: tauri::AppHandle,
    input: LinearConnectInput,
) -> Result<Value, String> {
    let token = input.api_key.trim();
    if token.is_empty() {
        return Ok(serde_json::json!({ "ok": false, "error": "Invalid API key" }));
    }
    let data = match graphql(token, viewer_query(), None).await {
        Ok(data) => data,
        Err(error) => return Ok(serde_json::json!({ "ok": false, "error": error })),
    };
    let workspace = workspace_from_viewer(&data)?;
    linear_entry(&workspace.id)?
        .set_password(token)
        .map_err(|error| format!("Could not store Linear credential: {error}"))?;
    let mut file = read_workspace_file(&app)?;
    file.workspaces.retain(|entry| entry.id != workspace.id);
    file.workspaces.push(workspace.clone());
    file.active_workspace_id = Some(workspace.id.clone());
    file.selected_workspace_id = Some(workspace.id.clone());
    write_workspace_file(&app, &file)?;
    Ok(serde_json::json!({ "ok": true, "viewer": workspace }))
}

#[tauri::command]
pub fn linear_disconnect(
    app: tauri::AppHandle,
    input: Option<LinearWorkspaceInput>,
) -> Result<(), String> {
    let mut file = read_workspace_file(&app)?;
    let selected = input
        .and_then(|value| value.workspace_id)
        .or_else(|| file.active_workspace_id.clone());
    if let Some(workspace_id) = selected {
        file.workspaces
            .retain(|workspace| workspace.id != workspace_id);
        match linear_entry(&workspace_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(format!("Could not remove Linear credential: {error}")),
        }
    }
    file.active_workspace_id = file
        .workspaces
        .first()
        .map(|workspace| workspace.id.clone());
    file.selected_workspace_id = file.active_workspace_id.clone();
    write_workspace_file(&app, &file)
}

#[tauri::command]
pub fn linear_select_workspace(
    app: tauri::AppHandle,
    input: LinearSelectWorkspaceInput,
) -> Result<Value, String> {
    let mut file = read_workspace_file(&app)?;
    if input.workspace_id != "all"
        && !file
            .workspaces
            .iter()
            .any(|entry| entry.id == input.workspace_id)
    {
        return Err("Linear workspace was not found.".to_string());
    }
    file.selected_workspace_id = Some(input.workspace_id);
    write_workspace_file(&app, &file)?;
    linear_status(app)
}

#[tauri::command]
pub fn linear_status(app: tauri::AppHandle) -> Result<Value, String> {
    let file = read_workspace_file(&app)?;
    let active = file
        .active_workspace_id
        .as_ref()
        .and_then(|id| file.workspaces.iter().find(|workspace| &workspace.id == id));
    Ok(serde_json::json!({
        "connected": !file.workspaces.is_empty(),
        "viewer": active,
        "workspaces": file.workspaces,
        "activeWorkspaceId": file.active_workspace_id,
        "selectedWorkspaceId": file.selected_workspace_id,
    }))
}

#[tauri::command]
pub async fn linear_test_connection(
    app: tauri::AppHandle,
    input: Option<LinearWorkspaceInput>,
) -> Result<Value, String> {
    let file = read_workspace_file(&app)?;
    let workspace =
        match resolve_workspace(&file, input.and_then(|value| value.workspace_id).as_deref()) {
            Ok(workspace) => workspace,
            Err(error) => return Ok(serde_json::json!({ "ok": false, "error": error })),
        };
    match request_for_workspace(workspace, viewer_query(), None).await {
        Ok(data) => Ok(serde_json::json!({ "ok": true, "viewer": workspace_from_viewer(&data)? })),
        Err(error) => Ok(serde_json::json!({ "ok": false, "error": error })),
    }
}

#[tauri::command]
pub async fn linear_request(
    app: tauri::AppHandle,
    input: LinearRequestInput,
) -> Result<Value, String> {
    if input.query.trim().is_empty() || input.query.len() > 128 * 1024 {
        return Err("Invalid Linear GraphQL document.".to_string());
    }
    let file = read_workspace_file(&app)?;
    let workspace = resolve_workspace(&file, Some(&input.workspace_id))?;
    request_for_workspace(workspace, &input.query, input.variables).await
}

async fn request_for_workspace(
    workspace: &LinearWorkspace,
    query: &str,
    variables: Option<Value>,
) -> Result<Value, String> {
    let token = linear_entry(&workspace.id)?
        .get_password()
        .map_err(|error| format!("Linear credential could not be read: {error}"))?;
    graphql(&token, query, variables).await
}

async fn graphql(token: &str, query: &str, variables: Option<Value>) -> Result<Value, String> {
    let _permit = REQUEST_LIMIT
        .get_or_init(|| tokio::sync::Semaphore::new(4))
        .acquire()
        .await
        .map_err(|_| "Linear request queue is unavailable.".to_string())?;
    let response = reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build()
        .map_err(|error| format!("Could not create Linear client: {error}"))?
        .post(API_URL).bearer_auth(token).header("User-Agent", "Pebble")
        .json(&serde_json::json!({ "query": query, "variables": variables.unwrap_or_else(|| serde_json::json!({})) }))
        .send().await.map_err(|error| format!("Linear request failed: {error}"))?;
    let status = response.status();
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Could not read Linear response: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("Linear response exceeded the size limit.".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    let payload: Value = serde_json::from_slice(&bytes).map_err(|_| {
        format!(
            "Linear returned an invalid response (HTTP {}).",
            status.as_u16()
        )
    })?;
    if !status.is_success() {
        return Err(format!(
            "Linear request failed (HTTP {}): {}",
            status.as_u16(),
            graphql_error(&payload)
        ));
    }
    if payload
        .get("errors")
        .and_then(Value::as_array)
        .is_some_and(|errors| !errors.is_empty())
    {
        return Err(format!(
            "Linear provider error: {}",
            graphql_error(&payload)
        ));
    }
    payload
        .get("data")
        .cloned()
        .ok_or_else(|| "Linear response did not contain data.".to_string())
}

fn graphql_error(payload: &Value) -> String {
    payload
        .get("errors")
        .and_then(Value::as_array)
        .and_then(|errors| errors.first())
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("Unknown provider error")
        .to_string()
}

fn viewer_query() -> &'static str {
    "query PebbleLinearViewer { viewer { id name displayName email organization { id name urlKey } } }"
}

fn workspace_from_viewer(data: &Value) -> Result<LinearWorkspace, String> {
    let viewer = data
        .get("viewer")
        .ok_or_else(|| "Linear viewer was missing.".to_string())?;
    let organization = viewer
        .get("organization")
        .ok_or_else(|| "Linear organization was missing.".to_string())?;
    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let id = text(organization.get("id"));
    if id.is_empty() {
        return Err("Linear workspace ID was missing.".to_string());
    }
    Ok(LinearWorkspace {
        id,
        display_name: text(viewer.get("displayName")),
        email: viewer
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_string),
        organization_id: text(organization.get("id")),
        organization_name: text(organization.get("name")),
        organization_url_key: text(organization.get("urlKey")),
    })
}

fn resolve_workspace<'a>(
    file: &'a LinearWorkspaceFile,
    requested: Option<&str>,
) -> Result<&'a LinearWorkspace, String> {
    let id = requested
        .filter(|id| *id != "all")
        .or(file.active_workspace_id.as_deref())
        .ok_or_else(|| "Not connected to Linear.".to_string())?;
    file.workspaces
        .iter()
        .find(|workspace| workspace.id == id)
        .ok_or_else(|| "Linear workspace was not found.".to_string())
}

fn linear_entry(workspace_id: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, workspace_id).map_err(|error| error.to_string())
}

fn workspace_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("linear-workspaces.json"))
        .map_err(|error| error.to_string())
}

fn read_workspace_file(app: &tauri::AppHandle) -> Result<LinearWorkspaceFile, String> {
    let path = workspace_file_path(app)?;
    if !path.exists() {
        return Ok(LinearWorkspaceFile {
            version: 1,
            ..Default::default()
        });
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read Linear settings: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not parse Linear settings: {error}"))
}

fn write_workspace_file(app: &tauri::AppHandle, file: &LinearWorkspaceFile) -> Result<(), String> {
    let path = workspace_file_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(file).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| format!("Could not write Linear settings: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_viewer_organization_returned_by_linear() {
        let workspace = workspace_from_viewer(&serde_json::json!({
            "viewer": {
                "displayName": "Ada",
                "email": "ada@example.com",
                "organization": { "id": "org-1", "name": "Pebble", "urlKey": "pebble" }
            }
        }))
        .expect("workspace");

        assert_eq!(workspace.id, "org-1");
        assert_eq!(workspace.display_name, "Ada");
        assert_eq!(workspace.organization_name, "Pebble");
    }
}
