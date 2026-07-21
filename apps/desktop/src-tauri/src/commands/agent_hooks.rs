// Why: the canonical Tauri hook surface owns Claude-compatible settings here
// and delegates every agent-specific schema to the focused modules below, so
// status and mutation never fall back to Electron or a guessed install state.
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[path = "agent_hooks_amp.rs"]
mod agent_hooks_amp;
#[path = "agent_hooks_antigravity.rs"]
mod agent_hooks_antigravity;
#[path = "agent_hooks_codex.rs"]
mod agent_hooks_codex;
#[path = "agent_hooks_command_code.rs"]
mod agent_hooks_command_code;
#[path = "agent_hooks_copilot.rs"]
mod agent_hooks_copilot;
#[path = "agent_hooks_cursor.rs"]
mod agent_hooks_cursor;
#[path = "agent_hooks_devin.rs"]
mod agent_hooks_devin;
#[path = "agent_hooks_droid.rs"]
mod agent_hooks_droid;
#[path = "agent_hooks_gemini.rs"]
mod agent_hooks_gemini;
#[path = "agent_hooks_grok.rs"]
mod agent_hooks_grok;
#[path = "agent_hooks_hermes.rs"]
mod agent_hooks_hermes;
#[path = "agent_hooks_kimi.rs"]
mod agent_hooks_kimi;

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
/// Keep this list aligned with the Claude hook events Pebble installs.
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

fn managed_script_path(settings: &ClaudeCompatibleSettings) -> Option<PathBuf> {
    let extension = if cfg!(windows) { "cmd" } else { "sh" };
    home_dir().map(|home| {
        home.join(".pebble")
            .join("agent-hooks")
            .join(format!("{}.{}", settings.script_base_name, extension))
    })
}

fn managed_command(settings: &ClaudeCompatibleSettings) -> Option<String> {
    let path = managed_script_path(settings)?;
    if cfg!(windows) {
        use base64::Engine;
        let path = path.to_string_lossy().replace('\'', "''");
        let powershell = format!("& '{path}'; exit $LASTEXITCODE");
        let utf16le: Vec<u8> = powershell
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(utf16le);
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        return Some(format!(
            "{}/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand {encoded}",
            system_root.replace('\\', "/")
        ));
    }
    let quoted = path.to_string_lossy().replace('\'', "'\\''");
    Some(format!("if [ -x '{quoted}' ]; then /bin/sh '{quoted}'; fi"))
}

fn managed_script(settings: &ClaudeCompatibleSettings) -> String {
    if cfg!(windows) {
        return format!(
            "@echo off\r\nsetlocal\r\nif \"%PEBBLE_AGENT_HOOK_PORT%\"==\"\" exit /b 0\r\nif \"%PEBBLE_AGENT_HOOK_TOKEN%\"==\"\" exit /b 0\r\nif \"%PEBBLE_PANE_KEY%\"==\"\" exit /b 0\r\n\"%SystemRoot%\\System32\\curl.exe\" -sS -X POST \"http://127.0.0.1:%PEBBLE_AGENT_HOOK_PORT%/hook/{}\" --connect-timeout 0.5 --max-time 1.5 -H \"Content-Type: application/x-www-form-urlencoded\" -H \"X-Pebble-Agent-Hook-Token: %PEBBLE_AGENT_HOOK_TOKEN%\" --data-urlencode \"paneKey=%PEBBLE_PANE_KEY%\" --data-urlencode \"tabId=%PEBBLE_TAB_ID%\" --data-urlencode \"launchToken=%PEBBLE_AGENT_LAUNCH_TOKEN%\" --data-urlencode \"worktreeId=%PEBBLE_WORKTREE_ID%\" --data-urlencode \"env=%PEBBLE_AGENT_HOOK_ENV%\" --data-urlencode \"version=%PEBBLE_AGENT_HOOK_VERSION%\" --data-urlencode \"payload@-\" >nul 2>&1\r\nexit /b 0\r\n",
            settings.agent
        );
    }
    format!(
        "#!/bin/sh\nif [ -n \"$PEBBLE_AGENT_HOOK_ENDPOINT\" ] && [ -r \"$PEBBLE_AGENT_HOOK_ENDPOINT\" ]; then\n  . \"$PEBBLE_AGENT_HOOK_ENDPOINT\" 2>/dev/null || :\nfi\nif [ -z \"$PEBBLE_AGENT_HOOK_PORT\" ] || [ -z \"$PEBBLE_AGENT_HOOK_TOKEN\" ] || [ -z \"$PEBBLE_PANE_KEY\" ]; then\n  exit 0\nfi\npayload=$(cat)\nif [ -z \"$payload\" ]; then\n  exit 0\nfi\nprintf '%s' \"$payload\" | curl -sS -X POST \"http://127.0.0.1:${{PEBBLE_AGENT_HOOK_PORT}}/hook/{}\" \\\n  --connect-timeout 0.5 --max-time 1.5 \\\n  -H \"Content-Type: application/x-www-form-urlencoded\" \\\n  -H \"X-Pebble-Agent-Hook-Token: ${{PEBBLE_AGENT_HOOK_TOKEN}}\" \\\n  --data-urlencode \"paneKey=${{PEBBLE_PANE_KEY}}\" \\\n  --data-urlencode \"tabId=${{PEBBLE_TAB_ID}}\" \\\n  --data-urlencode \"launchToken=${{PEBBLE_AGENT_LAUNCH_TOKEN}}\" \\\n  --data-urlencode \"worktreeId=${{PEBBLE_WORKTREE_ID}}\" \\\n  --data-urlencode \"env=${{PEBBLE_AGENT_HOOK_ENV}}\" \\\n  --data-urlencode \"version=${{PEBBLE_AGENT_HOOK_VERSION}}\" \\\n  --data-urlencode \"payload@-\" >/dev/null 2>&1 || true\nexit 0\n",
        settings.agent
    )
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
            Some(format!(
                "Managed hook missing for events: {}",
                missing.join(", ")
            )),
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

fn read_settings_for_mutation(path: &Path) -> Result<serde_json::Value, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| format!("Could not parse {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(error) => Err(format!("Could not read {}: {error}", path.display())),
    }
}

fn write_json_atomically(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Agent hook config path has no parent.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let temporary = parent.join(format!(".settings.{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Could not serialize agent hook settings: {error}"))?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Could not replace {}: {error}", path.display())
    })
}

fn is_managed_definition(value: &serde_json::Value, settings: &ClaudeCompatibleSettings) -> bool {
    value
        .get("hooks")
        .and_then(serde_json::Value::as_array)
        .map(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(serde_json::Value::as_str)
                    .map(|command| command_references_managed_script(command, settings))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn remove_managed_definitions(root: &mut serde_json::Value, settings: &ClaudeCompatibleSettings) {
    let Some(hooks) = root
        .get_mut("hooks")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    hooks.retain(|_, definitions| {
        let Some(items) = definitions.as_array_mut() else {
            return true;
        };
        items.retain(|definition| !is_managed_definition(definition, settings));
        !items.is_empty()
    });
}

fn install_claude_compatible(
    settings: &'static ClaudeCompatibleSettings,
) -> AgentHookInstallStatus {
    let Some(config_path) = config_path(settings) else {
        return error_status(
            settings,
            String::new(),
            "Could not resolve home directory.".into(),
        );
    };
    let Some(script_path) = managed_script_path(settings) else {
        return error_status(
            settings,
            config_path.display().to_string(),
            "Could not resolve script path.".into(),
        );
    };
    let result = (|| -> Result<(), String> {
        let mut root = read_settings_for_mutation(&config_path)?;
        if !root.is_object() {
            return Err(format!(
                "{} must contain a JSON object",
                config_path.display()
            ));
        }
        remove_managed_definitions(&mut root, settings);
        let hooks = root
            .as_object_mut()
            .expect("validated object")
            .entry("hooks")
            .or_insert_with(|| serde_json::json!({}));
        let hooks = hooks
            .as_object_mut()
            .ok_or_else(|| "Agent hooks setting must be an object.".to_string())?;
        let command =
            managed_command(settings).ok_or_else(|| "Could not build hook command.".to_string())?;
        for event in CLAUDE_COMPATIBLE_EVENTS {
            let matcher = matches!(
                *event,
                "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PermissionRequest"
            );
            let mut definition = serde_json::json!({
                "hooks": [{ "type": "command", "command": command }]
            });
            if matcher {
                definition["matcher"] = serde_json::Value::String("*".into());
            }
            hooks
                .entry((*event).to_string())
                .or_insert_with(|| serde_json::json!([]))
                .as_array_mut()
                .ok_or_else(|| format!("Hook definitions for {event} must be an array."))?
                .push(definition);
        }
        if let Some(parent) = script_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create hook script directory: {error}"))?;
        }
        fs::write(&script_path, managed_script(settings))
            .map_err(|error| format!("Could not write {}: {error}", script_path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script_path, fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("Could not make hook executable: {error}"))?;
        }
        // Settings are written last so no active hook points at a missing script.
        write_json_atomically(&config_path, &root)
    })();
    match result {
        Ok(()) => compute_status(settings),
        Err(detail) => error_status(settings, config_path.display().to_string(), detail),
    }
}

fn remove_claude_compatible(settings: &'static ClaudeCompatibleSettings) -> AgentHookInstallStatus {
    let Some(config_path) = config_path(settings) else {
        return error_status(
            settings,
            String::new(),
            "Could not resolve home directory.".into(),
        );
    };
    let result = (|| -> Result<(), String> {
        let mut root = read_settings_for_mutation(&config_path)?;
        remove_managed_definitions(&mut root, settings);
        write_json_atomically(&config_path, &root)?;
        if let Some(script_path) = managed_script_path(settings) {
            match fs::remove_file(script_path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("Could not remove managed hook script: {error}")),
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => compute_status(settings),
        Err(detail) => error_status(settings, config_path.display().to_string(), detail),
    }
}

#[tauri::command]
pub fn agent_hooks_apply_claude_compatible(enabled: bool) -> Vec<AgentHookInstallStatus> {
    [&CLAUDE_SETTINGS, &OPENCLAUDE_SETTINGS]
        .into_iter()
        .map(|settings| {
            if enabled {
                install_claude_compatible(settings)
            } else {
                remove_claude_compatible(settings)
            }
        })
        .collect()
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
pub fn agent_hooks_gemini_status() -> AgentHookInstallStatus {
    agent_hooks_gemini::status()
}

#[tauri::command]
pub fn agent_hooks_cursor_status() -> AgentHookInstallStatus {
    agent_hooks_cursor::status()
}

#[tauri::command]
pub fn agent_hooks_apply_cursor(enabled: bool) -> AgentHookInstallStatus {
    agent_hooks_cursor::apply(enabled)
}

#[tauri::command]
pub fn agent_hooks_droid_status() -> AgentHookInstallStatus {
    agent_hooks_droid::status()
}

#[tauri::command]
pub fn agent_hooks_apply_droid(enabled: bool) -> AgentHookInstallStatus {
    agent_hooks_droid::apply(enabled)
}

#[tauri::command]
pub fn agent_hooks_command_code_status() -> AgentHookInstallStatus {
    agent_hooks_command_code::status()
}

#[tauri::command]
pub fn agent_hooks_apply_command_code(enabled: bool) -> AgentHookInstallStatus {
    agent_hooks_command_code::apply(enabled)
}

#[tauri::command]
pub fn agent_hooks_grok_status() -> AgentHookInstallStatus {
    agent_hooks_grok::status()
}

#[tauri::command]
pub fn agent_hooks_apply_grok(enabled: bool) -> AgentHookInstallStatus {
    agent_hooks_grok::apply(enabled)
}

#[tauri::command]
pub fn agent_hooks_devin_status() -> AgentHookInstallStatus {
    agent_hooks_devin::status()
}

#[tauri::command]
pub fn agent_hooks_apply_devin(enabled: bool) -> AgentHookInstallStatus {
    agent_hooks_devin::apply(enabled)
}

#[tauri::command]
pub fn agent_hooks_kimi_status() -> AgentHookInstallStatus {
    agent_hooks_kimi::status()
}

#[tauri::command]
pub fn agent_hooks_apply_kimi(enabled: bool) -> AgentHookInstallStatus {
    agent_hooks_kimi::apply(enabled)
}

#[tauri::command]
pub fn agent_hooks_amp_status() -> AgentHookInstallStatus {
    agent_hooks_amp::status()
}

#[tauri::command]
pub fn agent_hooks_apply_amp(enabled: bool) -> AgentHookInstallStatus {
    agent_hooks_amp::apply(enabled)
}

#[tauri::command]
pub fn agent_hooks_apply_gemini(enabled: bool) -> AgentHookInstallStatus {
    agent_hooks_gemini::apply(enabled)
}

#[tauri::command]
pub fn agent_hooks_codex_status() -> AgentHookInstallStatus {
    agent_hooks_codex::status()
}

#[tauri::command]
pub fn agent_hooks_apply_codex(enabled: bool) -> AgentHookInstallStatus {
    agent_hooks_codex::apply(enabled)
}

#[tauri::command]
pub fn agent_hooks_antigravity_status() -> AgentHookInstallStatus {
    agent_hooks_antigravity::status()
}

#[tauri::command]
pub fn agent_hooks_apply_antigravity(enabled: bool) -> AgentHookInstallStatus {
    agent_hooks_antigravity::apply(enabled)
}

#[tauri::command]
pub fn agent_hooks_copilot_status() -> AgentHookInstallStatus {
    agent_hooks_copilot::status()
}

#[tauri::command]
pub fn agent_hooks_apply_copilot(enabled: bool) -> AgentHookInstallStatus {
    agent_hooks_copilot::apply(enabled)
}

#[tauri::command]
pub fn agent_hooks_hermes_status() -> AgentHookInstallStatus {
    agent_hooks_hermes::status()
}

#[tauri::command]
pub fn agent_hooks_apply_hermes(enabled: bool) -> AgentHookInstallStatus {
    agent_hooks_hermes::apply(enabled)
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
    fn install_preserves_unrelated_hooks_and_writes_executable_script() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        write_settings(
            scope._dir.path(),
            ".claude",
            r#"{"theme":"dark","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo unrelated"}]}]}}"#,
        );

        let status = install_claude_compatible(&CLAUDE_SETTINGS);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        let config =
            read_settings_for_mutation(&scope._dir.path().join(".claude").join("settings.json"))
                .unwrap();
        assert_eq!(config["theme"], "dark");
        assert!(config["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .iter()
            .any(|definition| definition.to_string().contains("echo unrelated")));
        let script = managed_script_path(&CLAUDE_SETTINGS).unwrap();
        assert!(script.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(script).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn remove_deletes_only_managed_definitions_and_script() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        assert!(matches!(
            install_claude_compatible(&CLAUDE_SETTINGS).state,
            AgentHookInstallState::Installed
        ));
        let config_path = scope._dir.path().join(".claude").join("settings.json");
        let mut config = read_settings_for_mutation(&config_path).unwrap();
        config["hooks"]["Stop"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"hooks":[{"type":"command","command":"echo keep"}]}));
        write_json_atomically(&config_path, &config).unwrap();

        let status = remove_claude_compatible(&CLAUDE_SETTINGS);
        assert!(matches!(status.state, AgentHookInstallState::NotInstalled));
        let next = read_settings_for_mutation(&config_path).unwrap();
        assert!(next["hooks"]["Stop"].to_string().contains("echo keep"));
        assert!(!next.to_string().contains("agent-hooks/claude-hook"));
        assert!(!managed_script_path(&CLAUDE_SETTINGS).unwrap().exists());
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn gemini_install_sweeps_stale_event_and_preserves_user_hook() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        write_settings(
            scope._dir.path(),
            ".gemini",
            r#"{"hooks":{"BeforeAgent":[{"hooks":[{"command":"echo keep"}]}],"PreToolUse":[{"hooks":[{"command":"/old/agent-hooks/gemini-hook.sh"}]}]}}"#,
        );

        let status = agent_hooks_gemini::apply(true);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        let config =
            read_settings_for_mutation(&scope._dir.path().join(".gemini").join("settings.json"))
                .unwrap();
        assert!(config["hooks"]["PreToolUse"].is_null());
        assert!(config["hooks"]["BeforeAgent"]
            .to_string()
            .contains("echo keep"));
        for event in ["BeforeAgent", "AfterAgent", "AfterTool", "BeforeTool"] {
            assert!(config["hooks"][event].to_string().contains("gemini-hook"));
            assert!(config["hooks"][event].to_string().contains("10000"));
        }
        let script = scope
            ._dir
            .path()
            .join(".pebble")
            .join("agent-hooks")
            .join(if cfg!(windows) {
                "gemini-hook.cmd"
            } else {
                "gemini-hook.sh"
            });
        let script_body = fs::read_to_string(script).unwrap();
        assert!(if cfg!(windows) {
            script_body.starts_with("@echo off\r\nsetlocal\r\necho {}")
        } else {
            script_body.starts_with("#!/bin/sh\nprintf \"{}\\n\"")
        });
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn gemini_remove_preserves_unrelated_definitions() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        assert!(matches!(
            agent_hooks_gemini::apply(true).state,
            AgentHookInstallState::Installed
        ));
        let path = scope._dir.path().join(".gemini").join("settings.json");
        let mut config = read_settings_for_mutation(&path).unwrap();
        config["hooks"]["BeforeAgent"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"hooks":[{"command":"echo keep"}]}));
        write_json_atomically(&path, &config).unwrap();

        let status = agent_hooks_gemini::apply(false);
        assert!(matches!(status.state, AgentHookInstallState::NotInstalled));
        let next = read_settings_for_mutation(&path).unwrap();
        assert!(next.to_string().contains("echo keep"));
        assert!(!next.to_string().contains("gemini-hook"));
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn cursor_install_uses_top_level_schema_and_sweeps_stale_entries() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let cursor_dir = scope._dir.path().join(".cursor");
        fs::create_dir_all(&cursor_dir).unwrap();
        fs::write(
            cursor_dir.join("hooks.json"),
            r#"{"custom":true,"hooks":{"beforeSubmitPrompt":[{"command":"echo keep"},{"command":"/old/agent-hooks/cursor-hook.sh"}],"retiredEvent":[{"hooks":[{"command":"/old/agent-hooks/cursor-hook.sh"}]},{"command":"echo retired-user"}]}}"#,
        )
        .unwrap();

        let status = agent_hooks_cursor::apply(true);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        let config = read_settings_for_mutation(&cursor_dir.join("hooks.json")).unwrap();
        assert_eq!(config["version"], 1);
        assert_eq!(config["custom"], true);
        assert!(config["hooks"]["retiredEvent"]
            .to_string()
            .contains("echo retired-user"));
        assert!(!config["hooks"]["retiredEvent"]
            .to_string()
            .contains("cursor-hook"));
        for event in [
            "beforeSubmitPrompt",
            "stop",
            "preToolUse",
            "postToolUse",
            "postToolUseFailure",
            "beforeShellExecution",
            "beforeMCPExecution",
            "afterAgentResponse",
        ] {
            let definitions = config["hooks"][event].as_array().unwrap();
            let managed = definitions
                .iter()
                .find(|definition| definition["command"].to_string().contains("cursor-hook"))
                .unwrap();
            assert_eq!(managed["timeout"], 10);
            assert!(managed.get("hooks").is_none());
        }
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn cursor_remove_keeps_user_commands() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        assert!(matches!(
            agent_hooks_cursor::apply(true).state,
            AgentHookInstallState::Installed
        ));
        let path = scope._dir.path().join(".cursor").join("hooks.json");
        let mut config = read_settings_for_mutation(&path).unwrap();
        config["hooks"]["stop"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"command":"echo keep","timeout":3}));
        write_json_atomically(&path, &config).unwrap();

        let status = agent_hooks_cursor::apply(false);
        assert!(matches!(status.state, AgentHookInstallState::NotInstalled));
        let next = read_settings_for_mutation(&path).unwrap();
        assert!(next.to_string().contains("echo keep"));
        assert!(!next.to_string().contains("cursor-hook"));
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn droid_install_uses_factory_schema_and_reports_global_disable() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        write_settings(
            scope._dir.path(),
            ".factory",
            r#"{"hooksDisabled":true,"hooks":{"Stop":[{"hooks":[{"command":"echo keep"}]}]}}"#,
        );

        let status = agent_hooks_droid::apply(true);
        assert!(matches!(status.state, AgentHookInstallState::Partial));
        assert_eq!(
            status.detail.as_deref(),
            Some("Droid hooks are disabled in Factory settings")
        );
        let path = scope._dir.path().join(".factory").join("settings.json");
        let config = read_settings_for_mutation(&path).unwrap();
        assert!(config["hooks"]["Stop"].to_string().contains("echo keep"));
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "SubagentStop",
            "PreToolUse",
            "PostToolUse",
            "PermissionRequest",
            "Notification",
        ] {
            assert!(config["hooks"][event].to_string().contains("droid-hook"));
        }
        for event in ["PreToolUse", "PostToolUse", "PermissionRequest"] {
            assert!(config["hooks"][event]
                .as_array()
                .unwrap()
                .iter()
                .any(|definition| definition["matcher"] == "*"));
        }
        assert!(config["hooks"]["UserPromptSubmit"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|definition| definition.to_string().contains("droid-hook"))
            .all(|definition| definition.get("matcher").is_none()));
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn droid_remove_preserves_user_hooks() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        assert!(matches!(
            agent_hooks_droid::apply(true).state,
            AgentHookInstallState::Installed
        ));
        let path = scope._dir.path().join(".factory").join("settings.json");
        let mut config = read_settings_for_mutation(&path).unwrap();
        config["hooks"]["Stop"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"hooks":[{"command":"echo keep"}]}));
        write_json_atomically(&path, &config).unwrap();

        let status = agent_hooks_droid::apply(false);
        assert!(matches!(status.state, AgentHookInstallState::NotInstalled));
        let next = read_settings_for_mutation(&path).unwrap();
        assert!(next.to_string().contains("echo keep"));
        assert!(!next.to_string().contains("droid-hook"));
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn command_code_install_preserves_recovery_script_and_event_schema() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let status = agent_hooks_command_code::apply(true);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        let path = scope._dir.path().join(".commandcode").join("settings.json");
        let config = read_settings_for_mutation(&path).unwrap();
        for event in ["PreToolUse", "PostToolUse", "Stop"] {
            assert!(config["hooks"][event]
                .to_string()
                .contains("command-code-hook"));
        }
        assert_eq!(config["hooks"]["PreToolUse"][0]["matcher"], ".*");
        assert_eq!(config["hooks"]["PostToolUse"][0]["matcher"], ".*");
        assert!(config["hooks"]["Stop"][0].get("matcher").is_none());
        let script = scope
            ._dir
            .path()
            .join(".pebble")
            .join("agent-hooks")
            .join(if cfg!(windows) {
                "command-code-hook.cmd"
            } else {
                "command-code-hook.sh"
            });
        let body = fs::read_to_string(&script).unwrap();
        assert!(
            body.contains("sourceEndpointByPort") || body.contains("__pebble_read_ancestor_var")
        );
        assert!(body.contains("PEBBLE_AGENT_HOOK_PORT"));
        assert!(body.contains("endpoint"));
        #[cfg(unix)]
        assert!(std::process::Command::new("/bin/sh")
            .arg("-n")
            .arg(script)
            .status()
            .unwrap()
            .success());
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn command_code_remove_keeps_user_hook() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        assert!(matches!(
            agent_hooks_command_code::apply(true).state,
            AgentHookInstallState::Installed
        ));
        let path = scope._dir.path().join(".commandcode").join("settings.json");
        let mut config = read_settings_for_mutation(&path).unwrap();
        config["hooks"]["Stop"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"hooks":[{"command":"echo keep"}]}));
        write_json_atomically(&path, &config).unwrap();
        let status = agent_hooks_command_code::apply(false);
        assert!(matches!(status.state, AgentHookInstallState::NotInstalled));
        let next = read_settings_for_mutation(&path).unwrap();
        assert!(next.to_string().contains("echo keep"));
        assert!(!next.to_string().contains("command-code-hook"));
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn grok_install_uses_dedicated_global_hook_file() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let path = scope
            ._dir
            .path()
            .join(".grok")
            .join("hooks")
            .join("pebble-status.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"owner":"user","hooks":{"Notification":[{"hooks":[{"command":"echo keep"}]}]}}"#,
        )
        .unwrap();

        let status = agent_hooks_grok::apply(true);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        assert_eq!(status.config_path, path.display().to_string());
        let config = read_settings_for_mutation(&path).unwrap();
        assert_eq!(config["owner"], "user");
        assert!(config["hooks"]["Notification"]
            .to_string()
            .contains("echo keep"));
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "SessionEnd",
            "PreToolUse",
            "PostToolUse",
            "PostToolUseFailure",
            "Notification",
        ] {
            assert!(config["hooks"][event].to_string().contains("grok-hook"));
        }
        for event in ["PreToolUse", "PostToolUse", "PostToolUseFailure"] {
            assert!(config["hooks"][event]
                .as_array()
                .unwrap()
                .iter()
                .any(|definition| definition["matcher"] == "*"));
        }
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn grok_remove_preserves_user_definition() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        assert!(matches!(
            agent_hooks_grok::apply(true).state,
            AgentHookInstallState::Installed
        ));
        let path = scope
            ._dir
            .path()
            .join(".grok")
            .join("hooks")
            .join("pebble-status.json");
        let mut config = read_settings_for_mutation(&path).unwrap();
        config["hooks"]["Notification"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"hooks":[{"command":"echo keep"}]}));
        write_json_atomically(&path, &config).unwrap();
        let status = agent_hooks_grok::apply(false);
        assert!(matches!(status.state, AgentHookInstallState::NotInstalled));
        let next = read_settings_for_mutation(&path).unwrap();
        assert!(next.to_string().contains("echo keep"));
        assert!(!next.to_string().contains("grok-hook"));
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn devin_install_parses_jsonc_and_surfaces_default_claude_import() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let path = if cfg!(windows) {
            scope
                ._dir
                .path()
                .join("AppData")
                .join("Roaming")
                .join("devin")
                .join("config.json")
        } else {
            scope
                ._dir
                .path()
                .join(".config")
                .join("devin")
                .join("config.json")
        };
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            "{\n // user comment\n permissions: { mode: 'normal', },\n hooks: {},\n}\n",
        )
        .unwrap();

        let status = agent_hooks_devin::apply(true);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        assert!(status.detail.unwrap().contains("read_config_from.claude"));
        let config = read_settings_for_mutation(&path).unwrap();
        assert_eq!(config["permissions"]["mode"], "normal");
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "PostCompaction",
            "SessionEnd",
            "PreToolUse",
            "PostToolUse",
            "PermissionRequest",
        ] {
            assert!(config["hooks"][event].to_string().contains("devin-hook"));
            assert!(config["hooks"][event][0].get("matcher").is_none());
        }
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn devin_explicitly_disabled_claude_import_has_no_overlap_detail() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let path = if cfg!(windows) {
            scope
                ._dir
                .path()
                .join("AppData")
                .join("Roaming")
                .join("devin")
                .join("config.json")
        } else {
            scope
                ._dir
                .path()
                .join(".config")
                .join("devin")
                .join("config.json")
        };
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"read_config_from":{"claude":false},"hooks":{}}"#).unwrap();
        let status = agent_hooks_devin::apply(true);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        assert!(status.detail.is_none());
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn kimi_install_converges_to_one_managed_toml_block() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let kimi_home = scope._dir.path().join(".kimi-code");
        std::env::set_var("KIMI_CODE_HOME", &kimi_home);
        fs::create_dir_all(&kimi_home).unwrap();
        let path = kimi_home.join("config.toml");
        let user_config =
            "default_model = \"kimi-k2.6\"\n\n[providers.mine]\napi_key = \"secret\"\n";
        fs::write(&path, user_config).unwrap();

        assert!(matches!(
            agent_hooks_kimi::apply(true).state,
            AgentHookInstallState::Installed
        ));
        assert!(matches!(
            agent_hooks_kimi::apply(true).state,
            AgentHookInstallState::Installed
        ));
        let installed = fs::read_to_string(&path).unwrap();
        assert_eq!(installed.matches("pebble-managed-kimi-hooks (").count(), 1);
        for event in [
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "PostToolUseFailure",
            "PermissionRequest",
            "Stop",
            "StopFailure",
        ] {
            assert!(installed.contains(&format!("event = \"{event}\"")));
        }
        assert!(installed.contains("api_key = \"secret\""));
        assert!(path.with_extension("toml.bak").exists());
        std::env::remove_var("KIMI_CODE_HOME");
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn kimi_remove_restores_user_toml() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let kimi_home = scope._dir.path().join(".kimi-code");
        std::env::set_var("KIMI_CODE_HOME", &kimi_home);
        fs::create_dir_all(&kimi_home).unwrap();
        let path = kimi_home.join("config.toml");
        let user_config = "default_model = \"kimi-k2.6\"\n";
        fs::write(&path, user_config).unwrap();
        agent_hooks_kimi::apply(true);

        let status = agent_hooks_kimi::apply(false);
        assert!(matches!(status.state, AgentHookInstallState::NotInstalled));
        assert_eq!(fs::read_to_string(path).unwrap(), user_config);
        std::env::remove_var("KIMI_CODE_HOME");
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn amp_install_writes_complete_bounded_plugin() {
        let _lock = ENV_GUARD.lock().unwrap();
        let _scope = scope();
        let status = agent_hooks_amp::apply(true);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        let source = fs::read_to_string(status.config_path).unwrap();
        for handler in [
            "session.start",
            "agent.start",
            "tool.call",
            "tool.result",
            "agent.end",
        ] {
            assert!(source.contains(&format!("amp.on('{handler}'")));
        }
        assert!(source.contains("MAX_PENDING_POSTS = 50"));
        assert!(source.contains("postQueue.shift()"));
        assert!(source.contains("PEBBLE_AGENT_HOOK_ENDPOINT"));
        assert!(source.contains("return { action: 'allow' }"));
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn amp_never_overwrites_or_removes_user_plugin() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let path = scope
            ._dir
            .path()
            .join(".config")
            .join("amp")
            .join("plugins")
            .join("pebble-agent-status.ts");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "export default function userPlugin() {}\n").unwrap();
        let installed = agent_hooks_amp::apply(true);
        assert!(matches!(installed.state, AgentHookInstallState::Partial));
        let removed = agent_hooks_amp::apply(false);
        assert!(matches!(removed.state, AgentHookInstallState::Partial));
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "export default function userPlugin() {}\n"
        );
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn copilot_install_writes_all_events_and_preserves_user_hook() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let config_path = scope._dir.path().join(".copilot/hooks/pebble.json");
        fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        fs::write(
            &config_path,
            r#"{"hooks":{"SessionStart":[{"type":"command","bash":"user-hook"}]}}"#,
        )
        .unwrap();

        let status = agent_hooks_copilot::apply(true);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        let hooks = config["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), 13);
        assert!(hooks["SessionStart"]
            .as_array()
            .unwrap()
            .iter()
            .any(|definition| definition["bash"] == "user-hook"));
        assert!(fs::read_to_string(
            scope
                ._dir
                .path()
                .join(".pebble/agent-hooks/copilot-hook.sh")
        )
        .unwrap()
        .contains("/hook/copilot"));
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn copilot_remove_deletes_only_managed_definitions() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        agent_hooks_copilot::apply(true);
        let config_path = scope._dir.path().join(".copilot/hooks/pebble.json");
        let mut config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        config["hooks"]["CustomEvent"] =
            serde_json::json!([{ "type": "command", "bash": "user-hook" }]);
        fs::write(&config_path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();

        let status = agent_hooks_copilot::apply(false);
        assert!(matches!(status.state, AgentHookInstallState::NotInstalled));
        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(config_path).unwrap()).unwrap();
        assert_eq!(config["hooks"]["CustomEvent"][0]["bash"], "user-hook");
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn antigravity_install_uses_bundle_specific_event_schemas() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let path = scope._dir.path().join(".gemini/config/hooks.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"user-bundle":{"Stop":[{"type":"command","command":"user-hook"}]}}"#,
        )
        .unwrap();

        let status = agent_hooks_antigravity::apply(true);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(config["user-bundle"]["Stop"][0]["command"], "user-hook");
        let bundle = config["pebble-status"].as_object().unwrap();
        assert_eq!(bundle.len(), 4);
        assert_eq!(bundle["PostToolUse"][0]["matcher"], "*");
        assert!(bundle["PostToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("PEBBLE_ANTIGRAVITY_EVENT='PostToolUse'"));
        let script = fs::read_to_string(
            scope
                ._dir
                .path()
                .join(".pebble/agent-hooks/antigravity-hook.sh"),
        )
        .unwrap();
        assert!(script.contains("Stop) printf '{\"decision\":\"\"}"));
        assert!(script.contains("/hook/antigravity"));
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn antigravity_remove_preserves_user_bundle() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        agent_hooks_antigravity::apply(true);
        let path = scope._dir.path().join(".gemini/config/hooks.json");
        let mut config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        config["pebble-status"]["Custom"] =
            serde_json::json!([{ "type": "command", "command": "user-hook" }]);
        fs::write(&path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();

        let status = agent_hooks_antigravity::apply(false);
        assert!(matches!(status.state, AgentHookInstallState::NotInstalled));
        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(config["pebble-status"]["Custom"][0]["command"], "user-hook");
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn hermes_install_preserves_yaml_and_writes_complete_bounded_plugin() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let home = scope._dir.path().join("hermes-home");
        std::env::set_var("HERMES_HOME", &home);
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join("config.yaml"),
            "model: test-model\nplugins:\n  enabled:\n    - disk-cleanup\n  disabled:\n    - pebble-status\n",
        )
        .unwrap();

        let status = agent_hooks_hermes::apply(true);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        let config: serde_yaml::Value =
            serde_yaml::from_str(&fs::read_to_string(home.join("config.yaml")).unwrap()).unwrap();
        assert_eq!(config["model"], "test-model");
        assert_eq!(
            config["plugins"]["enabled"],
            serde_yaml::to_value(["disk-cleanup", "pebble-status"]).unwrap()
        );
        assert_eq!(
            config["plugins"]["disabled"],
            serde_yaml::to_value(Vec::<String>::new()).unwrap()
        );
        assert!(home.join("config.yaml.bak").exists());
        let manifest = fs::read_to_string(home.join("plugins/pebble-status/plugin.yaml")).unwrap();
        for event in [
            "on_session_start",
            "pre_llm_call",
            "post_llm_call",
            "pre_tool_call",
            "post_tool_call",
            "pre_approval_request",
            "post_approval_response",
            "on_session_end",
            "on_session_finalize",
            "on_session_reset",
        ] {
            assert!(manifest.contains(&format!("  - {event}")));
        }
        let plugin = fs::read_to_string(home.join("plugins/pebble-status/__init__.py")).unwrap();
        assert!(plugin.contains("MAX_JSONABLE_NODES = 500"));
        assert!(plugin.contains("timeout=0.75"));
        assert!(plugin.contains("/hook/hermes"));
        std::env::remove_var("HERMES_HOME");
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn hermes_remove_keeps_unmanaged_same_name_plugin() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let home = scope._dir.path().join("hermes-home");
        let plugin_dir = home.join("plugins/pebble-status");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(plugin_dir.join("plugin.yaml"), "name: pebble-status\n").unwrap();
        fs::write(plugin_dir.join("__init__.py"), "# user plugin\n").unwrap();
        fs::write(
            home.join("config.yaml"),
            "plugins:\n  enabled:\n    - pebble-status\n  disabled: []\n",
        )
        .unwrap();
        std::env::set_var("HERMES_HOME", &home);

        let status = agent_hooks_hermes::apply(false);
        assert!(matches!(status.state, AgentHookInstallState::Partial));
        assert!(plugin_dir.exists());
        assert_eq!(
            fs::read_to_string(plugin_dir.join("__init__.py")).unwrap(),
            "# user plugin\n"
        );
        std::env::remove_var("HERMES_HOME");
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn codex_trust_hash_matches_electron_reference_vector() {
        assert_eq!(
            agent_hooks_codex::trusted_hash("pre_tool_use", "/bin/sh hook"),
            "sha256:cffe2731482322bd1853e8681848d0f3d9757fd87b2382954a877d314207a41c"
        );
    }

    #[test]
    fn codex_install_writes_six_trusted_runtime_hooks() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let user_data = scope._dir.path().join("user-data");
        std::env::set_var("PEBBLE_USER_DATA_PATH", &user_data);

        let status = agent_hooks_codex::apply(true);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        let runtime = user_data.join("codex-runtime-home/home");
        let hooks: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(runtime.join("hooks.json")).unwrap()).unwrap();
        assert_eq!(hooks["hooks"].as_object().unwrap().len(), 6);
        let toml = fs::read_to_string(runtime.join("config.toml")).unwrap();
        assert_eq!(toml.matches("[hooks.state.").count(), 6);
        assert_eq!(toml.matches("trusted_hash = \"sha256:").count(), 6);
        assert!(
            fs::read_to_string(scope._dir.path().join(".pebble/agent-hooks/codex-hook.sh"))
                .unwrap()
                .contains("/hook/codex")
        );
        std::env::remove_var("PEBBLE_USER_DATA_PATH");
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn codex_remove_preserves_user_hook_and_unrelated_trust() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let user_data = scope._dir.path().join("user-data");
        std::env::set_var("PEBBLE_USER_DATA_PATH", &user_data);
        agent_hooks_codex::apply(true);
        let runtime = user_data.join("codex-runtime-home/home");
        let hooks_path = runtime.join("hooks.json");
        let mut hooks: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&hooks_path).unwrap()).unwrap();
        hooks["hooks"]["Custom"] = serde_json::json!([{
            "hooks": [{ "type": "command", "command": "user-hook", "timeout": 20 }]
        }]);
        fs::write(&hooks_path, serde_json::to_vec_pretty(&hooks).unwrap()).unwrap();
        let toml_path = runtime.join("config.toml");
        fs::write(
            &toml_path,
            format!("{}\n[hooks.state.\"user:key:0:0\"]\nenabled = true\ntrusted_hash = \"sha256:user\"\n", fs::read_to_string(&toml_path).unwrap()),
        )
        .unwrap();

        let status = agent_hooks_codex::apply(false);
        assert!(matches!(status.state, AgentHookInstallState::NotInstalled));
        let hooks: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(hooks_path).unwrap()).unwrap();
        assert_eq!(
            hooks["hooks"]["Custom"][0]["hooks"][0]["command"],
            "user-hook"
        );
        let toml = fs::read_to_string(toml_path).unwrap();
        assert!(toml.contains("sha256:user"));
        assert_eq!(toml.matches("trusted_hash = \"sha256:").count(), 1);
        std::env::remove_var("PEBBLE_USER_DATA_PATH");
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn codex_install_mirrors_system_user_hooks_config_and_resources() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let user_data = scope._dir.path().join("user-data");
        std::env::set_var("PEBBLE_USER_DATA_PATH", &user_data);
        let system = scope._dir.path().join(".codex");
        fs::create_dir_all(system.join("skills")).unwrap();
        fs::write(system.join("skills/example.md"), "skill").unwrap();
        fs::write(
            system.join("hooks.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"command":"user-hook","timeout":20}]},{"hooks":[{"command":"${CLAUDE_PLUGIN_ROOT}/bad"}]}]}}"#,
        )
        .unwrap();
        fs::write(
            system.join("config.toml"),
            "model = \"gpt-test\"\n\n[hooks.state.\"system:key:0:0\"]\nenabled = true\ntrusted_hash = \"sha256:system\"\n",
        )
        .unwrap();

        let status = agent_hooks_codex::apply(true);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        let runtime = user_data.join("codex-runtime-home/home");
        let hooks: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(runtime.join("hooks.json")).unwrap()).unwrap();
        let stop = hooks["hooks"]["Stop"].as_array().unwrap();
        assert!(stop[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("codex-hook"));
        assert_eq!(stop[1]["hooks"][0]["command"], "user-hook");
        assert!(!hooks.to_string().contains("CLAUDE_PLUGIN_ROOT"));
        let toml = fs::read_to_string(runtime.join("config.toml")).unwrap();
        assert!(toml.contains("model = \"gpt-test\""));
        assert!(!toml.contains("sha256:system"));
        assert_eq!(toml.matches("trusted_hash = \"sha256:").count(), 6);
        assert_eq!(
            fs::read_to_string(runtime.join("skills/example.md")).unwrap(),
            "skill"
        );
        std::env::remove_var("PEBBLE_USER_DATA_PATH");
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }

    #[test]
    fn codex_mirrors_disabled_system_user_hook_trust_at_runtime_index() {
        let _lock = ENV_GUARD.lock().unwrap();
        let scope = scope();
        let user_data = scope._dir.path().join("user-data");
        std::env::set_var("PEBBLE_USER_DATA_PATH", &user_data);
        let system = scope._dir.path().join(".codex");
        fs::create_dir_all(&system).unwrap();
        let hooks_path = system.join("hooks.json");
        fs::write(
            &hooks_path,
            r#"{"hooks":{"Stop":[{"hooks":[{"command":"user-hook","timeout":20,"async":true}]}]}}"#,
        )
        .unwrap();
        let canonical = fs::canonicalize(&hooks_path).unwrap();
        let key = format!("{}:stop:0:0", canonical.display());
        let hash = agent_hooks_codex::hook_hash("stop", "user-hook", 20, true, None, None);
        fs::write(
            system.join("config.toml"),
            format!(
                "[hooks.state.\"{}\"]\nenabled = false\ntrusted_hash = \"{hash}\"\n",
                key.replace('\\', "\\\\").replace('"', "\\\"")
            ),
        )
        .unwrap();

        let status = agent_hooks_codex::apply(true);
        assert!(matches!(status.state, AgentHookInstallState::Installed));
        let runtime = user_data.join("codex-runtime-home/home");
        let runtime_hooks = fs::canonicalize(runtime.join("hooks.json")).unwrap();
        let runtime_key = format!("{}:stop:1:0", runtime_hooks.display())
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        let toml = fs::read_to_string(runtime.join("config.toml")).unwrap();
        let start = toml.find(&runtime_key).unwrap();
        assert!(toml[start..].starts_with(&format!("{runtime_key}\"]\nenabled = false")));
        assert!(toml[start..].contains(&hash));
        std::env::remove_var("PEBBLE_USER_DATA_PATH");
        std::env::remove_var("PEBBLE_AGENT_HOOKS_HOME");
    }
}
