use serde::Serialize;
use std::path::{Path, PathBuf};

/// Why: an absolute but user-writable PATH entry must never be treated as a
/// trusted package manager, so discovery never consults PATH or a shell.
const TRUSTED_EXECUTABLE_DIRECTORIES: [&str; 4] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/// Escalators in preference order. Pebble never runs these itself — they are
/// only spelled into the command the user pastes into their own terminal.
const ESCALATORS: [&str; 2] = ["sudo", "pkexec"];

/// Deb-family managers in preference order. `--` terminates option parsing so a
/// dash-leading filename can never be read as a flag.
const DEB_PACKAGE_MANAGERS: [(&str, &[&str]); 2] =
    [("apt", &["install", "--"]), ("dpkg", &["-i", "--"])];

/// Rpm-family managers in preference order. These tools reject a `--`
/// terminator, which is why the caller must supply an absolute package path.
const RPM_PACKAGE_MANAGERS: [(&str, &[&str]); 4] = [
    ("zypper", &["--no-refresh", "install", "-f"]),
    ("dnf", &["install"]),
    ("yum", &["install"]),
    ("rpm", &["-Uvh"]),
];

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinuxUpdateRecovery {
    /// "appimage" | "system" | "not-linux" — matches app_linux_install_kind.
    pub install_kind: String,
    /// Absolute path of the escalator Pebble would name, never one it runs.
    pub escalator: Option<String>,
    /// Absolute path of the resolved package manager.
    pub package_manager: Option<String>,
    /// The command to run once the release asset is downloaded, with
    /// `<package>` standing in for the file the user saved.
    pub install_command: Option<String>,
    /// "no-escalator" | "no-package-manager" | "not-applicable" when no command
    /// could be built, so the UI can explain the gap instead of going silent.
    pub reason: Option<String>,
}

/// Manual recovery instructions for a Linux install the updater refuses to
/// touch. Pebble ships a .deb and never escalates privileges itself, so the
/// only safe help it can offer is the exact command to run by hand.
#[tauri::command]
pub fn app_linux_update_recovery() -> LinuxUpdateRecovery {
    let install_kind = super::app_native::app_linux_install_kind();
    build_linux_update_recovery(install_kind, &|candidate| {
        std::fs::metadata(candidate).is_ok_and(|meta| meta.is_file())
    })
}

/// POSIX single-quoting: the only metacharacter left is `'`, closed and
/// re-opened around a literal one.
fn quote_for_posix_shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'"'"'"#))
}

fn resolve_trusted_executable(name: &str, exists: &dyn Fn(&Path) -> bool) -> Option<String> {
    TRUSTED_EXECUTABLE_DIRECTORIES
        .iter()
        .map(|directory| PathBuf::from(directory).join(name))
        .find(|candidate| exists(candidate))
        .map(|candidate| candidate.to_string_lossy().into_owned())
}

fn resolve_package_manager(
    exists: &dyn Fn(&Path) -> bool,
) -> Option<(String, &'static [&'static str])> {
    DEB_PACKAGE_MANAGERS
        .iter()
        .chain(RPM_PACKAGE_MANAGERS.iter())
        .find_map(|(name, args)| resolve_trusted_executable(name, exists).map(|path| (path, *args)))
}

fn build_linux_update_recovery(
    install_kind: &str,
    exists: &dyn Fn(&Path) -> bool,
) -> LinuxUpdateRecovery {
    // AppImage self-updates and non-Linux hosts have nothing to recover.
    if install_kind != "system" {
        return LinuxUpdateRecovery {
            install_kind: install_kind.to_string(),
            escalator: None,
            package_manager: None,
            install_command: None,
            reason: Some("not-applicable".to_string()),
        };
    }

    let escalator = ESCALATORS
        .iter()
        .find_map(|name| resolve_trusted_executable(name, exists));
    let manager = resolve_package_manager(exists);

    let reason = match (&escalator, &manager) {
        (None, _) => Some("no-escalator"),
        (_, None) => Some("no-package-manager"),
        _ => None,
    };

    // Why: no unattended-assent flag and no auto-run. The user must see and
    // confirm the privileged transaction in their own terminal.
    let install_command = match (&escalator, &manager) {
        (Some(escalator), Some((manager_path, args))) => {
            let mut tokens = vec![escalator.clone(), manager_path.clone()];
            tokens.extend(args.iter().map(|arg| (*arg).to_string()));
            tokens.push(quote_for_posix_shell("<package>"));
            Some(tokens.join(" "))
        }
        _ => None,
    };

    LinuxUpdateRecovery {
        install_kind: install_kind.to_string(),
        escalator,
        package_manager: manager.map(|(path, _)| path),
        install_command,
        reason: reason.map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn filesystem(paths: &[&str]) -> impl Fn(&Path) -> bool {
        let present: HashSet<String> = paths.iter().map(|path| (*path).to_string()).collect();
        move |candidate: &Path| present.contains(&candidate.to_string_lossy().into_owned())
    }

    #[test]
    fn builds_an_apt_command_from_trusted_directories_only() {
        let recovery =
            build_linux_update_recovery("system", &filesystem(&["/usr/bin/sudo", "/usr/bin/apt"]));
        assert_eq!(
            recovery.install_command.as_deref(),
            Some("/usr/bin/sudo /usr/bin/apt install -- '<package>'")
        );
        assert_eq!(recovery.reason, None);
    }

    #[test]
    fn ignores_a_package_manager_outside_the_trusted_directories() {
        let recovery = build_linux_update_recovery(
            "system",
            &filesystem(&["/usr/bin/sudo", "/home/ada/bin/apt"]),
        );
        assert_eq!(recovery.package_manager, None);
        assert_eq!(recovery.reason.as_deref(), Some("no-package-manager"));
        assert_eq!(recovery.install_command, None);
    }

    #[test]
    fn reports_a_missing_escalator_rather_than_a_bare_manager_command() {
        let recovery = build_linux_update_recovery("system", &filesystem(&["/usr/bin/apt"]));
        assert_eq!(recovery.escalator, None);
        assert_eq!(recovery.reason.as_deref(), Some("no-escalator"));
        assert_eq!(recovery.install_command, None);
    }

    #[test]
    fn falls_back_to_pkexec_when_sudo_is_absent() {
        let recovery = build_linux_update_recovery(
            "system",
            &filesystem(&["/usr/bin/pkexec", "/usr/bin/dpkg"]),
        );
        assert_eq!(recovery.escalator.as_deref(), Some("/usr/bin/pkexec"));
        assert_eq!(
            recovery.install_command.as_deref(),
            Some("/usr/bin/pkexec /usr/bin/dpkg -i -- '<package>'")
        );
    }

    #[test]
    fn prefers_apt_over_dpkg_and_deb_tools_over_rpm_tools() {
        let recovery = build_linux_update_recovery(
            "system",
            &filesystem(&[
                "/usr/bin/sudo",
                "/usr/bin/apt",
                "/usr/bin/dpkg",
                "/usr/bin/dnf",
            ]),
        );
        assert_eq!(recovery.package_manager.as_deref(), Some("/usr/bin/apt"));
    }

    #[test]
    fn builds_an_rpm_command_without_an_option_terminator() {
        let recovery =
            build_linux_update_recovery("system", &filesystem(&["/bin/sudo", "/usr/bin/dnf"]));
        assert_eq!(
            recovery.install_command.as_deref(),
            Some("/bin/sudo /usr/bin/dnf install '<package>'")
        );
    }

    #[test]
    fn never_names_a_command_for_appimage_or_non_linux_installs() {
        for kind in ["appimage", "not-linux"] {
            let recovery =
                build_linux_update_recovery(kind, &filesystem(&["/usr/bin/sudo", "/usr/bin/apt"]));
            assert_eq!(recovery.install_command, None);
            assert_eq!(recovery.reason.as_deref(), Some("not-applicable"));
        }
    }

    #[test]
    fn single_quotes_survive_posix_quoting() {
        assert_eq!(quote_for_posix_shell("a'b"), r#"'a'"'"'b'"#);
    }
}
