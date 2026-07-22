use serde::Serialize;

/// CliInstallStatus mirror (packages/product-core/shared/cli-install-types.ts). The renderer's CLI
/// settings panel consumes this shape verbatim.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallStatus {
    pub platform: String,
    pub command_name: String,
    pub command_path: Option<String>,
    pub path_directory: Option<String>,
    pub path_configured: bool,
    pub launcher_path: Option<String>,
    pub install_method: Option<String>,
    pub supported: bool,
    pub state: String,
    pub current_target: Option<String>,
    pub unsupported_reason: Option<String>,
    pub detail: Option<String>,
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "unknown"
    }
}

fn command_name() -> &'static str {
    "pebble"
}

fn unsupported(reason: &str, detail: &str) -> CliInstallStatus {
    CliInstallStatus {
        platform: platform_name().to_string(),
        command_name: command_name().to_string(),
        command_path: None,
        path_directory: None,
        path_configured: false,
        launcher_path: None,
        install_method: None,
        supported: false,
        state: "unsupported".to_string(),
        current_target: None,
        unsupported_reason: Some(reason.to_string()),
        detail: Some(detail.to_string()),
    }
}

// Why: any non-Unix, non-Windows target (none currently shipped) has no CLI
// registration story; keep it explicitly unsupported rather than guessing.
#[cfg(not(any(unix, target_os = "windows")))]
const OTHER_UNSUPPORTED_DETAIL: &str = "CLI registration is not available on this platform.";

#[cfg(target_os = "windows")]
mod cli_registration_windows;
#[path = "cli_registration_wsl.rs"]
mod cli_registration_wsl;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslCliInput {
    pub distro: Option<String>,
}

#[cfg(unix)]
mod unix_cli {
    use super::{command_name, platform_name, unsupported, CliInstallStatus};
    use std::env;
    use std::fs;
    use std::os::unix::fs as unix_fs;
    use std::path::{Path, PathBuf};

    fn home_dir() -> Option<PathBuf> {
        env::var_os("HOME").map(PathBuf::from)
    }

    /// Resolve the install directory: /usr/local/bin when its parent exists and is
    /// writable (Intel macOS / most Linux), otherwise the user-scoped
    /// ~/.local/bin which needs no elevation and is XDG-standard on PATH.
    /// PEBBLE_CLI_INSTALL_DIR is a test seam so registration can be exercised
    /// against a temp dir without touching real bin directories.
    fn install_dir() -> Option<(PathBuf, bool)> {
        if let Some(override_dir) = env::var_os("PEBBLE_CLI_INSTALL_DIR") {
            return Some((PathBuf::from(override_dir), true));
        }
        let usr_local = PathBuf::from("/usr/local/bin");
        if usr_local.exists() && is_writable_dir(&usr_local) {
            return Some((usr_local, false));
        }
        let home = home_dir()?;
        Some((home.join(".local").join("bin"), true))
    }

    fn is_writable_dir(dir: &Path) -> bool {
        // Probe writability without pulling in a syscall crate: create+remove a
        // temp file. Any error (EACCES/EPERM/read-only) means not writable.
        let probe = dir.join(".pebble-cli-write-probe");
        match fs::File::create(&probe) {
            Ok(_) => {
                let _ = fs::remove_file(&probe);
                true
            }
            Err(_) => false,
        }
    }

    fn launcher_path() -> Option<PathBuf> {
        // The launcher is the app's own executable; the CLI symlink points at it
        // so the shell command re-enters the desktop shell.
        // PEBBLE_CLI_LAUNCHER_PATH is a test seam.
        if let Some(override_path) = env::var_os("PEBBLE_CLI_LAUNCHER_PATH") {
            return Some(PathBuf::from(override_path));
        }
        env::current_exe().ok()
    }

    fn path_configured(dir: &Path) -> bool {
        let Some(path_var) = env::var_os("PATH") else {
            return false;
        };
        env::split_paths(&path_var).any(|entry| entry == dir)
    }

    fn status_from(command_path: &Path, launcher: &Path, user_scoped: bool) -> CliInstallStatus {
        let dir = command_path.parent().map(Path::to_path_buf);
        let (state, current_target) = match fs::symlink_metadata(command_path) {
            Ok(meta) if meta.file_type().is_symlink() => match fs::read_link(command_path) {
                Ok(target) if target == launcher => ("installed".to_string(), Some(target)),
                Ok(target) => ("stale".to_string(), Some(target)),
                Err(_) => ("conflict".to_string(), None),
            },
            // Why: a real (non-symlink) file at the command path is not
            // Pebble-owned; refuse to treat it as ours so install/remove never
            // clobbers a user file.
            Ok(_) => ("conflict".to_string(), None),
            Err(_) => ("not_installed".to_string(), None),
        };
        CliInstallStatus {
            platform: platform_name().to_string(),
            command_name: command_name().to_string(),
            command_path: Some(command_path.to_string_lossy().into_owned()),
            path_directory: dir.as_ref().map(|d| d.to_string_lossy().into_owned()),
            path_configured: dir.as_deref().map(path_configured).unwrap_or(false),
            launcher_path: Some(launcher.to_string_lossy().into_owned()),
            install_method: Some("symlink".to_string()),
            supported: true,
            state,
            current_target: current_target.map(|t| t.to_string_lossy().into_owned()),
            unsupported_reason: None,
            detail: Some(if user_scoped {
                "Registered a user-scoped symlink in ~/.local/bin.".to_string()
            } else {
                "Registered a symlink in /usr/local/bin.".to_string()
            }),
        }
    }

    fn resolve_paths() -> Result<(PathBuf, PathBuf, bool), CliInstallStatus> {
        let launcher = launcher_path().ok_or_else(|| {
            unsupported(
                "launcher_missing",
                "Could not resolve the Pebble desktop executable for CLI registration.",
            )
        })?;
        let (dir, user_scoped) = install_dir().ok_or_else(|| {
            unsupported(
                "platform_not_supported",
                "No writable CLI install directory is available.",
            )
        })?;
        Ok((dir.join(command_name()), launcher, user_scoped))
    }

    pub fn status() -> CliInstallStatus {
        match resolve_paths() {
            Ok((command_path, launcher, user_scoped)) => {
                status_from(&command_path, &launcher, user_scoped)
            }
            Err(status) => status,
        }
    }

    pub fn install() -> CliInstallStatus {
        let (command_path, launcher, user_scoped) = match resolve_paths() {
            Ok(paths) => paths,
            Err(status) => return status,
        };
        if let Some(dir) = command_path.parent() {
            if let Err(error) = fs::create_dir_all(dir) {
                return unsupported(
                    if user_scoped {
                        "launcher_missing"
                    } else {
                        "platform_not_supported"
                    },
                    &format!("Could not create {}: {error}", dir.display()),
                );
            }
        }
        let current = status_from(&command_path, &launcher, user_scoped);
        // Why: never replace a non-Pebble file or foreign symlink; that would be
        // a destructive action on something the user owns.
        if current.state == "conflict" || current.state == "installed" {
            return current;
        }
        if current.state == "stale" {
            let _ = fs::remove_file(&command_path);
        }
        if let Err(error) = unix_fs::symlink(&launcher, &command_path) {
            // A permission error at /usr/local/bin means elevation is needed;
            // surface it rather than silently succeeding.
            return unsupported(
                "platform_not_supported",
                &format!(
                    "Could not create symlink at {} (elevation may be required): {error}",
                    command_path.display()
                ),
            );
        }
        status_from(&command_path, &launcher, user_scoped)
    }

    pub fn remove() -> CliInstallStatus {
        let (command_path, launcher, user_scoped) = match resolve_paths() {
            Ok(paths) => paths,
            Err(status) => return status,
        };
        let current = status_from(&command_path, &launcher, user_scoped);
        // Why: only remove a symlink Pebble itself installed; a conflict is a
        // user-owned file we must never delete.
        if current.state == "conflict" {
            return current;
        }
        if current.state == "installed" || current.state == "stale" {
            let _ = fs::remove_file(&command_path);
        }
        status_from(&command_path, &launcher, user_scoped)
    }
}

fn cli_install_status_blocking() -> CliInstallStatus {
    #[cfg(unix)]
    {
        unix_cli::status()
    }
    #[cfg(target_os = "windows")]
    {
        let registry = cli_registration_windows::win32::Win32UserPathRegistry;
        cli_registration_windows::status(&cli_registration_windows::win32::env_lookup, &registry)
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        unsupported("platform_not_supported", OTHER_UNSUPPORTED_DETAIL)
    }
}

fn cli_install_blocking() -> CliInstallStatus {
    #[cfg(unix)]
    {
        unix_cli::install()
    }
    #[cfg(target_os = "windows")]
    {
        let mut registry = cli_registration_windows::win32::Win32UserPathRegistry;
        cli_registration_windows::install(
            &cli_registration_windows::win32::env_lookup,
            &mut registry,
        )
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        unsupported("platform_not_supported", OTHER_UNSUPPORTED_DETAIL)
    }
}

fn cli_remove_blocking() -> CliInstallStatus {
    #[cfg(unix)]
    {
        unix_cli::remove()
    }
    #[cfg(target_os = "windows")]
    {
        let mut registry = cli_registration_windows::win32::Win32UserPathRegistry;
        cli_registration_windows::remove(
            &cli_registration_windows::win32::env_lookup,
            &mut registry,
        )
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        unsupported("platform_not_supported", OTHER_UNSUPPORTED_DETAIL)
    }
}

// Why: these do filesystem I/O (writability probes, symlink/registry writes)
// that can stall on a slow/stale mount or AV scan. Running on the main thread
// would block every other pending IPC call, including unrelated invokes like
// the terminal cwd lookup — spawn_blocking keeps a slow probe from freezing
// the whole app.
#[tauri::command]
pub async fn cli_install_status() -> CliInstallStatus {
    tauri::async_runtime::spawn_blocking(cli_install_status_blocking)
        .await
        .unwrap_or_else(|_| unsupported("platform_not_supported", "CLI status check failed."))
}

#[tauri::command]
pub async fn cli_install() -> CliInstallStatus {
    tauri::async_runtime::spawn_blocking(cli_install_blocking)
        .await
        .unwrap_or_else(|_| unsupported("platform_not_supported", "CLI install failed."))
}

#[tauri::command]
pub async fn cli_remove() -> CliInstallStatus {
    tauri::async_runtime::spawn_blocking(cli_remove_blocking)
        .await
        .unwrap_or_else(|_| unsupported("platform_not_supported", "CLI removal failed."))
}

#[tauri::command]
pub async fn cli_wsl_install_status(input: WslCliInput) -> CliInstallStatus {
    cli_registration_wsl::status(input.distro).await
}

#[tauri::command]
pub async fn cli_wsl_install(input: WslCliInput) -> CliInstallStatus {
    cli_registration_wsl::install(input.distro).await
}

#[tauri::command]
pub async fn cli_wsl_remove(input: WslCliInput) -> CliInstallStatus {
    cli_registration_wsl::remove(input.distro).await
}

#[cfg(all(test, unix))]
mod tests {
    use super::unix_cli;
    use std::fs;
    use std::sync::Mutex;

    // Why: these tests mutate process-wide env (install-dir/launcher seams); a
    // mutex serializes them so parallel runs cannot see each other's overrides.
    static ENV_GUARD: Mutex<()> = Mutex::new(());

    struct Scope {
        _dir: tempfile::TempDir,
    }

    fn scope() -> Scope {
        let dir = tempfile::tempdir().unwrap();
        let launcher = dir.path().join("pebble-desktop");
        fs::write(&launcher, b"launcher").unwrap();
        std::env::set_var("PEBBLE_CLI_INSTALL_DIR", dir.path());
        std::env::set_var("PEBBLE_CLI_LAUNCHER_PATH", &launcher);
        Scope { _dir: dir }
    }

    #[test]
    fn installed_command_name_is_canonical() {
        assert_eq!(super::command_name(), "pebble");
    }

    #[test]
    fn install_creates_symlink_and_remove_clears_it() {
        let _lock = ENV_GUARD.lock().unwrap();
        let _scope = scope();

        let before = unix_cli::status();
        assert_eq!(before.state, "not_installed");
        assert!(before.supported);

        let installed = unix_cli::install();
        assert_eq!(
            installed.state, "installed",
            "detail: {:?}",
            installed.detail
        );
        let command_path = installed.command_path.clone().unwrap();
        assert!(fs::symlink_metadata(&command_path)
            .unwrap()
            .file_type()
            .is_symlink());

        // Idempotent: a second install is a no-op that still reports installed.
        assert_eq!(unix_cli::install().state, "installed");

        let removed = unix_cli::remove();
        assert_eq!(removed.state, "not_installed");
        assert!(fs::symlink_metadata(&command_path).is_err());

        std::env::remove_var("PEBBLE_CLI_INSTALL_DIR");
        std::env::remove_var("PEBBLE_CLI_LAUNCHER_PATH");
    }

    #[test]
    fn foreign_file_is_a_conflict_and_never_replaced() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let command_path = scope._dir.path().join(super::command_name());
        fs::write(&command_path, b"user script").unwrap();

        let status = unix_cli::install();
        assert_eq!(status.state, "conflict");
        // The user's file must be untouched.
        assert_eq!(fs::read(&command_path).unwrap(), b"user script");

        std::env::remove_var("PEBBLE_CLI_INSTALL_DIR");
        std::env::remove_var("PEBBLE_CLI_LAUNCHER_PATH");
    }
}
