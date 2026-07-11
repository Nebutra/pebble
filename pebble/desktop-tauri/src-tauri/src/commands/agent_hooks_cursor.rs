use std::fs;
use std::path::PathBuf;

use super::{
    command_references_managed_script, error_status, home_dir, managed_command, managed_script,
    managed_script_path, read_settings_for_mutation, write_json_atomically, AgentHookInstallState,
    AgentHookInstallStatus, ClaudeCompatibleSettings,
};

const CURSOR_EVENTS: &[&str] = &[
    "beforeSubmitPrompt",
    "stop",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "beforeShellExecution",
    "beforeMCPExecution",
    "afterAgentResponse",
];
const CURSOR_SETTINGS: ClaudeCompatibleSettings = ClaudeCompatibleSettings {
    agent: "cursor",
    config_dir_name: ".cursor",
    script_base_name: "cursor-hook",
};

fn config_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".cursor").join("hooks.json"))
}

fn definition_references_managed_script(value: &serde_json::Value) -> bool {
    let direct = value
        .get("command")
        .and_then(serde_json::Value::as_str)
        .map(|command| command_references_managed_script(command, &CURSOR_SETTINGS))
        .unwrap_or(false);
    direct
        || value
            .get("hooks")
            .and_then(serde_json::Value::as_array)
            .map(|hooks| {
                hooks.iter().any(|hook| {
                    hook.get("command")
                        .and_then(serde_json::Value::as_str)
                        .map(|command| command_references_managed_script(command, &CURSOR_SETTINGS))
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
        definitions.retain(|definition| !definition_references_managed_script(definition));
        !definitions.is_empty()
    });
}

pub(super) fn status() -> AgentHookInstallStatus {
    let Some(path) = config_path() else {
        return error_status(
            &CURSOR_SETTINGS,
            String::new(),
            "Could not resolve home directory.".into(),
        );
    };
    let path_text = path.display().to_string();
    let root = match read_settings_for_mutation(&path) {
        Ok(value) => value,
        Err(detail) => return error_status(&CURSOR_SETTINGS, path_text, detail),
    };
    let hooks = root.get("hooks").and_then(serde_json::Value::as_object);
    let mut present = 0;
    let mut missing = Vec::new();
    for event in CURSOR_EVENTS {
        let found = hooks
            .and_then(|map| map.get(*event))
            .and_then(serde_json::Value::as_array)
            .map(|definitions| definitions.iter().any(definition_references_managed_script))
            .unwrap_or(false);
        if found {
            present += 1;
        } else {
            missing.push(*event);
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
        agent: "cursor",
        state,
        config_path: path_text,
        managed_hooks_present: present > 0,
        detail: (present > 0 && !missing.is_empty())
            .then(|| format!("Managed hook missing for events: {}", missing.join(", "))),
    }
}

pub(super) fn apply(enabled: bool) -> AgentHookInstallStatus {
    let Some(path) = config_path() else {
        return error_status(
            &CURSOR_SETTINGS,
            String::new(),
            "Could not resolve home directory.".into(),
        );
    };
    let result = (|| -> Result<(), String> {
        let mut root = read_settings_for_mutation(&path)?;
        if !root.is_object() {
            return Err("Cursor hooks must contain a JSON object.".into());
        }
        remove_managed(&mut root);
        if enabled {
            let command = managed_command(&CURSOR_SETTINGS)
                .ok_or_else(|| "Could not build Cursor hook command.".to_string())?;
            let object = root.as_object_mut().expect("validated object");
            object.entry("version").or_insert(serde_json::json!(1));
            let hooks = object
                .entry("hooks")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or_else(|| "Cursor hooks must be an object.".to_string())?;
            for event in CURSOR_EVENTS {
                hooks
                    .entry((*event).to_string())
                    .or_insert_with(|| serde_json::json!([]))
                    .as_array_mut()
                    .ok_or_else(|| format!("Cursor {event} hooks must be an array."))?
                    .push(serde_json::json!({"command": command, "timeout": 10}));
            }
            let script = managed_script_path(&CURSOR_SETTINGS)
                .ok_or_else(|| "Could not resolve Cursor script path.".to_string())?;
            fs::create_dir_all(script.parent().expect("script parent"))
                .map_err(|error| error.to_string())?;
            fs::write(&script, managed_script(&CURSOR_SETTINGS))
                .map_err(|error| error.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&script, fs::Permissions::from_mode(0o700))
                    .map_err(|error| error.to_string())?;
            }
        } else if let Some(script) = managed_script_path(&CURSOR_SETTINGS) {
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
        Err(detail) => error_status(&CURSOR_SETTINGS, path.display().to_string(), detail),
    }
}
