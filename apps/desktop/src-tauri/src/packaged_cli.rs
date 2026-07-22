use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const CONTROL_COMMANDS: &[&str] = &[
    "agent",
    "automation",
    "automations",
    "browser",
    "computer",
    "dispatch",
    "emulator",
    "events",
    "external-task",
    "file",
    "git",
    "message",
    "mobile-relay",
    "project",
    "provider",
    "release",
    "serve",
    "session",
    "settings",
    "source-control",
    "status",
    "subsystem",
    "task",
    "worktree",
];

const PUBLIC_CLI_COMMANDS: &[&str] = &[
    "agent",
    "agent-teams-tmux",
    "automations",
    "back",
    "check",
    "claude-teams",
    "clear",
    "click",
    "clipboard",
    "computer",
    "dblclick",
    "diagnostics",
    "dialog",
    "download",
    "drag",
    "emulator",
    "environment",
    "eval",
    "exec",
    "file",
    "fill",
    "find",
    "focus",
    "forward",
    "get",
    "goto",
    "highlight",
    "hover",
    "inserttext",
    "is",
    "keypress",
    "linear",
    "mouse",
    "open",
    "orchestration",
    "project",
    "reload",
    "repo",
    "screenshot",
    "scroll",
    "scrollintoview",
    "select",
    "serve",
    "set",
    "snapshot",
    "status",
    "storage",
    "tab",
    "terminal",
    "type",
    "uncheck",
    "upload",
    "vm",
    "wait",
    "worktree",
];

pub fn dispatch_if_requested() -> Option<i32> {
    let args = env::args_os().skip(1).collect::<Vec<_>>();
    let command = requested_command(&args)?;
    match command.as_str() {
        "open" => Some(open_desktop().unwrap_or_else(report_error)),
        "version" => {
            println!("Pebble {}", env!("CARGO_PKG_VERSION"));
            Some(0)
        }
        "help" => Some(run_control(&args).unwrap_or_else(report_error)),
        command if CONTROL_COMMANDS.contains(&command) => {
            Some(run_control(&translate_legacy_serve_args(&args)).unwrap_or_else(report_error))
        }
        command => {
            eprintln!(
                "Pebble CLI command '{command}' has not migrated to the native packaged CLI yet."
            );
            Some(2)
        }
    }
}

fn requested_command(args: &[OsString]) -> Option<String> {
    if args.is_empty() {
        return None;
    }
    let first = args[0].to_string_lossy();
    if first.starts_with("pebble://") || first.starts_with("-psn_") {
        return None;
    }
    if first == "--serve" {
        return Some("serve".to_string());
    }
    if first == "--version" || first == "-V" {
        return Some("version".to_string());
    }
    if first == "--help" || first == "-h" {
        return Some("help".to_string());
    }
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        if value == "--endpoint" || value == "--token" {
            index += 2;
            continue;
        }
        if value.starts_with("--endpoint=") || value.starts_with("--token=") {
            index += 1;
            continue;
        }
        if value == "open"
            || CONTROL_COMMANDS.contains(&value.as_ref())
            || PUBLIC_CLI_COMMANDS.contains(&value.as_ref())
        {
            return Some(value.into_owned());
        }
        // Only no-argument, deep-link, and platform activation paths may open
        // the GUI. A command-shaped typo must fail as CLI input, not open a window.
        return Some("invalid".to_string());
    }
    // Non-empty argv that contains only global CLI options is still CLI input.
    // Returning None here would incorrectly activate the desktop window.
    Some("invalid".to_string())
}

fn translate_legacy_serve_args(args: &[OsString]) -> Vec<OsString> {
    if args.first().and_then(|value| value.to_str()) != Some("--serve") {
        return args.to_vec();
    }
    let mut translated = vec![OsString::from("serve")];
    for arg in &args[1..] {
        let value = match arg.to_str() {
            Some("--serve-json") => "--json",
            Some("--serve-port") => "--port",
            Some("--serve-pairing-address") => "--pairing-address",
            Some("--serve-no-pairing") => "--no-pairing",
            Some("--serve-mobile-pairing") => "--mobile-pairing",
            Some("--serve-recipe-json") => "--recipe-json",
            Some("--serve-project-root") => "--project-root",
            _ => {
                translated.push(arg.clone());
                continue;
            }
        };
        translated.push(OsString::from(value));
    }
    translated
}

fn run_control(args: &[OsString]) -> Result<i32, String> {
    let mut command = control_command(args)?;
    let status = command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| format!("Could not start Pebble CLI: {error}"))?;
    Ok(status.code().unwrap_or(1))
}

fn control_command(args: &[OsString]) -> Result<Command, String> {
    if let Some(binary) = sibling_binary("pebble-control") {
        let mut command = Command::new(binary);
        command.args(args);
        return Ok(command);
    }
    let go_root = find_go_root().ok_or_else(|| {
        "Could not locate the bundled pebble-control executable. Reinstall Pebble.".to_string()
    })?;
    let mut command = Command::new("go");
    command
        .current_dir(go_root)
        .args(["run", "./cmd/pebble-control"])
        .args(args);
    Ok(command)
}

fn open_desktop() -> Result<i32, String> {
    #[cfg(target_os = "macos")]
    if let Some(bundle) = macos_app_bundle() {
        Command::new("open")
            .arg(bundle)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not open Pebble: {error}"))?;
        return Ok(0);
    }

    let executable = env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| env::current_exe().ok())
        .ok_or_else(|| "Could not resolve the Pebble desktop executable.".to_string())?;
    let mut command = Command::new(executable);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_detached(&mut command);
    command
        .spawn()
        .map_err(|error| format!("Could not open Pebble: {error}"))?;
    Ok(0)
}

#[cfg(target_os = "windows")]
fn configure_detached(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
}

#[cfg(not(target_os = "windows"))]
fn configure_detached(_command: &mut Command) {}

#[cfg(target_os = "macos")]
fn macos_app_bundle() -> Option<PathBuf> {
    let executable = env::current_exe().ok()?;
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (bundle.extension() == Some(OsStr::new("app"))).then(|| bundle.to_path_buf())
}

fn sibling_binary(name: &str) -> Option<PathBuf> {
    let parent = env::current_exe().ok()?.parent()?.to_path_buf();
    let candidate = parent.join(platform_binary_name(name));
    candidate.is_file().then_some(candidate)
}

fn platform_binary_name(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn find_go_root() -> Option<PathBuf> {
    let mut starts = Vec::new();
    if let Ok(cwd) = env::current_dir() {
        starts.push(cwd);
    }
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        starts.push(PathBuf::from(manifest));
    }
    for start in starts {
        for ancestor in start.ancestors() {
            let candidate = ancestor.join("runtime/go/cmd/pebble-control");
            if fs::metadata(candidate)
                .map(|info| info.is_dir())
                .unwrap_or(false)
            {
                return Some(ancestor.join("runtime/go"));
            }
        }
    }
    None
}

fn report_error(error: String) -> i32 {
    eprintln!("{error}");
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn distinguishes_gui_activation_from_cli_commands() {
        assert_eq!(requested_command(&[]), None);
        assert_eq!(requested_command(&args(&["pebble://settings"])), None);
        assert_eq!(requested_command(&args(&["-psn_0_123"])), None);
        assert_eq!(
            requested_command(&args(&["status"])),
            Some("status".to_string())
        );
        assert_eq!(
            requested_command(&args(&["--endpoint", "http://host", "project"])),
            Some("project".to_string())
        );
        assert_eq!(
            requested_command(&args(&["terminal", "list"])),
            Some("terminal".to_string())
        );
        assert_eq!(
            requested_command(&args(&["screenshot", "--format", "png"])),
            Some("screenshot".to_string())
        );
        assert_eq!(
            requested_command(&args(&["definitely-not-a-command"])),
            Some("invalid".to_string())
        );
        assert_eq!(
            requested_command(&args(&["--endpoint"])),
            Some("invalid".to_string())
        );
        assert_eq!(
            requested_command(&args(&["--endpoint", "http://host"])),
            Some("invalid".to_string())
        );
        assert_eq!(
            requested_command(&args(&["--token=secret"])),
            Some("invalid".to_string())
        );
    }

    #[test]
    fn translates_every_node_serve_bridge_flag() {
        assert_eq!(
            translate_legacy_serve_args(&args(&[
                "--serve",
                "--serve-json",
                "--serve-port",
                "6768",
                "--serve-pairing-address",
                "wss://example.test",
                "--serve-no-pairing",
                "--serve-mobile-pairing",
                "--serve-recipe-json",
                "--serve-project-root",
                "/repo",
            ])),
            args(&[
                "serve",
                "--json",
                "--port",
                "6768",
                "--pairing-address",
                "wss://example.test",
                "--no-pairing",
                "--mobile-pairing",
                "--recipe-json",
                "--project-root",
                "/repo",
            ])
        );
    }
}
