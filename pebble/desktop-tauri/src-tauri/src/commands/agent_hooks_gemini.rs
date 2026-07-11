use std::fs;

use super::{
    command_references_managed_script, config_path, error_status, managed_command,
    managed_script_path, read_settings_for_mutation, write_json_atomically, AgentHookInstallState,
    AgentHookInstallStatus, ClaudeCompatibleSettings,
};

const GEMINI_EVENTS: &[&str] = &["BeforeAgent", "AfterAgent", "AfterTool", "BeforeTool"];
const GEMINI_SETTINGS: ClaudeCompatibleSettings = ClaudeCompatibleSettings {
    agent: "gemini",
    config_dir_name: ".gemini",
    script_base_name: "gemini-hook",
};

fn gemini_script() -> String {
    if cfg!(windows) {
        return "@echo off\r\nsetlocal\r\necho {}\r\nif defined PEBBLE_AGENT_HOOK_ENDPOINT if exist \"%PEBBLE_AGENT_HOOK_ENDPOINT%\" call \"%PEBBLE_AGENT_HOOK_ENDPOINT%\" 2>nul\r\nif \"%PEBBLE_AGENT_HOOK_PORT%\"==\"\" exit /b 0\r\nif \"%PEBBLE_AGENT_HOOK_TOKEN%\"==\"\" exit /b 0\r\nif \"%PEBBLE_PANE_KEY%\"==\"\" exit /b 0\r\n\"%SystemRoot%\\System32\\curl.exe\" -sS -X POST \"http://127.0.0.1:%PEBBLE_AGENT_HOOK_PORT%/hook/gemini\" --connect-timeout 0.5 --max-time 1.5 -H \"Content-Type: application/x-www-form-urlencoded\" -H \"X-Pebble-Agent-Hook-Token: %PEBBLE_AGENT_HOOK_TOKEN%\" --data-urlencode \"paneKey=%PEBBLE_PANE_KEY%\" --data-urlencode \"tabId=%PEBBLE_TAB_ID%\" --data-urlencode \"launchToken=%PEBBLE_AGENT_LAUNCH_TOKEN%\" --data-urlencode \"worktreeId=%PEBBLE_WORKTREE_ID%\" --data-urlencode \"env=%PEBBLE_AGENT_HOOK_ENV%\" --data-urlencode \"version=%PEBBLE_AGENT_HOOK_VERSION%\" --data-urlencode \"payload@-\" >nul 2>nul\r\nexit /b 0\r\n".into();
    }
    "#!/bin/sh\nprintf \"{}\\n\"\nif [ -n \"$PEBBLE_AGENT_HOOK_ENDPOINT\" ] && [ -r \"$PEBBLE_AGENT_HOOK_ENDPOINT\" ]; then\n  . \"$PEBBLE_AGENT_HOOK_ENDPOINT\" 2>/dev/null || :\nfi\nif [ -z \"$PEBBLE_AGENT_HOOK_PORT\" ] || [ -z \"$PEBBLE_AGENT_HOOK_TOKEN\" ] || [ -z \"$PEBBLE_PANE_KEY\" ]; then\n  exit 0\nfi\npayload=$(cat)\nif [ -z \"$payload\" ]; then\n  exit 0\nfi\nprintf '%s' \"$payload\" | curl -sS -X POST \"http://127.0.0.1:${PEBBLE_AGENT_HOOK_PORT}/hook/gemini\" \\\n  --connect-timeout 0.5 --max-time 1.5 \\\n  -H \"Content-Type: application/x-www-form-urlencoded\" \\\n  -H \"X-Pebble-Agent-Hook-Token: ${PEBBLE_AGENT_HOOK_TOKEN}\" \\\n  --data-urlencode \"paneKey=${PEBBLE_PANE_KEY}\" \\\n  --data-urlencode \"tabId=${PEBBLE_TAB_ID}\" \\\n  --data-urlencode \"launchToken=${PEBBLE_AGENT_LAUNCH_TOKEN}\" \\\n  --data-urlencode \"worktreeId=${PEBBLE_WORKTREE_ID}\" \\\n  --data-urlencode \"env=${PEBBLE_AGENT_HOOK_ENV}\" \\\n  --data-urlencode \"version=${PEBBLE_AGENT_HOOK_VERSION}\" \\\n  --data-urlencode \"payload@-\" >/dev/null 2>&1 || true\nexit 0\n".into()
}

pub(super) fn status() -> AgentHookInstallStatus {
    let Some(path) = config_path(&GEMINI_SETTINGS) else {
        return error_status(
            &GEMINI_SETTINGS,
            String::new(),
            "Could not resolve home directory.".into(),
        );
    };
    let path_text = path.display().to_string();
    let root = match read_settings_for_mutation(&path) {
        Ok(value) => value,
        Err(detail) => return error_status(&GEMINI_SETTINGS, path_text, detail),
    };
    let hooks = root.get("hooks").and_then(serde_json::Value::as_object);
    let mut missing = Vec::new();
    let mut present = 0;
    for event in GEMINI_EVENTS {
        let found = hooks
            .and_then(|value| value.get(*event))
            .and_then(serde_json::Value::as_array)
            .map(|definitions| definitions.iter().any(is_managed_definition))
            .unwrap_or(false);
        if found {
            present += 1
        } else {
            missing.push(*event)
        }
    }
    let state = if missing.is_empty() {
        AgentHookInstallState::Installed
    } else if present == 0 {
        AgentHookInstallState::NotInstalled
    } else {
        AgentHookInstallState::Partial
    };
    AgentHookInstallStatus {
        agent: "gemini",
        state,
        config_path: path_text,
        managed_hooks_present: present > 0,
        detail: (present > 0 && !missing.is_empty())
            .then(|| format!("Managed hook missing for events: {}", missing.join(", "))),
    }
}

fn is_managed_definition(value: &serde_json::Value) -> bool {
    value
        .get("hooks")
        .and_then(serde_json::Value::as_array)
        .map(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(serde_json::Value::as_str)
                    .map(|command| command_references_managed_script(command, &GEMINI_SETTINGS))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn remove_managed(root: &mut serde_json::Value) {
    let Some(hooks) = root
        .get_mut("hooks")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    hooks.retain(|_, value| {
        let Some(definitions) = value.as_array_mut() else {
            return true;
        };
        definitions.retain(|definition| !is_managed_definition(definition));
        !definitions.is_empty()
    });
}

pub(super) fn apply(enabled: bool) -> AgentHookInstallStatus {
    let Some(path) = config_path(&GEMINI_SETTINGS) else {
        return error_status(
            &GEMINI_SETTINGS,
            String::new(),
            "Could not resolve home directory.".into(),
        );
    };
    let result = (|| -> Result<(), String> {
        let mut root = read_settings_for_mutation(&path)?;
        if !root.is_object() {
            return Err("Gemini settings must contain a JSON object.".into());
        }
        remove_managed(&mut root);
        if enabled {
            let command = managed_command(&GEMINI_SETTINGS)
                .ok_or_else(|| "Could not build Gemini hook command.".to_string())?;
            let hooks = root
                .as_object_mut()
                .unwrap()
                .entry("hooks")
                .or_insert_with(|| serde_json::json!({}));
            let hooks = hooks
                .as_object_mut()
                .ok_or_else(|| "Gemini hooks must be an object.".to_string())?;
            for event in GEMINI_EVENTS {
                hooks.entry((*event).to_string()).or_insert_with(|| serde_json::json!([]))
                    .as_array_mut().ok_or_else(|| format!("Gemini {event} hooks must be an array."))?
                    .push(serde_json::json!({"hooks":[{"type":"command","command":command,"timeout":10000}]}));
            }
            let script = managed_script_path(&GEMINI_SETTINGS)
                .ok_or_else(|| "Could not resolve Gemini script path.".to_string())?;
            fs::create_dir_all(script.parent().unwrap()).map_err(|error| error.to_string())?;
            fs::write(&script, gemini_script()).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&script, fs::Permissions::from_mode(0o700))
                    .map_err(|error| error.to_string())?;
            }
        } else if let Some(script) = managed_script_path(&GEMINI_SETTINGS) {
            match fs::remove_file(script) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        write_json_atomically(&path, &root)
    })();
    match result {
        Ok(()) => status(),
        Err(detail) => error_status(&GEMINI_SETTINGS, path.display().to_string(), detail),
    }
}
