// Why: mirrors the read-only half of src/main/agent-hooks (Electron) for the
// two agents that share the "Claude-compatible" hooks.json shape (Claude,
// OpenClaude). Electron's install()/remove() write the managed script and
// mutate hooks.json; that mutation path plus the other 12 agents' bespoke
// config formats (Codex trust-key verification, Cursor's flat command
// schema, Amp/Devin/etc.) are not re-implemented here — porting all of them
// correctly is a much bigger lift than this bridge, and a wrong port here
// would misreport install state to the user. Everything besides
// claude/openclaude returns an explicit "not supported in Tauri yet" status
// (never a fake `installed`/`not_installed` guess), matching the honest-gap
// pattern used by computer_permissions.rs on Linux/Windows.
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum AgentHookInstallState {
    Installed,
    NotInstalled,
    Partial,
    Error,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookInstallStatus {
    agent: &'static str,
    state: AgentHookInstallState,
    config_path: String,
    managed_hooks_present: bool,
    detail: Option<String>,
}

/// Events every Claude-compatible managed install registers. Mirrors
/// CLAUDE_EVENTS in src/main/claude/hook-settings.ts.
const CLAUDE_COMPATIBLE_EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "Stop",
    "StopFailure",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
];

struct ClaudeCompatibleSettings {
    agent: &'static str,
    config_dir_name: &'static str,
    script_base_name: &'static str,
}

const CLAUDE_SETTINGS: ClaudeCompatibleSettings = ClaudeCompatibleSettings {
    agent: "claude",
    config_dir_name: ".claude",
    script_base_name: "claude-hook",
};

const OPENCLAUDE_SETTINGS: ClaudeCompatibleSettings = ClaudeCompatibleSettings {
    agent: "openclaude",
    config_dir_name: ".openclaude",
    script_base_name: "openclaude-hook",
};

fn home_dir() -> Option<PathBuf> {
    // PEBBLE_AGENT_HOOKS_HOME is a test seam so tests can point at a temp home
    // without mutating the real $HOME.
    if let Some(over) = std::env::var_os("PEBBLE_AGENT_HOOKS_HOME") {
        return Some(PathBuf::from(over));
    }
    #[cfg(unix)]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
}

fn config_path(settings: &ClaudeCompatibleSettings) -> Option<PathBuf> {
    home_dir().map(|home| home.join(settings.config_dir_name).join("settings.json"))
}

/// Mirrors createManagedCommandMatcher in installer-utils.ts: match on the
/// `agent-hooks/<script>` path fragment rather than reconstructing Electron's
/// exact quoted/wrapped invocation string, since the wrapper differs across
/// platforms (POSIX `if [ -x ... ]` vs Windows Git Bash) but the path
/// fragment is stable and is exactly what real installs and this read-only
/// status check both key off.
fn command_references_managed_script(command: &str, settings: &ClaudeCompatibleSettings) -> bool {
    let script_stem = settings.script_base_name;
    command.contains(&format!("agent-hooks/{script_stem}.sh"))
        || command.contains(&format!("agent-hooks/{script_stem}.cmd"))
}

fn error_status(
    settings: &ClaudeCompatibleSettings,
    config_path: String,
    detail: String,
) -> AgentHookInstallStatus {
    AgentHookInstallStatus {
        agent: settings.agent,
        state: AgentHookInstallState::Error,
        config_path,
        managed_hooks_present: false,
        detail: Some(detail),
    }
}

fn compute_status(settings: &ClaudeCompatibleSettings) -> AgentHookInstallStatus {
    let Some(config_path) = config_path(settings) else {
        return error_status(
            settings,
            String::new(),
            "Could not resolve the home directory.".to_string(),
        );
    };
    let config_path_string = config_path.to_string_lossy().into_owned();

    // Why: matches readHooksJson — a missing file is a valid "nothing
    // installed yet" state, not an error.
    let raw = match fs::read(&config_path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return AgentHookInstallStatus {
                agent: settings.agent,
                state: AgentHookInstallState::NotInstalled,
                config_path: config_path_string,
                managed_hooks_present: false,
                detail: None,
            };
        }
        Err(err) => {
            return error_status(
                settings,
                config_path_string,
                format!("Could not read {}: {err}", config_path.display()),
            );
        }
    };

    let parsed: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(value) => value,
        Err(_) => {
            return error_status(
                settings,
                config_path_string,
                format!("Could not parse {} settings.json", settings.agent),
            );
        }
    };

    let hooks = parsed.get("hooks").and_then(|v| v.as_object());
    let mut present_count = 0usize;
    let mut missing: Vec<&str> = Vec::new();
    for event in CLAUDE_COMPATIBLE_EVENTS {
        let has_command = hooks
            .and_then(|h| h.get(*event))
            .and_then(|defs| defs.as_array())
            .map(|defs| {
                defs.iter().any(|definition| {
                    definition
                        .get("hooks")
                        .and_then(|inner| inner.as_array())
                        .map(|inner_hooks| {
                            inner_hooks.iter().any(|hook| {
                                hook.get("command")
                                    .and_then(|c| c.as_str())
                                    .map(|command| {
                                        command_references_managed_script(command, settings)
                                    })
                                    .unwrap_or(false)
                            })
                        })
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if has_command {
            present_count += 1;
        } else {
            missing.push(event);
        }
    }

    let managed_hooks_present = present_count > 0;
    let (state, detail) = if missing.is_empty() {
        (AgentHookInstallState::Installed, None)
    } else if present_count == 0 {
        (AgentHookInstallState::NotInstalled, None)
    } else {
        (
            AgentHookInstallState::Partial,
            Some(format!("Managed hook missing for events: {}", missing.join(", "))),
        )
    };

    AgentHookInstallStatus {
        agent: settings.agent,
        state,
        config_path: config_path_string,
        managed_hooks_present,
        detail,
    }
}

fn unsupported_status(agent: &'static str) -> AgentHookInstallStatus {
    AgentHookInstallStatus {
        agent,
        state: AgentHookInstallState::Error,
        config_path: String::new(),
        managed_hooks_present: false,
        detail: Some(
            "Agent hook status for this agent is not yet implemented in the Tauri desktop shell."
                .to_string(),
        ),
    }
}

#[tauri::command]
pub fn agent_hooks_claude_status() -> AgentHookInstallStatus {
    compute_status(&CLAUDE_SETTINGS)
}

#[tauri::command]
pub fn agent_hooks_openclaude_status() -> AgentHookInstallStatus {
    compute_status(&OPENCLAUDE_SETTINGS)
}

#[tauri::command]
pub fn agent_hooks_codex_status() -> AgentHookInstallStatus {
    unsupported_status("codex")
}

#[tauri::command]
pub fn agent_hooks_gemini_status() -> AgentHookInstallStatus {
    unsupported_status("gemini")
}

#[tauri::command]
pub fn agent_hooks_antigravity_status() -> AgentHookInstallStatus {
    unsupported_status("antigravity")
}

#[tauri::command]
pub fn agent_hooks_amp_status() -> AgentHookInstallStatus {
    unsupported_status("amp")
}

#[tauri::command]
pub fn agent_hooks_cursor_status() -> AgentHookInstallStatus {
    unsupported_status("cursor")
}

#[tauri::command]
pub fn agent_hooks_droid_status() -> AgentHookInstallStatus {
    unsupported_status("droid")
}

#[tauri::command]
pub fn agent_hooks_command_code_status() -> AgentHookInstallStatus {
    unsupported_status("command-code")
}

#[tauri::command]
pub fn agent_hooks_grok_status() -> AgentHookInstallStatus {
    unsupported_status("grok")
}

#[tauri::command]
pub fn agent_hooks_copilot_status() -> AgentHookInstallStatus {
    unsupported_status("copilot")
}

#[tauri::command]
pub fn agent_hooks_hermes_status() -> AgentHookInstallStatus {
    unsupported_status("hermes")
}

#[tauri::command]
pub fn agent_hooks_devin_status() -> AgentHookInstallStatus {
    unsupported_status("devin")
}

#[tauri::command]
pub fn agent_hooks_kimi_status() -> AgentHookInstallStatus {
    unsupported_status("kimi")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_GUARD: Mutex<()> = Mutex::new(());

    struct Scope {
        _dir: tempfile::TempDir,
    }

    fn scope() -> Scope {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("PEBBLE_AGENT_HOOKS_HOME", dir.path());
        Scope { _dir: dir }
    }

    fn write_settings(dir: &std::path::Path, config_dir: &str, body: &str) {
        let config_dir_path = dir.join(config_dir);
        fs::create_dir_all(&config_dir_path).unwrap();
        fs::write(config_dir_path.join("settings.json"), body).unwrap();
    }

    #[test]
    fn missing_config_file_is_not_installed() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let status = compute_status(&CLAUDE_SETTINGS);
        assert!(matches!(status.state, AgentHookInstallState::NotInstalled));
        assert!(!status.managed_hooks_present);
        drop(scope);
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn unparseable_config_file_is_error() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        write_settings(scope._dir.path(), ".claude", "not json");
        let status = compute_status(&CLAUDE_SETTINGS);
        assert!(matches!(status.state, AgentHookInstallState::Error));
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn all_managed_events_present_is_installed() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let command = "if [ -x '/home/user/.pebble/agent-hooks/claude-hook.sh' ]; then /bin/sh '/home/user/.pebble/agent-hooks/claude-hook.sh'; fi";
        let hooks_json: serde_json::Value = serde_json::json!({
            "hooks": {
                "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": command }] }],
                "Stop": [{ "hooks": [{ "type": "command", "command": command }] }],
                "StopFailure": [{ "hooks": [{ "type": "command", "command": command }] }],
                "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": command }] }],
                "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": command }] }],
                "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": command }] }],
                "PermissionRequest": [{ "matcher": "*", "hooks": [{ "type": "command", "command": command }] }],
            }
        });
        write_settings(
            scope._dir.path(),
            ".claude",
            &serde_json::to_string(&hooks_json).unwrap(),
        );
        let status = compute_status(&CLAUDE_SETTINGS);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        assert!(status.managed_hooks_present);
        assert!(status.detail.is_none());
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn some_managed_events_missing_is_partial() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let command = "/bin/sh '/home/user/.pebble/agent-hooks/claude-hook.sh'";
        let hooks_json: serde_json::Value = serde_json::json!({
            "hooks": {
                "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": command }] }],
            }
        });
        write_settings(
            scope._dir.path(),
            ".claude",
            &serde_json::to_string(&hooks_json).unwrap(),
        );
        let status = compute_status(&CLAUDE_SETTINGS);
        assert!(matches!(status.state, AgentHookInstallState::Partial));
        assert!(status.managed_hooks_present);
        assert!(status.detail.is_some());
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn no_managed_events_present_is_not_installed_even_with_other_hooks() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let hooks_json: serde_json::Value = serde_json::json!({
            "hooks": {
                "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "echo unrelated" }] }],
            }
        });
        write_settings(
            scope._dir.path(),
            ".claude",
            &serde_json::to_string(&hooks_json).unwrap(),
        );
        let status = compute_status(&CLAUDE_SETTINGS);
        assert!(matches!(status.state, AgentHookInstallState::NotInstalled));
        assert!(!status.managed_hooks_present);
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn openclaude_uses_its_own_config_dir_and_script_name() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        // Why: a claude-hook command in .openclaude/settings.json must not
        // count for openclaude — each agent's managed script name is distinct.
        let command = "/bin/sh '/home/user/.pebble/agent-hooks/claude-hook.sh'";
        let hooks_json: serde_json::Value = serde_json::json!({
            "hooks": {
                "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": command }] }],
            }
        });
        write_settings(
            scope._dir.path(),
            ".openclaude",
            &serde_json::to_string(&hooks_json).unwrap(),
        );
        let status = compute_status(&OPENCLAUDE_SETTINGS);
        assert!(matches!(status.state, AgentHookInstallState::NotInstalled));
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn unsupported_agents_report_explicit_gap() {
        let status = unsupported_status("cursor");
        assert!(matches!(status.state, AgentHookInstallState::Error));
        assert_eq!(status.agent, "cursor");
        assert!(status.detail.unwrap().contains("not yet implemented"));
    }
}
