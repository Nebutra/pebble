use std::fs;
use std::path::PathBuf;

use super::{
    command_references_managed_script, error_status, home_dir, managed_command, managed_script,
    managed_script_path, read_settings_for_mutation, write_json_atomically, AgentHookInstallState,
    AgentHookInstallStatus, ClaudeCompatibleSettings,
};

const EVENTS: &[(&str, bool)] = &[
    ("SessionStart", false),
    ("UserPromptSubmit", false),
    ("Stop", false),
    ("SessionEnd", false),
    ("PreToolUse", true),
    ("PostToolUse", true),
    ("PostToolUseFailure", true),
    ("Notification", false),
];
const SETTINGS: ClaudeCompatibleSettings = ClaudeCompatibleSettings {
    agent: "grok",
    config_dir_name: ".grok",
    script_base_name: "grok-hook",
};

fn config_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".grok").join("hooks").join("pebble-status.json"))
}

fn definition_is_managed(value: &serde_json::Value) -> bool {
    value
        .get("hooks")
        .and_then(serde_json::Value::as_array)
        .map(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(serde_json::Value::as_str)
                    .map(|command| command_references_managed_script(command, &SETTINGS))
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
        definitions.retain(|definition| !definition_is_managed(definition));
        !definitions.is_empty()
    });
}

pub(super) fn status() -> AgentHookInstallStatus {
    let Some(path) = config_path() else {
        return error_status(
            &SETTINGS,
            String::new(),
            "Could not resolve home directory.".into(),
        );
    };
    let path_text = path.display().to_string();
    let root = match read_settings_for_mutation(&path) {
        Ok(value) => value,
        Err(detail) => return error_status(&SETTINGS, path_text, detail),
    };
    let hooks = root.get("hooks").and_then(serde_json::Value::as_object);
    let mut present = 0;
    let mut missing = Vec::new();
    for (event, _) in EVENTS {
        let found = hooks
            .and_then(|map| map.get(*event))
            .and_then(serde_json::Value::as_array)
            .map(|definitions| definitions.iter().any(definition_is_managed))
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
        agent: "grok",
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
            &SETTINGS,
            String::new(),
            "Could not resolve home directory.".into(),
        );
    };
    let result = (|| -> Result<(), String> {
        let mut root = read_settings_for_mutation(&path)?;
        if !root.is_object() {
            return Err("Grok hook config must contain a JSON object.".into());
        }
        remove_managed(&mut root);
        if enabled {
            let command = managed_command(&SETTINGS)
                .ok_or_else(|| "Could not build Grok hook command.".to_string())?;
            let hooks = root
                .as_object_mut()
                .expect("validated object")
                .entry("hooks")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or_else(|| "Grok hooks must be an object.".to_string())?;
            for (event, matcher) in EVENTS {
                let mut definition = serde_json::json!({
                    "hooks": [{"type": "command", "command": command, "timeout": 10}]
                });
                if *matcher {
                    definition["matcher"] = serde_json::Value::String("*".into());
                }
                hooks
                    .entry((*event).to_string())
                    .or_insert_with(|| serde_json::json!([]))
                    .as_array_mut()
                    .ok_or_else(|| format!("Grok {event} hooks must be an array."))?
                    .push(definition);
            }
            let script = managed_script_path(&SETTINGS)
                .ok_or_else(|| "Could not resolve Grok script path.".to_string())?;
            fs::create_dir_all(script.parent().expect("script parent"))
                .map_err(|error| error.to_string())?;
            fs::write(&script, managed_script(&SETTINGS)).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&script, fs::Permissions::from_mode(0o700))
                    .map_err(|error| error.to_string())?;
            }
        } else if let Some(script) = managed_script_path(&SETTINGS) {
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
        Err(detail) => error_status(&SETTINGS, path.display().to_string(), detail),
    }
}
