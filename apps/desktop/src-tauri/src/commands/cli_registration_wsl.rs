use super::{unsupported, CliInstallStatus};

#[cfg(any(target_os = "windows", test))]
const COMMAND_NAME: &str = "pebble";
#[cfg(any(target_os = "windows", test))]
const LEGACY_COMMAND_NAME: &str = "pebble-ide";
#[cfg(any(target_os = "windows", test))]
const MANAGED_MARKER: &str = "# Pebble managed WSL CLI launcher";
#[cfg(any(target_os = "windows", test))]
const BRIDGE_MARKER: &str = "# Pebble managed WSL CLI PowerShell bridge";

pub async fn status(distro: Option<String>) -> CliInstallStatus {
    run_blocking(move || status_sync(distro)).await
}

pub async fn install(distro: Option<String>) -> CliInstallStatus {
    run_blocking(move || install_sync(distro)).await
}

pub async fn remove(distro: Option<String>) -> CliInstallStatus {
    run_blocking(move || remove_sync(distro)).await
}

async fn run_blocking(
    operation: impl FnOnce() -> CliInstallStatus + Send + 'static,
) -> CliInstallStatus {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .unwrap_or_else(|error| {
            unsupported(
                "launcher_missing",
                &format!("WSL CLI operation failed to join: {error}"),
            )
        })
}

#[cfg(not(target_os = "windows"))]
fn status_sync(_distro: Option<String>) -> CliInstallStatus {
    unsupported(
        "platform_not_supported",
        "WSL CLI registration is only available on Windows.",
    )
}

#[cfg(not(target_os = "windows"))]
fn install_sync(distro: Option<String>) -> CliInstallStatus {
    status_sync(distro)
}

#[cfg(not(target_os = "windows"))]
fn remove_sync(distro: Option<String>) -> CliInstallStatus {
    status_sync(distro)
}

#[cfg(target_os = "windows")]
fn status_sync(distro: Option<String>) -> CliInstallStatus {
    windows::status(distro)
}

#[cfg(target_os = "windows")]
fn install_sync(distro: Option<String>) -> CliInstallStatus {
    windows::install(distro)
}

#[cfg(target_os = "windows")]
fn remove_sync(distro: Option<String>) -> CliInstallStatus {
    windows::remove(distro)
}

#[cfg(any(target_os = "windows", test))]
fn build_launcher(windows_launcher: &str, bridge_path: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    format!(
        "#!/usr/bin/env bash\nset -euo pipefail\n{MANAGED_MARKER}\n# PEBBLE_WIN_LAUNCHER_B64={}\nPEBBLE_WIN_LAUNCHER={}\nPEBBLE_BRIDGE_PS1={}\nif command -v powershell.exe >/dev/null 2>&1; then\n  PEBBLE_POWERSHELL=powershell.exe\nelif [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then\n  PEBBLE_POWERSHELL=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe\nelse\n  echo \"Pebble WSL CLI requires Windows interop and could not find powershell.exe.\" >&2\n  exit 1\nfi\nPEBBLE_BRIDGE_PS1_WIN=$(wslpath -w \"$PEBBLE_BRIDGE_PS1\")\nexec \"$PEBBLE_POWERSHELL\" -NoProfile -ExecutionPolicy Bypass -File \"$PEBBLE_BRIDGE_PS1_WIN\" \"$PEBBLE_WIN_LAUNCHER\" \"$@\"\n",
        STANDARD.encode(windows_launcher.as_bytes()),
        quote_shell(windows_launcher),
        quote_shell(bridge_path)
    )
}

#[cfg(any(target_os = "windows", test))]
fn build_bridge() -> String {
    format!(
        "{BRIDGE_MARKER}\nparam(\n  [Parameter(Mandatory=$true)]\n  [string]$PebbleLauncher,\n  [Parameter(ValueFromRemainingArguments=$true)]\n  [string[]]$ForwardArgs\n)\ntry {{\n  & $PebbleLauncher @ForwardArgs\n  if (-not $?) {{ exit 1 }}\n  if ($null -eq $LASTEXITCODE) {{ exit 0 }}\n  exit $LASTEXITCODE\n}} catch {{\n  Write-Error $_\n  exit 1\n}}\n"
    )
}

#[cfg(any(target_os = "windows", test))]
fn quote_shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(any(target_os = "windows", test))]
struct ReadyState {
    distro: String,
    command_path: String,
    legacy_command_path: String,
    bridge_path: String,
    launcher_path: String,
    path_configured: bool,
}

#[cfg(any(target_os = "windows", test))]
fn command_dir(path: &str) -> &str {
    path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("/")
}

#[cfg(any(target_os = "windows", test))]
fn install_script(ready: &ReadyState) -> String {
    let launcher = build_launcher(&ready.launcher_path, &ready.bridge_path);
    let bridge = build_bridge();
    format!(
        "set -euo pipefail\nmkdir -p {} {}\ncommand_path={}\nlegacy_command_path={}\nbridge_path={}\nif [ -L \"$command_path\" ] || {{ [ -e \"$command_path\" ] && ! grep -Fq {} \"$command_path\"; }}; then exit 23; fi\nif [ -L \"$bridge_path\" ] || {{ [ -e \"$bridge_path\" ] && ! grep -Fq {} \"$bridge_path\"; }}; then exit 23; fi\ncommand_tmp=\"${{command_path}}.tmp.$$\"\nbridge_tmp=\"${{bridge_path}}.tmp.$$\"\ntrap 'rm -f \"$command_tmp\" \"$bridge_tmp\"' EXIT\ncat > \"$bridge_tmp\" <<'PEBBLE_WSL_BRIDGE'\n{}PEBBLE_WSL_BRIDGE\ncat > \"$command_tmp\" <<'PEBBLE_WSL_CLI'\n{}PEBBLE_WSL_CLI\nchmod 644 \"$bridge_tmp\"\nchmod 755 \"$command_tmp\"\nmv -f \"$bridge_tmp\" \"$bridge_path\"\nmv -f \"$command_tmp\" \"$command_path\"\nif [ ! -L \"$legacy_command_path\" ] && [ -f \"$legacy_command_path\" ] && grep -Fq {} \"$legacy_command_path\"; then rm -f \"$legacy_command_path\"; fi\ntrap - EXIT\n",
        quote_shell(command_dir(&ready.command_path)),
        quote_shell(command_dir(&ready.bridge_path)),
        quote_shell(&ready.command_path),
        quote_shell(&ready.legacy_command_path),
        quote_shell(&ready.bridge_path),
        quote_shell(MANAGED_MARKER),
        quote_shell(BRIDGE_MARKER),
        bridge,
        launcher,
        quote_shell(MANAGED_MARKER)
    )
}

#[cfg(any(target_os = "windows", test))]
fn remove_script(ready: &ReadyState) -> String {
    format!(
        "set -euo pipefail\nfor entry in {} {}; do\n  if [ -L \"$entry\" ] || {{ [ -e \"$entry\" ] && ! grep -Fq 'Pebble managed WSL' \"$entry\"; }}; then exit 23; fi\ndone\nrm -f {} {}\nlegacy_command_path={}\nif [ ! -L \"$legacy_command_path\" ] && [ -f \"$legacy_command_path\" ] && grep -Fq {} \"$legacy_command_path\"; then rm -f \"$legacy_command_path\"; fi\n",
        quote_shell(&ready.command_path),
        quote_shell(&ready.bridge_path),
        quote_shell(&ready.command_path),
        quote_shell(&ready.bridge_path),
        quote_shell(&ready.legacy_command_path),
        quote_shell(MANAGED_MARKER)
    )
}

#[cfg(target_os = "windows")]
mod windows {
    use std::env;
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use wait_timeout::ChildExt;

    use super::{
        build_bridge, build_launcher, command_dir, install_script, quote_shell, remove_script,
        unsupported, CliInstallStatus, ReadyState, BRIDGE_MARKER, COMMAND_NAME,
        LEGACY_COMMAND_NAME, MANAGED_MARKER,
    };

    const TIMEOUT: Duration = Duration::from_secs(10);

    pub fn status(distro: Option<String>) -> CliInstallStatus {
        match resolve_ready(distro) {
            Ok(ready) => status_for(&ready),
            Err(status) => status,
        }
    }

    pub fn install(distro: Option<String>) -> CliInstallStatus {
        let ready = match resolve_ready(distro) {
            Ok(ready) => ready,
            Err(status) => return status,
        };
        let current = status_for(&ready);
        if current.state == "conflict" {
            return current;
        }
        let script = install_script(&ready);
        if let Err(status) = run_wsl(&ready.distro, &script) {
            return status;
        }
        status_for(&ready)
    }

    pub fn remove(distro: Option<String>) -> CliInstallStatus {
        let ready = match resolve_ready(distro) {
            Ok(ready) => ready,
            Err(status) => return status,
        };
        let current = status_for(&ready);
        if current.state == "conflict" || current.state == "not_installed" {
            return current;
        }
        let script = remove_script(&ready);
        if let Err(status) = run_wsl(&ready.distro, &script) {
            return status;
        }
        status_for(&ready)
    }

    fn resolve_ready(distro: Option<String>) -> Result<ReadyState, CliInstallStatus> {
        let distro = distro
            .filter(|value| !value.trim().is_empty())
            .or_else(default_distro)
            .ok_or_else(|| {
                unsupported(
                    "platform_not_supported",
                    "No WSL distribution is available.",
                )
            })?;
        let launcher = env::current_exe().map_err(|_| {
            unsupported(
                "launcher_missing",
                "Could not resolve the Pebble desktop executable.",
            )
        })?;
        let home = run_wsl(&distro, "printf %s \"$HOME\"")?;
        let home = home.trim();
        if !home.starts_with('/') {
            return Err(unsupported(
                "launcher_missing",
                "Unable to resolve the WSL home directory.",
            ));
        }
        let interop = run_wsl(&distro, "{ command -v powershell.exe >/dev/null 2>&1 || [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; } && command -v wslpath >/dev/null 2>&1 && printf yes || printf no")?;
        if interop.trim() != "yes" {
            return Err(unsupported(
                "launcher_missing",
                "WSL Windows interop is unavailable.",
            ));
        }
        let path_directory = format!("{home}/.local/bin");
        let command_path = format!("{path_directory}/{COMMAND_NAME}");
        let legacy_command_path = format!("{path_directory}/{LEGACY_COMMAND_NAME}");
        let bridge_path = format!("{home}/.local/share/pebble/pebble-wsl-bridge.ps1");
        let path_check = format!(
            "case \":$PATH:\" in *:{}:*) printf yes ;; *) printf no ;; esac",
            quote_shell(&path_directory)
        );
        let path_configured = run_wsl(&distro, &path_check)
            .map(|value| value.trim() == "yes")
            .unwrap_or(false);
        Ok(ReadyState {
            distro,
            command_path,
            legacy_command_path,
            bridge_path,
            launcher_path: launcher.to_string_lossy().into_owned(),
            path_configured,
        })
    }

    fn status_for(ready: &ReadyState) -> CliInstallStatus {
        let expected_launcher = build_launcher(&ready.launcher_path, &ready.bridge_path);
        let expected_bridge = build_bridge();
        let command = read_file_state(&ready.distro, &ready.command_path);
        let bridge = read_file_state(&ready.distro, &ready.bridge_path);
        let state = match (&command, &bridge) {
            (FileState::Missing, _) => "not_installed",
            (FileState::Content(command), FileState::Content(bridge))
                if normalize(command) == normalize(&expected_launcher)
                    && normalize(bridge) == normalize(&expected_bridge) =>
            {
                "installed"
            }
            (FileState::Content(command), FileState::Missing)
                if command.contains(MANAGED_MARKER) =>
            {
                "stale"
            }
            (FileState::Content(command), FileState::Content(bridge))
                if command.contains(MANAGED_MARKER) && bridge.contains(BRIDGE_MARKER) =>
            {
                "stale"
            }
            _ => "conflict",
        };
        CliInstallStatus {
            platform: "linux".to_string(),
            command_name: COMMAND_NAME.to_string(),
            command_path: Some(ready.command_path.clone()),
            path_directory: Some(command_dir(&ready.command_path).to_string()),
            path_configured: ready.path_configured,
            launcher_path: Some(ready.launcher_path.clone()),
            install_method: Some("wrapper".to_string()),
            supported: true,
            state: state.to_string(),
            current_target: match &command {
                FileState::Content(value) => parse_target(value),
                _ => None,
            },
            unsupported_reason: None,
            detail: Some(format!("WSL CLI registration for {}.", ready.distro)),
        }
    }

    enum FileState {
        Missing,
        NotFile,
        Content(String),
        Error,
    }

    fn read_file_state(distro: &str, path: &str) -> FileState {
        let script = format!(
            "if [ -L {0} ] || [ -d {0} ]; then printf __NOT_FILE__; elif [ ! -e {0} ]; then printf __MISSING__; elif [ -f {0} ]; then cat {0}; else printf __NOT_FILE__; fi",
            quote_shell(path)
        );
        match run_wsl(distro, &script) {
            Ok(value) if value == "__MISSING__" => FileState::Missing,
            Ok(value) if value == "__NOT_FILE__" => FileState::NotFile,
            Ok(value) => FileState::Content(value),
            Err(_) => FileState::Error,
        }
    }

    fn default_distro() -> Option<String> {
        run_process("wsl.exe", &["-l", "-q"], None)
            .ok()?
            .lines()
            .map(|line| line.replace('\0', ""))
            .map(|line| line.trim().to_string())
            .find(|value| !value.is_empty())
    }

    fn run_wsl(distro: &str, script: &str) -> Result<String, CliInstallStatus> {
        run_process("wsl.exe", &["-d", distro, "--", "bash", "-s"], Some(script))
            .map_err(|error| unsupported("launcher_missing", &error))
    }

    fn run_process(program: &str, args: &[&str], stdin: Option<&str>) -> Result<String, String> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?;
        if let Some(input) = stdin {
            child
                .stdin
                .take()
                .ok_or_else(|| "WSL stdin is unavailable".to_string())?
                .write_all(input.as_bytes())
                .map_err(|error| error.to_string())?;
        }
        let status = child
            .wait_timeout(TIMEOUT)
            .map_err(|error| error.to_string())?;
        if status.is_none() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("WSL command timed out after 10000ms.".to_string());
        }
        let mut stdout = String::new();
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stdout.take() {
            let _ = pipe.read_to_string(&mut stdout);
        }
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        if status.is_some_and(|value| value.success()) {
            Ok(stdout)
        } else {
            Err(stderr.trim().to_string())
        }
    }

    fn parse_target(content: &str) -> Option<String> {
        let encoded = content
            .lines()
            .find_map(|line| line.strip_prefix("# PEBBLE_WIN_LAUNCHER_B64="))?;
        STANDARD
            .decode(encoded)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
    }

    fn normalize(value: &str) -> String {
        format!("{}\n", value.trim_end())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_and_bridge_keep_markers_and_forward_arguments() {
        let launcher = build_launcher(
            r"C:\Program Files\Pebble\pebble.exe",
            "/home/test/.local/share/pebble/pebble-wsl-bridge.ps1",
        );
        assert!(launcher.contains(MANAGED_MARKER));
        assert_eq!(COMMAND_NAME, "pebble");
        assert_eq!(LEGACY_COMMAND_NAME, "pebble-ide");
        assert!(launcher.contains("PEBBLE_WIN_LAUNCHER_B64="));
        assert!(launcher.contains("wslpath -w"));
        assert!(launcher.contains("\"$@\""));
        assert!(build_bridge().contains(BRIDGE_MARKER));
    }

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(quote_shell("a'b"), "'a'\"'\"'b'");
    }

    #[test]
    fn scripts_install_canonical_command_and_clean_only_managed_legacy_launcher() {
        let ready = ReadyState {
            distro: "Ubuntu".to_string(),
            command_path: "/home/test/.local/bin/pebble".to_string(),
            legacy_command_path: "/home/test/.local/bin/pebble-ide".to_string(),
            bridge_path: "/home/test/.local/share/pebble/pebble-wsl-bridge.ps1".to_string(),
            launcher_path: r"C:\Program Files\Pebble\pebble.exe".to_string(),
            path_configured: true,
        };

        let install = install_script(&ready);
        let remove = remove_script(&ready);
        assert_eq!(ready.distro, "Ubuntu");
        assert!(ready.path_configured);
        assert!(install.contains("command_path='/home/test/.local/bin/pebble'"));
        assert!(install.contains("legacy_command_path='/home/test/.local/bin/pebble-ide'"));
        assert!(install.contains("[ ! -L \"$legacy_command_path\" ]"));
        assert!(remove.contains("[ ! -L \"$legacy_command_path\" ]"));
        assert!(install.contains(MANAGED_MARKER));
        assert!(remove.contains(MANAGED_MARKER));
    }
}
