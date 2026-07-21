//! Windows CLI registration. Unlike Unix (a symlink into a PATH directory),
//! Windows symlink creation needs elevation or Developer Mode, which we cannot
//! assume for a normal user install. Instead we write a `.cmd` shim into a
//! Pebble-owned directory under the user's profile and add that directory to
//! `HKCU\Environment\Path`, broadcasting `WM_SETTINGCHANGE` so already-open
//! shells (and Explorer-spawned ones) see the update without a logout. This
//! mirrors the installer pattern used by rustup/nvm-windows/VS Code's `code`
//! CLI: a per-user PATH edit, no admin prompt.
use super::{command_name, platform_name, unsupported, CliInstallStatus};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// Abstraction over the one piece of this feature that cannot be unit-tested
/// on a non-Windows CI runner: the `HKCU\Environment` registry value and the
/// `WM_SETTINGCHANGE` broadcast. Production uses `Win32UserPathRegistry`
/// (real registry + Win32 call); tests inject `FakeUserPathRegistry` so the
/// decision logic below (what to add/remove, when to broadcast) is exercised
/// without touching the real registry.
pub trait UserPathRegistry {
    fn read_path(&self) -> Option<String>;
    fn write_path(&mut self, value: &str);
    fn broadcast_environment_change(&mut self);
}

/// Home directory override for tests; production reads `USERPROFILE`.
fn user_profile_dir(env_lookup: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    env_lookup("PEBBLE_CLI_USERPROFILE")
        .or_else(|| env_lookup("USERPROFILE"))
        .map(PathBuf::from)
}

/// Pebble's own PATH-managed bin directory. Not writing into an existing
/// system directory (unlike Unix's /usr/local/bin) because Windows has no
/// user-writable equivalent on PATH by default; we manage our own and add it
/// once instead.
fn shim_dir(env_lookup: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(override_dir) = env_lookup("PEBBLE_CLI_INSTALL_DIR") {
        return Some(PathBuf::from(override_dir));
    }
    let profile = user_profile_dir(env_lookup)?;
    Some(
        profile
            .join("AppData")
            .join("Local")
            .join("Pebble")
            .join("bin"),
    )
}

fn launcher_path(env_lookup: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(override_path) = env_lookup("PEBBLE_CLI_LAUNCHER_PATH") {
        return Some(PathBuf::from(override_path));
    }
    env::current_exe().ok()
}

fn command_file_name() -> String {
    format!("{}.cmd", command_name())
}

/// The `.cmd` shim content: re-launches the desktop executable, forwarding all
/// arguments. `%~dp0` resolves relative to the shim's own directory so the
/// script keeps working if Pebble's install directory moves, but the launcher
/// path itself is still baked in absolute (matching the Unix symlink target).
fn shim_script(launcher: &Path) -> String {
    format!("@echo off\r\n\"{}\" %*\r\n", launcher.to_string_lossy())
}

/// Parses a `;`-delimited PATH string into entries, trimming empties (a
/// trailing/leading `;` or `;;` from prior manual edits must not become a
/// phantom "current directory" entry).
fn split_path_entries(path_value: &str) -> Vec<String> {
    path_value
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

fn path_contains(path_value: &str, dir: &Path) -> bool {
    let dir_str = dir.to_string_lossy();
    split_path_entries(path_value)
        .iter()
        .any(|entry| entry.eq_ignore_ascii_case(&dir_str))
}

/// Builds the new `HKCU\Environment\Path` value with `dir` appended, or
/// `None` if it is already present (caller should skip the registry write).
fn path_with_dir_appended(current: Option<&str>, dir: &Path) -> Option<String> {
    let current = current.unwrap_or("");
    if path_contains(current, dir) {
        return None;
    }
    let mut entries = split_path_entries(current);
    entries.push(dir.to_string_lossy().into_owned());
    Some(entries.join(";"))
}

/// Builds the new `HKCU\Environment\Path` value with `dir` removed, or `None`
/// if it was already absent.
fn path_with_dir_removed(current: Option<&str>, dir: &Path) -> Option<String> {
    let current = current?;
    if !path_contains(current, dir) {
        return None;
    }
    let dir_str = dir.to_string_lossy();
    let entries: Vec<String> = split_path_entries(current)
        .into_iter()
        .filter(|entry| !entry.eq_ignore_ascii_case(&dir_str))
        .collect();
    Some(entries.join(";"))
}

fn status_from(
    command_path: &Path,
    launcher: &Path,
    dir: &Path,
    registry: &dyn UserPathRegistry,
) -> CliInstallStatus {
    let path_configured = registry
        .read_path()
        .map(|value| path_contains(&value, dir))
        .unwrap_or(false);
    let (state, current_target) = match fs::read(command_path) {
        Ok(contents) => {
            let expected = shim_script(launcher);
            if contents == expected.as_bytes() {
                (
                    "installed".to_string(),
                    Some(launcher.to_string_lossy().into_owned()),
                )
            } else {
                // Why: a shim exists but points elsewhere (or predates this
                // format) — treat it as stale rather than a foreign conflict
                // since Pebble is the only thing that writes command_name.cmd
                // into its own managed directory.
                ("stale".to_string(), None)
            }
        }
        Err(_) => ("not_installed".to_string(), None),
    };
    CliInstallStatus {
        platform: platform_name().to_string(),
        command_name: command_name().to_string(),
        command_path: Some(command_path.to_string_lossy().into_owned()),
        path_directory: Some(dir.to_string_lossy().into_owned()),
        path_configured,
        launcher_path: Some(launcher.to_string_lossy().into_owned()),
        install_method: Some("wrapper".to_string()),
        supported: true,
        state,
        current_target,
        unsupported_reason: None,
        detail: Some(
            "Registered a command shim in %LOCALAPPDATA%\\Pebble\\bin and added it to your user PATH.".to_string(),
        ),
    }
}

fn resolve_paths(
    env_lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<(PathBuf, PathBuf, PathBuf), CliInstallStatus> {
    let launcher = launcher_path(env_lookup).ok_or_else(|| {
        unsupported(
            "launcher_missing",
            "Could not resolve the Pebble desktop executable for CLI registration.",
        )
    })?;
    let dir = shim_dir(env_lookup).ok_or_else(|| {
        unsupported(
            "platform_not_supported",
            "Could not resolve %USERPROFILE% to place the CLI shim.",
        )
    })?;
    Ok((dir.join(command_file_name()), launcher, dir))
}

pub fn status(
    env_lookup: &dyn Fn(&str) -> Option<String>,
    registry: &dyn UserPathRegistry,
) -> CliInstallStatus {
    match resolve_paths(env_lookup) {
        Ok((command_path, launcher, dir)) => status_from(&command_path, &launcher, &dir, registry),
        Err(status) => status,
    }
}

pub fn install(
    env_lookup: &dyn Fn(&str) -> Option<String>,
    registry: &mut dyn UserPathRegistry,
) -> CliInstallStatus {
    let (command_path, launcher, dir) = match resolve_paths(env_lookup) {
        Ok(paths) => paths,
        Err(status) => return status,
    };
    if let Err(error) = fs::create_dir_all(&dir) {
        return unsupported(
            "platform_not_supported",
            &format!("Could not create {}: {error}", dir.display()),
        );
    }
    if let Err(error) = fs::write(&command_path, shim_script(&launcher)) {
        return unsupported(
            "platform_not_supported",
            &format!(
                "Could not write shim at {}: {error}",
                command_path.display()
            ),
        );
    }
    if let Some(new_path) = path_with_dir_appended(registry.read_path().as_deref(), &dir) {
        registry.write_path(&new_path);
        registry.broadcast_environment_change();
    }
    status_from(&command_path, &launcher, &dir, registry)
}

pub fn remove(
    env_lookup: &dyn Fn(&str) -> Option<String>,
    registry: &mut dyn UserPathRegistry,
) -> CliInstallStatus {
    let (command_path, launcher, dir) = match resolve_paths(env_lookup) {
        Ok(paths) => paths,
        Err(status) => return status,
    };
    let _ = fs::remove_file(&command_path);
    if let Some(new_path) = path_with_dir_removed(registry.read_path().as_deref(), &dir) {
        registry.write_path(&new_path);
        registry.broadcast_environment_change();
    }
    status_from(&command_path, &launcher, &dir, registry)
}

/// Real registry access, only compiled on Windows since it drives `winreg`
/// and the raw `SendMessageTimeoutW` broadcast — neither compiles nor can be
/// exercised on this (non-Windows) development machine. Kept intentionally
/// thin: all branching/decision logic lives in the pure functions above.
#[cfg(target_os = "windows")]
pub mod win32 {
    use super::UserPathRegistry;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };
    use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::{RegKey, RegValue, ToRegValue};

    pub struct Win32UserPathRegistry;

    impl UserPathRegistry for Win32UserPathRegistry {
        fn read_path(&self) -> Option<String> {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            let env = hkcu.open_subkey_with_flags("Environment", KEY_READ).ok()?;
            env.get_value("Path").ok()
        }

        fn write_path(&mut self, value: &str) {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            if let Ok(env) = hkcu.open_subkey_with_flags("Environment", KEY_WRITE) {
                // Why: REG_EXPAND_SZ preserves any %VAR% references a user may
                // already have in their PATH; REG_SZ would silently break them.
                // winreg's String impl only emits REG_SZ, so reuse its UTF-16LE
                // byte encoding and override the type tag (the wire format is
                // identical between the two REG_*_SZ variants).
                let sz_value = value.to_reg_value();
                let expand_value = RegValue {
                    bytes: sz_value.bytes,
                    vtype: RegType::REG_EXPAND_SZ,
                };
                let _ = env.set_raw_value("Path", &expand_value);
            }
        }

        fn broadcast_environment_change(&mut self) {
            // Why: HWND_BROADCAST + WM_SETTINGCHANGE("Environment") is the
            // documented way to tell already-running processes (Explorer, new
            // shells it spawns) to reread the environment without a logout;
            // rustup/nvm-windows use the same call.
            let param: Vec<u16> = "Environment\0".encode_utf16().collect();
            let mut result: usize = 0;
            unsafe {
                SendMessageTimeoutW(
                    HWND_BROADCAST,
                    WM_SETTINGCHANGE,
                    0,
                    param.as_ptr() as isize,
                    SMTO_ABORTIFHUNG,
                    5000,
                    &mut result as *mut usize,
                );
            }
        }
    }

    pub fn env_lookup(name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeUserPathRegistry {
        path: RefCell<Option<String>>,
        broadcast_count: RefCell<u32>,
    }

    impl FakeUserPathRegistry {
        fn seeded(path: &str) -> Self {
            Self {
                path: RefCell::new(Some(path.to_string())),
                broadcast_count: RefCell::new(0),
            }
        }
    }

    impl UserPathRegistry for FakeUserPathRegistry {
        fn read_path(&self) -> Option<String> {
            self.path.borrow().clone()
        }
        fn write_path(&mut self, value: &str) {
            *self.path.borrow_mut() = Some(value.to_string());
        }
        fn broadcast_environment_change(&mut self) {
            *self.broadcast_count.borrow_mut() += 1;
        }
    }

    fn env_with(overrides: Vec<(&'static str, String)>) -> impl Fn(&str) -> Option<String> {
        move |key: &str| {
            overrides
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.clone())
        }
    }

    fn temp_scope() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let launcher = dir.path().join("pebble-desktop.exe");
        fs::write(&launcher, b"launcher").unwrap();
        (dir, launcher)
    }

    #[test]
    fn split_path_entries_ignores_empty_segments() {
        assert_eq!(
            split_path_entries(r"C:\Windows;;C:\Windows\System32;"),
            vec![
                r"C:\Windows".to_string(),
                r"C:\Windows\System32".to_string()
            ]
        );
    }

    #[test]
    fn path_contains_is_case_insensitive() {
        let dir = PathBuf::from(r"C:\Users\me\AppData\Local\Pebble\bin");
        assert!(path_contains(
            r"C:\Windows;c:\users\me\appdata\local\pebble\bin",
            &dir
        ));
    }

    #[test]
    fn path_with_dir_appended_skips_when_already_present() {
        let dir = PathBuf::from(r"C:\Pebble\bin");
        assert_eq!(
            path_with_dir_appended(Some(r"C:\Windows;C:\Pebble\bin"), &dir),
            None
        );
        assert_eq!(
            path_with_dir_appended(Some(r"C:\Windows"), &dir),
            Some(r"C:\Windows;C:\Pebble\bin".to_string())
        );
        assert_eq!(
            path_with_dir_appended(None, &dir),
            Some(r"C:\Pebble\bin".to_string())
        );
    }

    #[test]
    fn path_with_dir_removed_skips_when_absent() {
        let dir = PathBuf::from(r"C:\Pebble\bin");
        assert_eq!(path_with_dir_removed(Some(r"C:\Windows"), &dir), None);
        assert_eq!(path_with_dir_removed(None, &dir), None);
        assert_eq!(
            path_with_dir_removed(Some(r"C:\Windows;C:\Pebble\bin"), &dir),
            Some(r"C:\Windows".to_string())
        );
    }

    #[test]
    fn install_writes_shim_and_registers_path_once() {
        let (dir, launcher) = temp_scope();
        let install_dir = dir.path().join("bin");
        let env_lookup = env_with(vec![
            (
                "PEBBLE_CLI_INSTALL_DIR",
                install_dir.to_string_lossy().into_owned(),
            ),
            (
                "PEBBLE_CLI_LAUNCHER_PATH",
                launcher.to_string_lossy().into_owned(),
            ),
        ]);
        let mut registry = FakeUserPathRegistry::seeded(r"C:\Windows");

        let installed = install(&env_lookup, &mut registry);
        assert_eq!(
            installed.state, "installed",
            "detail: {:?}",
            installed.detail
        );
        assert!(installed.path_configured);
        assert_eq!(*registry.broadcast_count.borrow(), 1);

        let shim_path = install_dir.join(command_file_name());
        let contents = fs::read_to_string(&shim_path).unwrap();
        assert!(contents.contains(&launcher.to_string_lossy().into_owned()));

        // Idempotent: a second install must not double-append the PATH entry
        // or broadcast again.
        let reinstalled = install(&env_lookup, &mut registry);
        assert_eq!(reinstalled.state, "installed");
        assert_eq!(*registry.broadcast_count.borrow(), 1);
        let path_entries = split_path_entries(&registry.read_path().unwrap());
        assert_eq!(
            path_entries
                .iter()
                .filter(|e| **e == install_dir.to_string_lossy())
                .count(),
            1
        );
    }

    #[test]
    fn remove_deletes_shim_and_cleans_path() {
        let (dir, launcher) = temp_scope();
        let install_dir = dir.path().join("bin");
        let env_lookup = env_with(vec![
            (
                "PEBBLE_CLI_INSTALL_DIR",
                install_dir.to_string_lossy().into_owned(),
            ),
            (
                "PEBBLE_CLI_LAUNCHER_PATH",
                launcher.to_string_lossy().into_owned(),
            ),
        ]);
        let mut registry = FakeUserPathRegistry::seeded(r"C:\Windows");

        install(&env_lookup, &mut registry);
        let removed = remove(&env_lookup, &mut registry);
        assert_eq!(removed.state, "not_installed");
        assert!(!removed.path_configured);
        assert_eq!(*registry.broadcast_count.borrow(), 2);
        assert!(fs::read(install_dir.join(command_file_name())).is_err());

        // Idempotent: removing again is a no-op, no extra broadcast.
        remove(&env_lookup, &mut registry);
        assert_eq!(*registry.broadcast_count.borrow(), 2);
    }

    #[test]
    fn status_reports_stale_when_shim_launcher_mismatches() {
        let (dir, launcher) = temp_scope();
        let install_dir = dir.path().join("bin");
        let env_lookup = env_with(vec![
            (
                "PEBBLE_CLI_INSTALL_DIR",
                install_dir.to_string_lossy().into_owned(),
            ),
            (
                "PEBBLE_CLI_LAUNCHER_PATH",
                launcher.to_string_lossy().into_owned(),
            ),
        ]);
        let mut registry = FakeUserPathRegistry::seeded(r"C:\Windows");
        install(&env_lookup, &mut registry);

        // Simulate the launcher having moved (e.g. app reinstalled elsewhere).
        let other_launcher = dir.path().join("moved-pebble-desktop.exe");
        fs::write(&other_launcher, b"launcher").unwrap();
        let env_lookup_moved = env_with(vec![
            (
                "PEBBLE_CLI_INSTALL_DIR",
                install_dir.to_string_lossy().into_owned(),
            ),
            (
                "PEBBLE_CLI_LAUNCHER_PATH",
                other_launcher.to_string_lossy().into_owned(),
            ),
        ]);
        let current = status(&env_lookup_moved, &registry);
        assert_eq!(current.state, "stale");
    }
}
