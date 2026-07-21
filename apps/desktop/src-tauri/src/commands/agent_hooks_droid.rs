use std::fs;

use super::{
    command_references_managed_script, config_path, error_status, managed_command, managed_script,
    managed_script_path, read_settings_for_mutation, write_json_atomically, AgentHookInstallState,
    AgentHookInstallStatus, ClaudeCompatibleSettings,
};

const DROID_EVENTS: &[(&str, bool)] = &[
    ("SessionStart", false),
    ("UserPromptSubmit", false),
    ("Stop", false),
    ("SubagentStop", false),
    ("PreToolUse", true),
    ("PostToolUse", true),
    ("PermissionRequest", true),
    ("Notification", false),
];
const DROID_SETTINGS: ClaudeCompatibleSettings = ClaudeCompatibleSettings {
    agent: "droid",
    config_dir_name: ".factory",
    script_base_name: "droid-hook",
};

fn definition_is_managed(value: &serde_json::Value) -> bool {
    value
        .get("hooks")
        .and_then(serde_json::Value::as_array)
        .map(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(serde_json::Value::as_str)
                    .map(|command| command_references_managed_script(command, &DROID_SETTINGS))
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
    let Some(path) = config_path(&DROID_SETTINGS) else {
        return error_status(
            &DROID_SETTINGS,
            String::new(),
            "Could not resolve home directory.".into(),
        );
    };
    let path_text = path.display().to_string();
    let root = match read_settings_for_mutation(&path) {
        Ok(value) => value,
        Err(detail) => return error_status(&DROID_SETTINGS, path_text, detail),
    };
    let disabled = root
        .get("hooksDisabled")
        .and_then(serde_json::Value::as_bool)
        == Some(true);
    let hooks = root.get("hooks").and_then(serde_json::Value::as_object);
    let mut present = 0;
    let mut missing = Vec::new();
    for (event, _) in DROID_EVENTS {
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
    let state = if disabled || (present > 0 && !missing.is_empty()) {
        AgentHookInstallState::Partial
    } else if missing.is_empty() {
        AgentHookInstallState::Installed
    } else {
        AgentHookInstallState::NotInstalled
    };
    let detail = if disabled && missing.is_empty() {
        Some("Droid hooks are disabled in Factory settings".into())
    } else if disabled {
        Some(format!(
            "Droid hooks are disabled in Factory settings; managed hook missing for events: {}",
            missing.join(", ")
        ))
    } else if present > 0 && !missing.is_empty() {
        Some(format!(
            "Managed hook missing for events: {}",
            missing.join(", ")
        ))
    } else {
        None
    };
    AgentHookInstallStatus {
        agent: "droid",
        state,
        config_path: path_text,
        managed_hooks_present: present > 0,
        detail,
    }
}

pub(super) fn apply(enabled: bool) -> AgentHookInstallStatus {
    let Some(path) = config_path(&DROID_SETTINGS) else {
        return error_status(
            &DROID_SETTINGS,
            String::new(),
            "Could not resolve home directory.".into(),
        );
    };
    let result = (|| -> Result<(), String> {
        let mut root = read_settings_for_mutation(&path)?;
        if !root.is_object() {
            return Err("Factory settings must contain a JSON object.".into());
        }
        remove_managed(&mut root);
        if enabled {
            let command = managed_command(&DROID_SETTINGS)
                .ok_or_else(|| "Could not build Droid hook command.".to_string())?;
            let hooks = root
                .as_object_mut()
                .expect("validated object")
                .entry("hooks")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or_else(|| "Factory hooks must be an object.".to_string())?;
            for (event, matcher) in DROID_EVENTS {
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
                    .ok_or_else(|| format!("Factory {event} hooks must be an array."))?
                    .push(definition);
            }
            let script = managed_script_path(&DROID_SETTINGS)
                .ok_or_else(|| "Could not resolve Droid script path.".to_string())?;
            fs::create_dir_all(script.parent().expect("script parent"))
                .map_err(|error| error.to_string())?;
            fs::write(&script, managed_script(&DROID_SETTINGS))
                .map_err(|error| error.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&script, fs::Permissions::from_mode(0o700))
                    .map_err(|error| error.to_string())?;
            }
        } else if let Some(script) = managed_script_path(&DROID_SETTINGS) {
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
        Err(detail) => error_status(&DROID_SETTINGS, path.display().to_string(), detail),
    }
}
