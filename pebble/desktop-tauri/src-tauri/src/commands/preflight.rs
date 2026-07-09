use std::{
    collections::HashSet,
    env,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};

/// Mirrors the Electron preflight command budget in
/// `src/main/ipc/preflight-command-exec.ts` so auth probes and shell hydration
/// cannot block the Landing/Agents panes indefinitely.
const PREFLIGHT_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightDetectCommandsInput {
    commands: Vec<String>,
}

#[tauri::command]
pub fn preflight_detect_commands(input: PreflightDetectCommandsInput) -> Vec<String> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for command in input.commands {
        let command = command.trim();
        if command.is_empty() || !seen.insert(command.to_string()) {
            continue;
        }
        if is_command_on_path(command) {
            found.push(command.to_string());
        }
    }
    found
}

fn is_command_on_path(command: &str) -> bool {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 {
        return is_executable_file(command_path);
    }
    search_path_dirs()
        .into_iter()
        .flat_map(|dir| {
            executable_names(command)
                .into_iter()
                .map(move |name| dir.join(name))
        })
        .any(|candidate| is_executable_file(&candidate))
}

fn search_path_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path_env) = env::var_os("PATH") {
        dirs.extend(env::split_paths(&path_env));
    }
    dirs.extend(common_agent_install_dirs());
    dedupe_paths(dirs)
}

fn common_agent_install_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join(".bun/bin"));
        dirs.push(home.join(".deno/bin"));
        dirs.push(home.join(".npm-global/bin"));
        dirs.push(home.join("Library/pnpm"));
        dirs.push(home.join("Library/Application Support/fnm"));
        dirs.push(home.join("AppData/Roaming/npm"));
        dirs.push(home.join("AppData/Local/Microsoft/WinGet/Packages"));
    }
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs
}

fn executable_names(command: &str) -> Vec<String> {
    if cfg!(windows) {
        let extensions =
            env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD;.PS1".to_string());
        let has_extension = Path::new(command).extension().is_some();
        if has_extension {
            return vec![command.to_string()];
        }
        return extensions
            .split(';')
            .filter(|extension| !extension.trim().is_empty())
            .map(|extension| format!("{command}{}", extension.to_ascii_lowercase()))
            .chain(std::iter::once(command.to_string()))
            .collect();
    }
    vec![command.to_string()]
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightProbeAuthInput {
    /// CLI names to probe (e.g. `["gh", "glab"]`). Only installed binaries are
    /// probed; missing binaries report `installed: false`.
    commands: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightAuthStatus {
    command: String,
    installed: bool,
    authenticated: bool,
}

/// Probe `<cli> auth status` for each requested provider CLI, mirroring
/// `isGhAuthenticated`/`isGlabAuthenticated` in `src/main/ipc/preflight.ts`:
/// the binary must be on PATH, exit 0 means authenticated, and a non-zero exit
/// whose output still carries success markers is treated as authenticated to
/// avoid a false "not signed in" warning.
#[tauri::command]
pub fn preflight_probe_auth(input: PreflightProbeAuthInput) -> Vec<PreflightAuthStatus> {
    let mut seen = HashSet::new();
    input
        .commands
        .into_iter()
        .filter_map(|command| {
            let command = command.trim().to_string();
            if command.is_empty() || !seen.insert(command.clone()) {
                return None;
            }
            Some(probe_command_auth(command))
        })
        .collect()
}

fn probe_command_auth(command: String) -> PreflightAuthStatus {
    if !is_command_on_path(&command) {
        return PreflightAuthStatus {
            command,
            installed: false,
            authenticated: false,
        };
    }
    let authenticated = run_auth_status(&command);
    PreflightAuthStatus {
        command,
        installed: true,
        authenticated,
    }
}

fn run_auth_status(command: &str) -> bool {
    let Some(output) = run_command_with_timeout(command, &["auth", "status"]) else {
        return false;
    };
    if output.success {
        // Why: `<cli> auth status` exits 0 when the CLI found no auth issues for
        // the checked hosts/accounts — matches the Electron reference.
        return true;
    }
    // Why: some CLI versions/environments exit non-zero while still printing
    // success markers (gh writes to stderr; glab varies). Mirror the Electron
    // fallback so a healthy login is not reported as a warning.
    let combined = format!("{}\n{}", output.stdout, output.stderr);
    combined.contains("Logged in") || combined.contains("Active account: true")
}

struct CommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Spawn a child process and wait at most `PREFLIGHT_COMMAND_TIMEOUT` for it.
/// Returns `None` when the binary cannot be spawned or the wait times out (the
/// child is killed). Uses a worker thread + channel because std has no native
/// bounded `wait`, and we avoid adding a tokio process dependency.
fn run_command_with_timeout(command: &str, args: &[&str]) -> Option<CommandOutput> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;

    // Why: drain stdout/stderr on dedicated threads *before* waiting. A verbose
    // rc-file banner or long `auth status` output can otherwise fill a pipe
    // buffer and deadlock the child before it exits.
    let stdout_reader = spawn_pipe_reader(child.stdout.take());
    let stderr_reader = spawn_pipe_reader(child.stderr.take());

    let (tx, rx) = mpsc::channel();
    let waiter = thread::spawn(move || {
        let status = child.wait();
        let stdout = stdout_reader.join().unwrap_or_default();
        let stderr = stderr_reader.join().unwrap_or_default();
        let _ = tx.send(status.map(|status| CommandOutput {
            success: status.success(),
            stdout,
            stderr,
        }));
    });

    match rx.recv_timeout(PREFLIGHT_COMMAND_TIMEOUT) {
        Ok(result) => {
            let _ = waiter.join();
            result.ok()
        }
        // Why: on timeout the waiter thread still owns the child. It is detached
        // and will reap the process once the OS eventually terminates it; we
        // simply report failure rather than block the caller.
        Err(_) => None,
    }
}

fn spawn_pipe_reader<R: Read + Send + 'static>(pipe: Option<R>) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut buffer = String::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_string(&mut buffer);
        }
        buffer
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightShellPath {
    /// Newline-free PATH the login shell exports, empty when hydration failed.
    segments: Vec<String>,
    /// True only when the shell spawn produced a usable PATH.
    ok: bool,
    /// `'shell_hydrate'` on success, else `'sync_seed_only'` — matches the
    /// `PathSource` alias consumed by the renderer.
    path_source: &'static str,
    /// Classified failure mode (`'none'` on success), matching the
    /// `ShellHydrationFailureReason` alias.
    path_failure_reason: &'static str,
}

const SHELL_PATH_DELIMITER: &str = "__PEBBLE_SHELL_PATH__";

/// Spawn the user's login+interactive shell and read the PATH it exports,
/// mirroring `hydrateShellPath` in `src/main/startup/hydrate-shell-path.ts`.
/// GUI launches inherit a minimal PATH that omits user rc-file additions, so we
/// ask the shell itself. Windows has no POSIX login shell, so it reports
/// `no_shell` and the caller falls back to the existing process PATH.
#[tauri::command]
pub fn preflight_hydrate_shell_path() -> PreflightShellPath {
    let Some(shell) = pick_login_shell() else {
        return shell_path_failure("no_shell");
    };
    match spawn_shell_and_read_path(&shell) {
        Some(segments) if !segments.is_empty() => PreflightShellPath {
            segments,
            ok: true,
            path_source: "shell_hydrate",
            path_failure_reason: "none",
        },
        Some(_) => shell_path_failure("empty_path"),
        None => shell_path_failure("spawn_error"),
    }
}

fn shell_path_failure(reason: &'static str) -> PreflightShellPath {
    PreflightShellPath {
        segments: Vec::new(),
        ok: false,
        path_source: "sync_seed_only",
        path_failure_reason: reason,
    }
}

fn pick_login_shell() -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    if let Ok(shell) = env::var("SHELL") {
        if !shell.is_empty() {
            return Some(shell);
        }
    }
    if cfg!(target_os = "macos") {
        Some("/bin/zsh".to_string())
    } else {
        Some("/bin/bash".to_string())
    }
}

fn spawn_shell_and_read_path(shell: &str) -> Option<Vec<String>> {
    // Why: bracketing PATH between delimiters and printing via printf is
    // resilient to rc-file banners/MOTDs; `-ilc` sources login + interactive
    // rc files so we see the same PATH as `which` in a terminal.
    let script = format!(
        "printf '%s' '{delim}'; printf '%s' \"$PATH\"; printf '%s' '{delim}'",
        delim = SHELL_PATH_DELIMITER
    );
    let output = run_command_with_timeout(shell, &["-ilc", &script])?;
    Some(parse_captured_path(&output.stdout))
}

fn parse_captured_path(stdout: &str) -> Vec<String> {
    let cleaned = strip_ansi_sequences(stdout);
    let Some(start) = cleaned.find(SHELL_PATH_DELIMITER) else {
        return Vec::new();
    };
    let value_start = start + SHELL_PATH_DELIMITER.len();
    let Some(end) = cleaned[value_start..].find(SHELL_PATH_DELIMITER) else {
        return Vec::new();
    };
    let value = cleaned[value_start..value_start + end].trim();
    if value.is_empty() {
        return Vec::new();
    }
    // Why: PATH resolution is first-match-wins, so de-dupe while preserving the
    // shell's ordering.
    let mut seen = HashSet::new();
    value
        .split(path_list_separator())
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .filter(|segment| seen.insert(segment.to_string()))
        .map(ToOwned::to_owned)
        .collect()
}

fn path_list_separator() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

/// Strip ANSI escape sequences that leak in when rc files print colored
/// prompts/banners, mirroring the `ANSI_RE` scrub in the Electron reference.
fn strip_ansi_sequences(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            while let Some(&next) = chars.peek() {
                chars.next();
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_captured_path_extracts_deduped_ordered_segments() {
        let sep = path_list_separator();
        let stdout = format!(
            "banner\n{delim}/opt/bin{sep}/usr/bin{sep}/opt/bin{delim}trailing",
            delim = SHELL_PATH_DELIMITER
        );
        let segments = parse_captured_path(&stdout);
        assert_eq!(
            segments,
            vec!["/opt/bin".to_string(), "/usr/bin".to_string()]
        );
    }

    #[test]
    fn parse_captured_path_returns_empty_without_delimiters() {
        assert!(parse_captured_path("no markers here").is_empty());
    }

    #[test]
    fn strip_ansi_sequences_removes_color_codes() {
        let input = "\u{1b}[32m/opt/bin\u{1b}[0m";
        assert_eq!(strip_ansi_sequences(input), "/opt/bin");
    }

    #[test]
    fn executable_names_include_windows_extensions() {
        let names = executable_names("codex");
        if cfg!(windows) {
            assert!(names.iter().any(|name| name == "codex.exe"));
        } else {
            assert_eq!(names, vec!["codex"]);
        }
    }
}
