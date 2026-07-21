use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use super::agent_accounts::{read_codex_auth_status_at, CodexAuthStatus};

const MARKER_FILE: &str = ".pebble-managed-home";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCodexHome {
    managed_home_path: String,
    managed_home_runtime: String,
    wsl_distro: Option<String>,
    wsl_linux_home_path: Option<String>,
}

#[tauri::command]
pub fn managed_codex_account_prepare(
    app: tauri::AppHandle,
    account_id: String,
    recreate: bool,
    runtime: Option<String>,
    wsl_distro: Option<String>,
) -> Result<ManagedCodexHome, String> {
    validate_account_id(&account_id)?;
    if runtime.as_deref() == Some("wsl") {
        return prepare_wsl_home(&account_id, wsl_distro.as_deref());
    }
    let root = managed_root(&app)?;
    let home = root.join(&account_id).join("home");
    if home.exists() {
        validate_owned_home(&root, &home, &account_id)?;
    } else {
        if !recreate && root.join(&account_id).exists() {
            return Err("Managed Codex account directory is incomplete.".to_string());
        }
        fs::create_dir_all(&home).map_err(|err| format!("Could not create Codex home: {err}"))?;
        fs::write(home.join(MARKER_FILE), format!("{account_id}\n"))
            .map_err(|err| format!("Could not mark Codex home: {err}"))?;
    }
    copy_canonical_config(&home)?;
    Ok(ManagedCodexHome {
        managed_home_path: canonical_string(&home)?,
        managed_home_runtime: "host".to_string(),
        wsl_distro: None,
        wsl_linux_home_path: None,
    })
}

#[tauri::command]
pub fn managed_codex_account_identity(
    app: tauri::AppHandle,
    account_id: String,
    managed_home_path: String,
    managed_home_runtime: Option<String>,
    wsl_distro: Option<String>,
    wsl_linux_home_path: Option<String>,
) -> Result<CodexAuthStatus, String> {
    validate_account_id(&account_id)?;
    if managed_home_runtime.as_deref() == Some("wsl") {
        validate_wsl_home(
            &account_id,
            wsl_distro.as_deref(),
            wsl_linux_home_path.as_deref(),
        )?;
        return require_authenticated_identity(read_codex_auth_status_at(Path::new(
            &managed_home_path,
        )));
    }
    let root = managed_root(&app)?;
    let home = PathBuf::from(managed_home_path);
    validate_owned_home(&root, &home, &account_id)?;
    require_authenticated_identity(read_codex_auth_status_at(&home))
}

fn require_authenticated_identity(status: CodexAuthStatus) -> Result<CodexAuthStatus, String> {
    if !status.authenticated || status.email.as_deref().unwrap_or("").trim().is_empty() {
        return Err(
            "Codex login completed, but Pebble could not resolve the account email.".into(),
        );
    }
    Ok(status)
}

#[tauri::command]
pub fn managed_codex_account_remove(
    app: tauri::AppHandle,
    account_id: String,
    managed_home_path: String,
    managed_home_runtime: Option<String>,
    wsl_distro: Option<String>,
    wsl_linux_home_path: Option<String>,
) -> Result<(), String> {
    validate_account_id(&account_id)?;
    if managed_home_runtime.as_deref() == Some("wsl") {
        return remove_wsl_home(
            &account_id,
            wsl_distro.as_deref(),
            wsl_linux_home_path.as_deref(),
        );
    }
    let root = managed_root(&app)?;
    let home = PathBuf::from(managed_home_path);
    validate_owned_home(&root, &home, &account_id)?;
    let account_dir = home
        .parent()
        .ok_or_else(|| "Managed Codex home has no account directory.".to_string())?;
    fs::remove_dir_all(account_dir)
        .map_err(|err| format!("Could not remove managed Codex account: {err}"))
}

#[cfg(target_os = "windows")]
fn prepare_wsl_home(account_id: &str, distro: Option<&str>) -> Result<ManagedCodexHome, String> {
    let distro = distro.map(str::trim).filter(|value| !value.is_empty());
    let mut args = Vec::new();
    if let Some(distro) = distro {
        args.extend(["-d".to_string(), distro.to_string()]);
    }
    let script = format!(
        "set -euo pipefail; root=\"$HOME/.local/share/pebble/codex-accounts\"; home=\"$root/{account_id}/home\"; mkdir -p -- \"$home\"; printf '%s\\n' '{account_id}' > \"$home/{MARKER_FILE}\"; printf '%s\\n%s\\n%s\\n' \"$WSL_DISTRO_NAME\" \"$HOME\" \"$home\""
    );
    args.extend([
        "--".to_string(),
        "bash".to_string(),
        "-lc".to_string(),
        script,
    ]);
    let output = std::process::Command::new("wsl.exe")
        .args(args)
        .output()
        .map_err(|err| format!("Could not start WSL for Codex account: {err}"))?;
    if !output.status.success() {
        return Err("Could not create the managed Codex home inside WSL.".to_string());
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| "WSL returned a non-UTF-8 home path.".to_string())?;
    let mut lines = stdout.lines();
    let resolved_distro = lines.next().unwrap_or("").trim();
    let _linux_user_home = lines.next().unwrap_or("").trim();
    let linux_home = lines.next().unwrap_or("").trim();
    if resolved_distro.is_empty() || !linux_home.starts_with('/') {
        return Err("Could not resolve the managed Codex WSL home.".to_string());
    }
    let unc = format!(
        r"\\wsl.localhost\{}{}",
        resolved_distro,
        linux_home.replace('/', r"\")
    );
    Ok(ManagedCodexHome {
        managed_home_path: unc,
        managed_home_runtime: "wsl".to_string(),
        wsl_distro: Some(resolved_distro.to_string()),
        wsl_linux_home_path: Some(linux_home.to_string()),
    })
}

#[cfg(not(target_os = "windows"))]
fn prepare_wsl_home(_account_id: &str, _distro: Option<&str>) -> Result<ManagedCodexHome, String> {
    Err("Managed Codex WSL accounts are only available on Windows.".to_string())
}

#[cfg(target_os = "windows")]
fn validate_wsl_home(
    account_id: &str,
    distro: Option<&str>,
    linux_home: Option<&str>,
) -> Result<(), String> {
    let distro = distro
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Managed Codex WSL account is missing its distro.".to_string())?;
    let linux_home = linux_home
        .filter(|path| {
            path.ends_with(&format!(
                "/.local/share/pebble/codex-accounts/{account_id}/home"
            ))
        })
        .ok_or_else(|| "Managed Codex WSL home is outside Pebble account storage.".to_string())?;
    let script = format!(
        "set -euo pipefail; home='{}'; test -f \"$home/{MARKER_FILE}\"; test \"$(cat \"$home/{MARKER_FILE}\")\" = '{account_id}'",
        linux_home.replace('\'', "'\\''")
    );
    let status = std::process::Command::new("wsl.exe")
        .args(["-d", distro, "--", "bash", "-lc", &script])
        .status()
        .map_err(|err| format!("Could not validate managed Codex WSL home: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Managed Codex WSL home failed ownership validation.".to_string())
    }
}

#[cfg(not(target_os = "windows"))]
fn validate_wsl_home(
    _account_id: &str,
    _distro: Option<&str>,
    _linux_home: Option<&str>,
) -> Result<(), String> {
    Err("Managed Codex WSL accounts are only available on Windows.".to_string())
}

fn remove_wsl_home(
    account_id: &str,
    distro: Option<&str>,
    linux_home: Option<&str>,
) -> Result<(), String> {
    validate_wsl_home(account_id, distro, linux_home)?;
    #[cfg(target_os = "windows")]
    {
        let distro = distro.unwrap().trim();
        let linux_home = linux_home.unwrap();
        let script = format!(
            "set -euo pipefail; home='{}'; rm -rf -- \"$home\"; rmdir -- \"$(dirname \"$home\")\" 2>/dev/null || true",
            linux_home.replace('\'', "'\\''")
        );
        let status = std::process::Command::new("wsl.exe")
            .args(["-d", distro, "--", "bash", "-lc", &script])
            .status()
            .map_err(|err| format!("Could not remove managed Codex WSL home: {err}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("Could not remove managed Codex WSL home.".to_string());
    }
    #[cfg(not(target_os = "windows"))]
    unreachable!()
}

fn managed_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Could not resolve Pebble app data: {err}"))?
        .join("codex-accounts");
    fs::create_dir_all(&root).map_err(|err| format!("Could not create account storage: {err}"))?;
    fs::canonicalize(&root).map_err(|err| format!("Could not resolve account storage: {err}"))
}

fn validate_account_id(account_id: &str) -> Result<(), String> {
    if account_id.is_empty()
        || account_id.len() > 80
        || !account_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid managed Codex account id.".to_string());
    }
    Ok(())
}

fn validate_owned_home(root: &Path, home: &Path, account_id: &str) -> Result<(), String> {
    if home
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Managed Codex home escaped account storage.".to_string());
    }
    let canonical_home = fs::canonicalize(home)
        .map_err(|_| "Managed Codex home directory does not exist on disk.".to_string())?;
    if !canonical_home.starts_with(root)
        || canonical_home
            .parent()
            .and_then(Path::file_name)
            .and_then(|v| v.to_str())
            != Some(account_id)
        || canonical_home.file_name().and_then(|v| v.to_str()) != Some("home")
    {
        return Err("Managed Codex home is outside Pebble account storage.".to_string());
    }
    let marker = fs::read_to_string(canonical_home.join(MARKER_FILE))
        .map_err(|_| "Managed Codex home is missing Pebble ownership marker.".to_string())?;
    if marker.trim() != account_id {
        return Err("Managed Codex ownership marker does not match the account.".to_string());
    }
    Ok(())
}

fn copy_canonical_config(managed_home: &Path) -> Result<(), String> {
    let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
    else {
        return Ok(());
    };
    let source = home.join(".codex").join("config.toml");
    if !source.is_file() {
        return Ok(());
    }
    fs::copy(&source, managed_home.join("config.toml"))
        .map(|_| ())
        .map_err(|err| format!("Could not copy Codex config: {err}"))
}

fn canonical_string(path: &Path) -> Result<String, String> {
    fs::canonicalize(path)
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|err| format!("Could not resolve managed Codex home: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_home_requires_containment_and_matching_marker() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("codex-accounts");
        let home = root.join("account-1").join("home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join(MARKER_FILE), "account-1\n").unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();

        assert!(validate_owned_home(&canonical_root, &home, "account-1").is_ok());
        assert!(validate_owned_home(&canonical_root, &home, "account-2").is_err());
        fs::write(home.join(MARKER_FILE), "account-2\n").unwrap();
        assert!(validate_owned_home(&canonical_root, &home, "account-1").is_err());
    }

    #[test]
    fn owned_home_rejects_an_external_marker_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("codex-accounts");
        let external = temp.path().join("external").join("account-1").join("home");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&external).unwrap();
        fs::write(external.join(MARKER_FILE), "account-1\n").unwrap();

        assert!(
            validate_owned_home(&fs::canonicalize(root).unwrap(), &external, "account-1")
                .unwrap_err()
                .contains("outside")
        );
    }

    #[test]
    fn account_ids_cannot_encode_paths() {
        assert!(validate_account_id("account-1").is_ok());
        assert!(validate_account_id("../account-1").is_err());
        assert!(validate_account_id("account/1").is_err());
        assert!(validate_account_id("").is_err());
    }
}
