use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use keyring::Entry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::agent_accounts::read_keychain_password;

const MARKER_FILE: &str = ".pebble-managed-claude-auth";
const MANAGED_SERVICE: &str = "Pebble Claude Code Managed Credentials";
const ACTIVE_SERVICE: &str = "Claude Code-credentials";
const SYSTEM_SNAPSHOT_ACCOUNT: &str = "__pebble_system_default__";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedClaudeLoginLocation {
    managed_auth_path: String,
    managed_auth_runtime: String,
    wsl_distro: Option<String>,
    wsl_linux_auth_path: Option<String>,
    temporary_config_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedClaudeIdentity {
    email: String,
    auth_method: String,
    organization_uuid: Option<String>,
    organization_name: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemOauthSnapshot {
    captured: bool,
    oauth_account: Option<serde_json::Value>,
}

#[tauri::command]
pub fn managed_claude_account_prepare(
    app: tauri::AppHandle,
    account_id: String,
    runtime: Option<String>,
    wsl_distro: Option<String>,
) -> Result<ManagedClaudeLoginLocation, String> {
    validate_account_id(&account_id)?;
    if runtime.as_deref() == Some("wsl") {
        return prepare_wsl_account(&account_id, wsl_distro.as_deref());
    }
    let root = managed_root(&app)?;
    let auth = root.join(&account_id).join("auth");
    fs::create_dir_all(&auth).map_err(|err| format!("Could not create Claude auth home: {err}"))?;
    fs::write(auth.join(MARKER_FILE), format!("{account_id}\n"))
        .map_err(|err| format!("Could not mark Claude auth home: {err}"))?;
    let temporary = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("Could not resolve Pebble cache: {err}"))?
        .join("claude-login")
        .join(&account_id);
    if temporary.exists() {
        fs::remove_dir_all(&temporary)
            .map_err(|err| format!("Could not reset temporary Claude login: {err}"))?;
    }
    fs::create_dir_all(&temporary)
        .map_err(|err| format!("Could not create temporary Claude login: {err}"))?;
    Ok(ManagedClaudeLoginLocation {
        managed_auth_path: canonical_string(&auth)?,
        managed_auth_runtime: "host".to_string(),
        wsl_distro: None,
        wsl_linux_auth_path: None,
        temporary_config_path: canonical_string(&temporary)?,
    })
}

#[tauri::command]
pub fn managed_claude_account_capture(
    app: tauri::AppHandle,
    account_id: String,
    managed_auth_path: String,
    temporary_config_path: String,
    status_output: String,
    managed_auth_runtime: Option<String>,
    wsl_distro: Option<String>,
    wsl_linux_auth_path: Option<String>,
) -> Result<ManagedClaudeIdentity, String> {
    validate_account_id(&account_id)?;
    if managed_auth_runtime.as_deref() == Some("wsl") {
        return capture_wsl_account(
            &account_id,
            wsl_distro.as_deref(),
            wsl_linux_auth_path.as_deref(),
            &temporary_config_path,
            &status_output,
        );
    }
    let root = managed_root(&app)?;
    let auth = PathBuf::from(managed_auth_path);
    validate_owned_auth(&root, &auth, &account_id)?;
    let temporary = PathBuf::from(temporary_config_path);
    let credentials = read_temporary_credentials(&temporary)?;
    let oauth_account = read_oauth_account(&temporary);
    let identity = resolve_identity(&status_output, oauth_account.as_ref(), &credentials)?;
    managed_entry(&account_id)?
        .set_password(&credentials)
        .map_err(|err| format!("Could not store managed Claude credentials: {err}"))?;
    fs::write(
        auth.join("oauth-account.json"),
        serde_json::to_vec_pretty(&oauth_account).map_err(|err| err.to_string())?,
    )
    .map_err(|err| format!("Could not store Claude account metadata: {err}"))?;
    cleanup_temporary_login(&temporary);
    Ok(identity)
}

#[tauri::command]
pub fn managed_claude_account_activate(
    app: tauri::AppHandle,
    outgoing_account_id: Option<String>,
    account_id: Option<String>,
) -> Result<(), String> {
    if let Some(outgoing) = outgoing_account_id.as_deref() {
        validate_account_id(outgoing)?;
        if let Some(current) = read_active_credentials()? {
            managed_entry(outgoing)?
                .set_password(&current)
                .map_err(|err| format!("Could not preserve refreshed Claude credentials: {err}"))?;
        }
    }
    capture_system_snapshot_once(&app)?;
    match account_id {
        Some(account_id) => {
            validate_account_id(&account_id)?;
            let credentials = managed_entry(&account_id)?
                .get_password()
                .map_err(|_| "Managed Claude credentials are missing.".to_string())?;
            write_active_credentials(&credentials)?;
            materialize_oauth_account(&app, Some(&account_id))
        }
        None => restore_system_snapshot(&app),
    }
}

#[tauri::command]
pub fn managed_claude_account_remove(
    app: tauri::AppHandle,
    account_id: String,
    managed_auth_path: String,
    managed_auth_runtime: Option<String>,
    wsl_distro: Option<String>,
    wsl_linux_auth_path: Option<String>,
) -> Result<(), String> {
    validate_account_id(&account_id)?;
    if managed_auth_runtime.as_deref() == Some("wsl") {
        return remove_wsl_account(
            &account_id,
            wsl_distro.as_deref(),
            wsl_linux_auth_path.as_deref(),
        );
    }
    let root = managed_root(&app)?;
    let auth = PathBuf::from(managed_auth_path);
    validate_owned_auth(&root, &auth, &account_id)?;
    let account_dir = auth
        .parent()
        .ok_or_else(|| "Invalid Claude auth path.".to_string())?;
    fs::remove_dir_all(account_dir)
        .map_err(|err| format!("Could not remove managed Claude account: {err}"))?;
    let _ = managed_entry(&account_id)?.delete_credential();
    if let Ok(cache) = app.path().app_cache_dir() {
        cleanup_temporary_login(&cache.join("claude-login").join(&account_id));
    }
    Ok(())
}

fn prepare_wsl_account(
    account_id: &str,
    requested_distro: Option<&str>,
) -> Result<ManagedClaudeLoginLocation, String> {
    if !cfg!(target_os = "windows") {
        return Err("Managed Claude WSL accounts require Windows.".to_string());
    }
    let distro_args = requested_distro
        .filter(|value| !value.trim().is_empty())
        .map(|value| vec!["-d", value.trim()])
        .unwrap_or_default();
    let mut info_args = distro_args.clone();
    info_args.extend([
        "--exec",
        "bash",
        "-lc",
        "printf '%s\\n%s\\n' \"$WSL_DISTRO_NAME\" \"$HOME\"",
    ]);
    let info = run_wsl(&info_args)?;
    let mut lines = info.lines().map(str::trim).filter(|line| !line.is_empty());
    let detected_distro = lines.next().unwrap_or_default();
    let home = lines.next().unwrap_or_default();
    let distro = requested_distro
        .filter(|value| !value.trim().is_empty())
        .map(str::trim)
        .unwrap_or(detected_distro);
    if distro.is_empty() || !home.starts_with('/') {
        return Err(
            "Could not resolve the active WSL home directory for Claude login.".to_string(),
        );
    }
    let base = format!(
        "{}/.local/share/pebble/claude-accounts/{account_id}",
        home.trim_end_matches('/')
    );
    let auth = format!("{base}/auth");
    let temporary = format!("{base}/login");
    let script = format!(
        "set -euo pipefail; rm -rf {temporary}; mkdir -p {auth} {temporary}; printf '%s\\n' {id} > {marker}",
        temporary = shell_quote(&temporary),
        auth = shell_quote(&auth),
        id = shell_quote(account_id),
        marker = shell_quote(&format!("{auth}/{MARKER_FILE}")),
    );
    run_wsl(&["-d", distro, "--exec", "bash", "-lc", &script])?;
    Ok(ManagedClaudeLoginLocation {
        managed_auth_path: wsl_unc_path(distro, &auth),
        managed_auth_runtime: "wsl".to_string(),
        wsl_distro: Some(distro.to_string()),
        wsl_linux_auth_path: Some(auth),
        temporary_config_path: temporary,
    })
}

fn capture_wsl_account(
    account_id: &str,
    distro: Option<&str>,
    auth: Option<&str>,
    temporary: &str,
    status_output: &str,
) -> Result<ManagedClaudeIdentity, String> {
    if !cfg!(target_os = "windows") {
        return Err("Managed Claude WSL accounts require Windows.".to_string());
    }
    let distro = required_wsl_value(distro, "WSL distro")?;
    let auth = required_wsl_value(auth, "WSL auth path")?;
    validate_wsl_owned_path(account_id, distro, auth)?;
    let credentials = run_wsl(&[
        "-d",
        distro,
        "--exec",
        "bash",
        "-lc",
        &format!("cat -- {}/.credentials.json", shell_quote(temporary)),
    ])?;
    let oauth_raw = run_wsl(&[
        "-d", distro, "--exec", "bash", "-lc",
        &format!("for f in {0}/.claude.json {0}/.config.json; do test -f \"$f\" && cat -- \"$f\" && exit 0; done; printf '{{}}'", shell_quote(temporary)),
    ])?;
    let oauth_document: serde_json::Value = serde_json::from_str(&oauth_raw).unwrap_or_default();
    let oauth = oauth_document.get("oauthAccount").cloned();
    let identity = resolve_identity(status_output, oauth.as_ref(), &credentials)?;
    let script = format!(
        "set -euo pipefail; cp -- {temp}/.credentials.json {auth}/.credentials.json; chmod 600 {auth}/.credentials.json; printf '%s' {oauth} > {auth}/oauth-account.json; chmod 600 {auth}/oauth-account.json; rm -rf {temp}",
        temp = shell_quote(temporary), auth = shell_quote(auth),
        oauth = shell_quote(&serde_json::to_string_pretty(&oauth).map_err(|err| err.to_string())?),
    );
    run_wsl(&["-d", distro, "--exec", "bash", "-lc", &script])?;
    Ok(identity)
}

fn remove_wsl_account(
    account_id: &str,
    distro: Option<&str>,
    auth: Option<&str>,
) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("Managed Claude WSL accounts require Windows.".to_string());
    }
    let distro = required_wsl_value(distro, "WSL distro")?;
    let auth = required_wsl_value(auth, "WSL auth path")?;
    validate_wsl_owned_path(account_id, distro, auth)?;
    let parent = auth
        .strip_suffix("/auth")
        .ok_or_else(|| "Invalid managed WSL Claude auth path.".to_string())?;
    run_wsl(&[
        "-d",
        distro,
        "--exec",
        "bash",
        "-lc",
        &format!("rm -rf -- {}", shell_quote(parent)),
    ])?;
    Ok(())
}

pub(crate) fn validate_wsl_owned_path(
    account_id: &str,
    distro: &str,
    auth: &str,
) -> Result<(), String> {
    let expected_suffix = format!("/.local/share/pebble/claude-accounts/{account_id}/auth");
    if !auth.starts_with('/') || !auth.ends_with(&expected_suffix) {
        return Err(
            "Managed WSL Claude auth storage is outside Pebble account storage.".to_string(),
        );
    }
    let script = format!(
        "set -euo pipefail; candidate=$(readlink -f -- {auth}); root=$(readlink -f -- \"$HOME/.local/share/pebble/claude-accounts\"); test \"$candidate\" = \"$root/{id}/auth\"; test \"$(cat -- \"$candidate/{marker}\")\" = {id}",
        auth = shell_quote(auth), id = shell_quote(account_id), marker = MARKER_FILE,
    );
    run_wsl(&["-d", distro, "--exec", "bash", "-lc", &script]).map(|_| ())
}

fn run_wsl(args: &[&str]) -> Result<String, String> {
    let output = Command::new("wsl.exe")
        .args(args)
        .output()
        .map_err(|err| format!("Could not run WSL: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "WSL Claude account operation failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).replace('\0', ""))
}

fn required_wsl_value<'a>(value: Option<&'a str>, label: &str) -> Result<&'a str, String> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Managed Claude {label} is missing."))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn wsl_unc_path(distro: &str, linux_path: &str) -> String {
    format!(
        r"\\wsl.localhost\{}\{}",
        distro,
        linux_path.trim_start_matches('/').replace('/', "\\")
    )
}

fn managed_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("claude-accounts");
    fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    fs::canonicalize(root).map_err(|err| err.to_string())
}

fn managed_entry(account_id: &str) -> Result<Entry, String> {
    Entry::new(MANAGED_SERVICE, account_id).map_err(|err| err.to_string())
}

pub(crate) fn read_managed_claude_credentials(account_id: &str) -> Result<String, String> {
    validate_account_id(account_id)?;
    managed_entry(account_id)?
        .get_password()
        .map_err(|_| "Managed Claude credentials are missing.".to_string())
}

fn validate_account_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid managed Claude account id.".to_string());
    }
    Ok(())
}

fn validate_owned_auth(root: &Path, auth: &Path, account_id: &str) -> Result<(), String> {
    let canonical =
        fs::canonicalize(auth).map_err(|_| "Managed Claude auth path is missing.".to_string())?;
    if !canonical.starts_with(root)
        || canonical.file_name().and_then(|v| v.to_str()) != Some("auth")
        || canonical
            .parent()
            .and_then(Path::file_name)
            .and_then(|v| v.to_str())
            != Some(account_id)
    {
        return Err("Managed Claude auth path is outside Pebble storage.".to_string());
    }
    let marker = fs::read_to_string(canonical.join(MARKER_FILE))
        .map_err(|_| "Managed Claude auth marker is missing.".to_string())?;
    if marker.trim() != account_id {
        return Err("Managed Claude auth marker does not match the account.".to_string());
    }
    Ok(())
}

fn read_temporary_credentials(config: &Path) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(path) = config.to_str() {
            let digest = Sha256::digest(path.as_bytes());
            let suffix: String = digest[..4]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            if let Some(value) = read_keychain_password(&format!("{ACTIVE_SERVICE}-{suffix}"))? {
                return Ok(value);
            }
        }
    }
    fs::read_to_string(config.join(".credentials.json"))
        .map_err(|_| "Claude login completed, but no OAuth credentials were captured.".to_string())
}

fn read_oauth_account(config: &Path) -> Option<serde_json::Value> {
    for name in [".claude.json", ".config.json"] {
        if let Ok(raw) = fs::read(config.join(name)) {
            if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&raw) {
                if let Some(value) = parsed.get("oauthAccount") {
                    return Some(value.clone());
                }
            }
        }
    }
    None
}

fn resolve_identity(
    status: &str,
    oauth: Option<&serde_json::Value>,
    credentials: &str,
) -> Result<ManagedClaudeIdentity, String> {
    let status: serde_json::Value = serde_json::from_str(status).unwrap_or_default();
    let credentials: serde_json::Value = serde_json::from_str(credentials).unwrap_or_default();
    let credential_oauth = credentials.get("claudeAiOauth");
    let field = |source: Option<&serde_json::Value>, keys: &[&str]| {
        keys.iter()
            .find_map(|key| source.and_then(|value| value.get(key)))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    // Resolve aliases within each source before falling back so authoritative
    // OAuth metadata cannot be shadowed by a lower-priority credential field.
    let email = field(Some(&status), &["email", "emailAddress"])
        .or_else(|| field(oauth, &["email", "emailAddress"]))
        .or_else(|| field(credential_oauth, &["email", "emailAddress"]))
        .ok_or_else(|| {
            "Claude login completed, but Pebble could not resolve the account email.".to_string()
        })?;
    let metadata_field = |keys: &[&str]| {
        field(Some(&status), keys)
            .or_else(|| field(oauth, keys))
            .or_else(|| field(credential_oauth, keys))
    };
    Ok(ManagedClaudeIdentity {
        email,
        auth_method: "subscription-oauth".to_string(),
        organization_uuid: metadata_field(&["organizationUuid", "organizationId"]),
        organization_name: metadata_field(&["organizationName"]),
    })
}

fn active_config_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|home| home.join(".claude"))
        .ok_or_else(|| "Could not resolve Claude config directory.".to_string())
}

fn read_active_credentials() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    if let Some(value) = read_keychain_password(ACTIVE_SERVICE)? {
        return Ok(Some(value));
    }
    Ok(fs::read_to_string(active_config_dir()?.join(".credentials.json")).ok())
}

fn write_active_credentials(contents: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        write_security_password(ACTIVE_SERVICE, contents)?;
        let config = active_config_dir()?;
        let digest = Sha256::digest(config.to_string_lossy().as_bytes());
        let suffix: String = digest[..4]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        write_security_password(&format!("{ACTIVE_SERVICE}-{suffix}"), contents)?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let path = active_config_dir()?.join(".credentials.json");
        fs::create_dir_all(path.parent().unwrap()).map_err(|err| err.to_string())?;
        fs::write(path, contents).map_err(|err| err.to_string())
    }
}

#[cfg(target_os = "macos")]
fn write_security_password(service: &str, contents: &str) -> Result<(), String> {
    let user = std::env::var("USER").unwrap_or_else(|_| "user".to_string());
    let status = Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            service,
            "-a",
            &user,
            "-w",
            contents,
        ])
        .status()
        .map_err(|err| err.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not write Claude Keychain credentials.".to_string())
    }
}

fn capture_system_snapshot_once(app: &tauri::AppHandle) -> Result<(), String> {
    let entry = managed_entry(SYSTEM_SNAPSHOT_ACCOUNT)?;
    if entry.get_password().is_ok() {
        return Ok(());
    }
    entry
        .set_password(
            &serde_json::to_string(&read_active_credentials()?).map_err(|err| err.to_string())?,
        )
        .map_err(|err| err.to_string())?;
    let config = read_shared_claude_json();
    let snapshot = SystemOauthSnapshot {
        captured: true,
        oauth_account: config.get("oauthAccount").cloned(),
    };
    write_snapshot_metadata(app, &snapshot)
}

fn restore_system_snapshot(app: &tauri::AppHandle) -> Result<(), String> {
    let raw = managed_entry(SYSTEM_SNAPSHOT_ACCOUNT)?
        .get_password()
        .map_err(|_| "Claude system credential snapshot is missing.".to_string())?;
    let credentials: Option<String> = serde_json::from_str(&raw).map_err(|err| err.to_string())?;
    match credentials {
        Some(credentials) => write_active_credentials(&credentials)?,
        None => delete_active_credentials()?,
    }
    let snapshot = read_snapshot_metadata(app)?;
    write_shared_oauth_account(snapshot.oauth_account.as_ref())
}

fn delete_active_credentials() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let user = std::env::var("USER").unwrap_or_else(|_| "user".to_string());
        for service in [ACTIVE_SERVICE.to_string(), {
            let config = active_config_dir()?;
            let digest = Sha256::digest(config.to_string_lossy().as_bytes());
            let suffix: String = digest[..4]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            format!("{ACTIVE_SERVICE}-{suffix}")
        }] {
            let _ = Command::new("security")
                .args(["delete-generic-password", "-s", &service, "-a", &user])
                .status();
        }
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = fs::remove_file(active_config_dir()?.join(".credentials.json"));
        Ok(())
    }
}

fn materialize_oauth_account(
    app: &tauri::AppHandle,
    account_id: Option<&str>,
) -> Result<(), String> {
    let value = account_id.and_then(|id| {
        let root = managed_root(app).ok()?;
        serde_json::from_slice(
            &fs::read(root.join(id).join("auth").join("oauth-account.json")).ok()?,
        )
        .ok()
    });
    write_shared_oauth_account(value.as_ref())
}

fn read_shared_claude_json() -> serde_json::Value {
    let path = active_config_dir()
        .ok()
        .and_then(|dir| dir.parent().map(|p| p.join(".claude.json")));
    path.and_then(|path| fs::read(path).ok())
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn write_shared_oauth_account(value: Option<&serde_json::Value>) -> Result<(), String> {
    let home = active_config_dir()?.parent().unwrap().to_path_buf();
    let path = home.join(".claude.json");
    let mut document = read_shared_claude_json();
    let object = document
        .as_object_mut()
        .ok_or_else(|| "Claude settings are not an object.".to_string())?;
    match value {
        Some(value) => {
            object.insert("oauthAccount".to_string(), value.clone());
        }
        None => {
            object.remove("oauthAccount");
        }
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(&document).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())
}

fn snapshot_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("claude-system-oauth-snapshot.json"))
}
fn write_snapshot_metadata(
    app: &tauri::AppHandle,
    value: &SystemOauthSnapshot,
) -> Result<(), String> {
    let path = snapshot_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_vec(value).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())
}
fn read_snapshot_metadata(app: &tauri::AppHandle) -> Result<SystemOauthSnapshot, String> {
    serde_json::from_slice(&fs::read(snapshot_path(app)?).map_err(|err| err.to_string())?)
        .map_err(|err| err.to_string())
}

fn cleanup_temporary_login(path: &Path) {
    #[cfg(target_os = "macos")]
    if let Some(path) = path.to_str() {
        let digest = Sha256::digest(path.as_bytes());
        let suffix: String = digest[..4]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let user = std::env::var("USER").unwrap_or_else(|_| "user".to_string());
        let _ = Command::new("security")
            .args([
                "delete-generic-password",
                "-s",
                &format!("{ACTIVE_SERVICE}-{suffix}"),
                "-a",
                &user,
            ])
            .status();
    }
    let _ = fs::remove_dir_all(path);
}

fn canonical_string(path: &Path) -> Result<String, String> {
    fs::canonicalize(path)
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_claude_identity_across_status_and_oauth_metadata() {
        let credentials = serde_json::json!({
            "claudeAiOauth": { "email": "credential@example.com" }
        })
        .to_string();
        let oauth = serde_json::json!({
            "emailAddress": "oauth@example.com",
            "organizationUuid": "org-1",
            "organizationName": "Pebble Team"
        });
        let identity = resolve_identity("{}", Some(&oauth), &credentials).unwrap();
        assert_eq!(identity.email, "oauth@example.com");
        assert_eq!(identity.organization_uuid.as_deref(), Some("org-1"));
        assert_eq!(identity.organization_name.as_deref(), Some("Pebble Team"));
    }

    #[test]
    fn owned_auth_requires_exact_account_shape_and_marker() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("claude-accounts");
        let auth = root.join("account-1").join("auth");
        fs::create_dir_all(&auth).unwrap();
        fs::write(auth.join(MARKER_FILE), "account-1\n").unwrap();
        let canonical_root = fs::canonicalize(root).unwrap();
        assert!(validate_owned_auth(&canonical_root, &auth, "account-1").is_ok());
        assert!(validate_owned_auth(&canonical_root, &auth, "account-2").is_err());
    }

    #[test]
    fn rejects_path_shaped_account_ids() {
        assert!(validate_account_id("account-1").is_ok());
        assert!(validate_account_id("../account-1").is_err());
        assert!(validate_account_id("account/1").is_err());
    }
}
