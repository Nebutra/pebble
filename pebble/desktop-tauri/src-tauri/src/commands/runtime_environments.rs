#[cfg(windows)]
use std::{env, process::Command};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
    Engine as _,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

use super::remote_runtime_rpc::{call_remote_runtime, RemoteRuntimePairing};

const ENVIRONMENTS_FILE: &str = "pebble-environments.json";
const PAIRING_OFFER_VERSION: u8 = 2;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEnvironmentAddInput {
    name: String,
    pairing_code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEnvironmentSelectorInput {
    selector: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEnvironmentCallInput {
    selector: String,
    method: String,
    #[serde(default)]
    params: Option<Value>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEnvironmentResult {
    environment: PublicKnownRuntimeEnvironment,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEnvironmentRemovedResult {
    removed: PublicKnownRuntimeEnvironment,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEnvironmentDisconnectedResult {
    disconnected: PublicKnownRuntimeEnvironment,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeEnvironmentStore {
    version: u8,
    environments: Vec<KnownRuntimeEnvironment>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct KnownRuntimeEnvironment {
    id: String,
    name: String,
    created_at: u64,
    updated_at: u64,
    last_used_at: Option<u64>,
    runtime_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    endpoints: Vec<RuntimeAccessEndpoint>,
    preferred_endpoint_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeAccessEndpoint {
    id: String,
    kind: String,
    label: String,
    endpoint: String,
    device_token: String,
    public_key_b64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicKnownRuntimeEnvironment {
    id: String,
    name: String,
    created_at: u64,
    updated_at: u64,
    last_used_at: Option<u64>,
    runtime_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    endpoints: Vec<PublicRuntimeAccessEndpoint>,
    preferred_endpoint_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicRuntimeAccessEndpoint {
    id: String,
    kind: String,
    label: String,
    endpoint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingOffer {
    v: u8,
    endpoint: String,
    device_token: String,
    public_key_b64: String,
}

#[tauri::command]
pub fn runtime_environments_list(
    app: tauri::AppHandle,
) -> Result<Vec<PublicKnownRuntimeEnvironment>, String> {
    Ok(read_store(&environment_store_path(&app)?)?
        .environments
        .iter()
        .map(redact_environment)
        .collect())
}

#[tauri::command]
pub fn runtime_environments_add_from_pairing_code(
    app: tauri::AppHandle,
    input: RuntimeEnvironmentAddInput,
) -> Result<RuntimeEnvironmentResult, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Server name is required.".to_string());
    }

    let mut store = read_store(&environment_store_path(&app)?)?;
    if store
        .environments
        .iter()
        .any(|environment| environment.name == name)
    {
        return Err(format!("A server named \"{name}\" already exists."));
    }

    let offer = parse_pairing_code(&input.pairing_code)?;
    let id = create_environment_id(&store.environments);
    let now = current_time_millis();
    let environment = create_environment_from_pairing_offer(id, name.to_string(), now, offer);
    store.environments.push(environment.clone());
    sort_environments(&mut store);
    write_store(&environment_store_path(&app)?, &store)?;
    Ok(RuntimeEnvironmentResult {
        environment: redact_environment(&environment),
    })
}

#[tauri::command]
pub fn runtime_environments_resolve(
    app: tauri::AppHandle,
    input: RuntimeEnvironmentSelectorInput,
) -> Result<PublicKnownRuntimeEnvironment, String> {
    let store = read_store(&environment_store_path(&app)?)?;
    Ok(redact_environment(resolve_environment(
        &store,
        input.selector.trim(),
    )?))
}

#[tauri::command]
pub fn runtime_environments_remove(
    app: tauri::AppHandle,
    input: RuntimeEnvironmentSelectorInput,
) -> Result<RuntimeEnvironmentRemovedResult, String> {
    let path = environment_store_path(&app)?;
    let mut store = read_store(&path)?;
    let removed = resolve_environment(&store, input.selector.trim())?.clone();
    store
        .environments
        .retain(|environment| environment.id != removed.id);
    write_store(&path, &store)?;
    Ok(RuntimeEnvironmentRemovedResult {
        removed: redact_environment(&removed),
    })
}

#[tauri::command]
pub fn runtime_environments_disconnect(
    app: tauri::AppHandle,
    input: RuntimeEnvironmentSelectorInput,
) -> Result<RuntimeEnvironmentDisconnectedResult, String> {
    let store = read_store(&environment_store_path(&app)?)?;
    let environment = resolve_environment(&store, input.selector.trim())?;
    Ok(RuntimeEnvironmentDisconnectedResult {
        disconnected: redact_environment(environment),
    })
}

#[tauri::command]
pub async fn runtime_environments_call(
    app: tauri::AppHandle,
    input: RuntimeEnvironmentCallInput,
) -> Result<Value, String> {
    let method = input.method.trim();
    if method.is_empty() {
        return Err("Runtime method is required.".to_string());
    }
    let pairing = runtime_environment_pairing_for_selector(&app, input.selector.trim())?;
    call_remote_runtime(
        pairing,
        method.to_string(),
        input.params,
        input.timeout_ms.unwrap_or(15_000),
    )
    .await
}

fn environment_store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve Pebble app data directory: {error}"))?
        .join(ENVIRONMENTS_FILE))
}

fn read_store(path: &Path) -> Result<RuntimeEnvironmentStore, String> {
    if !path.exists() {
        return Ok(empty_store());
    }
    harden_existing_secure_path(path);
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Could not read Pebble environments: {error}"))?;
    let store: RuntimeEnvironmentStore = serde_json::from_str(&contents)
        .map_err(|error| format!("Could not parse Pebble environments: {error}"))?;
    if store.version != 1 {
        return Err(format!(
            "Unsupported Pebble environments version: {}",
            store.version
        ));
    }
    Ok(RuntimeEnvironmentStore {
        version: 1,
        environments: sorted_environments(store.environments),
    })
}

fn write_store(path: &Path, store: &RuntimeEnvironmentStore) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve Pebble environment store directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Pebble environment store directory: {error}"))?;
    harden_secure_path(parent, true);

    let tmp_path = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        current_time_millis()
    ));
    let contents = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("Could not serialize Pebble environments: {error}"))?;

    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options
        .open(&tmp_path)
        .map_err(|error| format!("Could not create Pebble environment store temp file: {error}"))?;
    file.write_all(&contents)
        .map_err(|error| format!("Could not write Pebble environments: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not flush Pebble environments: {error}"))?;
    harden_secure_path(&tmp_path, false);
    fs::rename(&tmp_path, path)
        .map_err(|error| format!("Could not publish Pebble environments: {error}"))?;
    harden_secure_path(path, false);
    Ok(())
}

fn empty_store() -> RuntimeEnvironmentStore {
    RuntimeEnvironmentStore {
        version: 1,
        environments: Vec::new(),
    }
}

fn create_environment_from_pairing_offer(
    id: String,
    name: String,
    now: u64,
    offer: PairingOffer,
) -> KnownRuntimeEnvironment {
    let endpoint_id = format!("ws-{id}");
    KnownRuntimeEnvironment {
        id,
        name,
        created_at: now,
        updated_at: now,
        last_used_at: None,
        runtime_id: None,
        source: None,
        endpoints: vec![RuntimeAccessEndpoint {
            id: endpoint_id.clone(),
            kind: "websocket".to_string(),
            label: "WebSocket".to_string(),
            endpoint: offer.endpoint,
            device_token: offer.device_token,
            public_key_b64: offer.public_key_b64,
        }],
        preferred_endpoint_id: endpoint_id,
    }
}

fn parse_pairing_code(input: &str) -> Result<PairingOffer, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(
            "Invalid pairing code. Expected an pebble://pair?... URL or bare pairing payload."
                .to_string(),
        );
    }
    let payload = if trimmed.to_ascii_lowercase().starts_with("pebble://") {
        extract_pairing_code_from_url(trimmed).ok_or_else(|| {
            "Invalid pairing URL: must start with pebble://pair and include a pairing code."
                .to_string()
        })?
    } else {
        trimmed.to_string()
    };
    decode_pairing_payload(&payload)
}

fn extract_pairing_code_from_url(url: &str) -> Option<String> {
    let without_scheme = url.get("pebble://".len()..)?;
    let host_end = without_scheme
        .find(['/', '?', '#'])
        .unwrap_or(without_scheme.len());
    if without_scheme.get(..host_end)?.to_ascii_lowercase() != "pair" {
        return None;
    }
    let mut rest = without_scheme.get(host_end..)?.trim();
    if rest.starts_with('/') {
        rest = rest.get(1..)?;
        if !rest.is_empty() && !rest.starts_with(['?', '#']) {
            return None;
        }
    }

    let (before_hash, hash) = rest
        .split_once('#')
        .map_or((rest, ""), |(prefix, suffix)| (prefix, suffix));
    if let Some(query) = before_hash.strip_prefix('?') {
        for pair in query.split('&') {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            if key == "code" && !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    if hash.is_empty() {
        None
    } else {
        Some(hash.to_string())
    }
}

fn decode_pairing_payload(payload: &str) -> Result<PairingOffer, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| URL_SAFE.decode(payload))
        .map_err(|_| "Invalid pairing payload encoding.".to_string())?;
    let mut offer: PairingOffer =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid pairing payload JSON.".to_string())?;
    if offer.v != PAIRING_OFFER_VERSION
        || offer.endpoint.trim().is_empty()
        || offer.device_token.trim().is_empty()
        || offer.public_key_b64.trim().is_empty()
    {
        return Err("Invalid pairing payload.".to_string());
    }
    offer.endpoint = normalize_websocket_endpoint(&offer.endpoint);
    Ok(offer)
}

fn normalize_websocket_endpoint(endpoint: &str) -> String {
    if let Some(rest) = endpoint.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if let Some(rest) = endpoint.strip_prefix("https://") {
        format!("wss://{rest}")
    } else {
        endpoint.to_string()
    }
}

fn resolve_environment<'a>(
    store: &'a RuntimeEnvironmentStore,
    selector: &str,
) -> Result<&'a KnownRuntimeEnvironment, String> {
    if let Some(environment) = store
        .environments
        .iter()
        .find(|environment| environment.id == selector)
    {
        return Ok(environment);
    }
    let matches: Vec<_> = store
        .environments
        .iter()
        .filter(|environment| environment.name == selector)
        .collect();
    match matches.len() {
        1 => Ok(matches[0]),
        0 => Err(format!("Unknown environment: {selector}")),
        _ => Err(format!(
            "Environment name \"{selector}\" is ambiguous; use the environment id."
        )),
    }
}

fn runtime_environment_pairing_for_selector(
    app: &tauri::AppHandle,
    selector: &str,
) -> Result<RemoteRuntimePairing, String> {
    let store = read_store(&environment_store_path(app)?)?;
    let environment = resolve_environment(&store, selector)?;
    let endpoint = environment
        .endpoints
        .iter()
        .find(|endpoint| endpoint.id == environment.preferred_endpoint_id)
        .or_else(|| {
            environment
                .endpoints
                .iter()
                .find(|endpoint| endpoint.kind == "websocket")
        })
        .ok_or_else(|| "Runtime environment has no WebSocket endpoint.".to_string())?;
    Ok(RemoteRuntimePairing {
        endpoint: endpoint.endpoint.clone(),
        device_token: endpoint.device_token.clone(),
        public_key_b64: endpoint.public_key_b64.clone(),
    })
}

fn redact_environment(environment: &KnownRuntimeEnvironment) -> PublicKnownRuntimeEnvironment {
    PublicKnownRuntimeEnvironment {
        id: environment.id.clone(),
        name: environment.name.clone(),
        created_at: environment.created_at,
        updated_at: environment.updated_at,
        last_used_at: environment.last_used_at,
        runtime_id: environment.runtime_id.clone(),
        source: environment.source.clone(),
        endpoints: environment
            .endpoints
            .iter()
            .map(|endpoint| PublicRuntimeAccessEndpoint {
                id: endpoint.id.clone(),
                kind: endpoint.kind.clone(),
                label: endpoint.label.clone(),
                endpoint: endpoint.endpoint.clone(),
            })
            .collect(),
        preferred_endpoint_id: environment.preferred_endpoint_id.clone(),
    }
}

fn create_environment_id(existing: &[KnownRuntimeEnvironment]) -> String {
    for attempt in 0..1000_u16 {
        let id = format!(
            "runtime-{:x}-{:x}-{attempt:x}",
            current_time_millis(),
            std::process::id()
        );
        if !existing.iter().any(|environment| environment.id == id) {
            return id;
        }
    }
    format!("runtime-{:x}-{:x}", current_time_millis(), existing.len())
}

fn sorted_environments(
    mut environments: Vec<KnownRuntimeEnvironment>,
) -> Vec<KnownRuntimeEnvironment> {
    environments.sort_by(|a, b| a.name.cmp(&b.name));
    environments
}

fn sort_environments(store: &mut RuntimeEnvironmentStore) {
    store.environments.sort_by(|a, b| a.name.cmp(&b.name));
}

fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn harden_existing_secure_path(path: &Path) {
    if let Some(parent) = path.parent() {
        harden_secure_path(parent, true);
    }
    harden_secure_path(path, false);
}

fn harden_secure_path(path: &Path, is_directory: bool) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if is_directory { 0o700 } else { 0o600 };
        if let Ok(metadata) = fs::metadata(path) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(mode);
            let _ = fs::set_permissions(path, permissions);
        }
    }

    #[cfg(windows)]
    {
        restrict_windows_path_acl(path, is_directory);
    }
}

#[cfg(windows)]
fn restrict_windows_path_acl(path: &Path, is_directory: bool) {
    let Some(current_user_sid) = get_current_windows_user_sid() else {
        return;
    };
    let powershell = windows_system32_path("WindowsPowerShell\\v1.0\\powershell.exe");
    let _ = Command::new(powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            WINDOWS_RESTRICT_ACL_SCRIPT,
            "--",
            &path.to_string_lossy(),
            &current_user_sid,
            if is_directory { "1" } else { "0" },
        ])
        .status();
}

#[cfg(windows)]
fn get_current_windows_user_sid() -> Option<String> {
    let output = Command::new(windows_system32_path("whoami.exe"))
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8(output.stdout).ok()?;
    parse_csv_line(line.trim()).get(1).cloned()
}

#[cfg(windows)]
fn windows_system32_path(relative_path: &str) -> PathBuf {
    let root = env::var("SystemRoot")
        .or_else(|_| env::var("WINDIR"))
        .unwrap_or_else(|_| "C:\\Windows".to_string());
    PathBuf::from(root).join("System32").join(relative_path)
}

#[cfg(windows)]
fn parse_csv_line(line: &str) -> Vec<String> {
    line.split("\",\"")
        .map(|part| part.trim_matches('"').to_string())
        .collect()
}

#[cfg(windows)]
const WINDOWS_RESTRICT_ACL_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$path = $args[0]
$currentUserSid = $args[1]
$isDirectory = $args[2] -eq '1'
$allowedSidTexts = @($currentUserSid, 'S-1-5-18', 'S-1-5-32-544')
$allowedSids = @{}
foreach ($sidText in $allowedSidTexts) {
  $allowedSids[$sidText] = $true
}
$acl = Get-Acl -LiteralPath $path
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) {
  [void]$acl.RemoveAccessRuleSpecific($rule)
}
$inheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::None
if ($isDirectory) {
  $inheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
}
foreach ($sidText in $allowedSidTexts) {
  $sid = [System.Security.Principal.SecurityIdentifier]::new($sidText)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritanceFlags,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $path -AclObject $acl
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pairing_url_and_normalizes_https_endpoint() {
        let payload = r#"{"v":2,"endpoint":"https://runtime.example.com","deviceToken":"token","publicKeyB64":"key"}"#;
        let code = URL_SAFE_NO_PAD.encode(payload.as_bytes());
        let offer = parse_pairing_code(&format!("pebble://pair?code={code}")).unwrap();
        assert_eq!(offer.endpoint, "wss://runtime.example.com");
        assert_eq!(offer.device_token, "token");
    }

    #[test]
    fn rejects_non_pairing_deep_link_hosts() {
        let payload = r#"{"v":2,"endpoint":"ws://runtime.example.com","deviceToken":"token","publicKeyB64":"key"}"#;
        let code = URL_SAFE_NO_PAD.encode(payload.as_bytes());
        assert!(parse_pairing_code(&format!("pebble://pairing?code={code}")).is_err());
    }

    #[test]
    fn redacts_runtime_environment_secrets() {
        let environment = create_environment_from_pairing_offer(
            "env-1".to_string(),
            "Runtime".to_string(),
            1000,
            PairingOffer {
                v: 2,
                endpoint: "ws://runtime.example.com".to_string(),
                device_token: "secret-token".to_string(),
                public_key_b64: "secret-key".to_string(),
            },
        );
        let public = serde_json::to_value(redact_environment(&environment)).unwrap();
        assert_eq!(
            public["endpoints"][0]["endpoint"],
            "ws://runtime.example.com"
        );
        assert!(public["endpoints"][0].get("deviceToken").is_none());
        assert!(public["endpoints"][0].get("publicKeyB64").is_none());
    }
}
