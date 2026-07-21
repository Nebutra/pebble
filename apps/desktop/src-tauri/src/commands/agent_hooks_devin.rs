use std::fs;
use std::path::PathBuf;

use super::{
    command_references_managed_script, error_status, home_dir, managed_script, managed_script_path,
    write_json_atomically, AgentHookInstallState, AgentHookInstallStatus, ClaudeCompatibleSettings,
};

const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "PostCompaction",
    "SessionEnd",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
];
const SETTINGS: ClaudeCompatibleSettings = ClaudeCompatibleSettings {
    agent: "devin",
    config_dir_name: ".config",
    script_base_name: "devin-hook",
};
const CLAUDE_IMPORT_DETAIL: &str =
    "Devin read_config_from.claude is enabled; imported Claude hooks may fire alongside Devin hooks.";

fn config_path() -> Option<PathBuf> {
    if cfg!(windows) {
        if std::env::var_os("PEBBLE_AGENT_HOOKS_HOME").is_some() {
            return home_dir().map(|home| {
                home.join("AppData")
                    .join("Roaming")
                    .join("devin")
                    .join("config.json")
            });
        }
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|home| home.join("AppData").join("Roaming")))
            .map(|root| root.join("devin").join("config.json"));
    }
    home_dir().map(|home| home.join(".config").join("devin").join("config.json"))
}

fn read_config(path: &std::path::Path) -> Result<serde_json::Value, String> {
    match fs::read_to_string(path) {
        Ok(text) => json5::from_str::<serde_json::Value>(&text)
            .map_err(|_| "Could not parse Devin config.json".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(error) => Err(format!("Could not read Devin config.json: {error}")),
    }
}

fn managed_command() -> Option<String> {
    let path = managed_script_path(&SETTINGS)?;
    if cfg!(windows) {
        let escaped = path.to_string_lossy().replace('"', "\"\"");
        return Some(format!("cmd /d /s /c \"\"{escaped}\"\""));
    }
    let quoted = path.to_string_lossy().replace('\'', "'\\''");
    Some(format!("if [ -x '{quoted}' ]; then /bin/sh '{quoted}'; fi"))
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

fn imports_claude(root: &serde_json::Value) -> bool {
    match root.get("read_config_from") {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::Bool(value)) => *value,
        Some(serde_json::Value::Array(values)) => values.iter().any(|value| value == "claude"),
        Some(serde_json::Value::Object(value)) => {
            value.get("claude").and_then(serde_json::Value::as_bool) != Some(false)
        }
        _ => false,
    }
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
    let root = match read_config(&path) {
        Ok(value) => value,
        Err(detail) => return error_status(&SETTINGS, path_text, detail),
    };
    let hooks = root.get("hooks").and_then(serde_json::Value::as_object);
    let mut present = 0;
    let mut missing = Vec::new();
    for event in EVENTS {
        let found = hooks
            .and_then(|map| map.get(*event))
            .and_then(serde_json::Value::as_array)
            .map(|definitions| definitions.iter().any(definition_is_managed))
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
    let mut details = Vec::new();
    if present > 0 && !missing.is_empty() {
        details.push(format!(
            "Managed hook missing for events: {}",
            missing.join(", ")
        ));
    }
    if imports_claude(&root) {
        details.push(CLAUDE_IMPORT_DETAIL.into());
    }
    AgentHookInstallStatus {
        agent: "devin",
        state,
        config_path: path_text,
        managed_hooks_present: present > 0,
        detail: (!details.is_empty()).then(|| details.join(" ")),
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
        let mut root = read_config(&path)?;
        if !root.is_object() {
            return Err("Devin config must contain an object.".into());
        }
        remove_managed(&mut root);
        if enabled {
            let command = managed_command()
                .ok_or_else(|| "Could not build Devin hook command.".to_string())?;
            let hooks = root
                .as_object_mut()
                .unwrap()
                .entry("hooks")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or_else(|| "Devin hooks must be an object.".to_string())?;
            for event in EVENTS {
                hooks.entry((*event).to_string()).or_insert_with(|| serde_json::json!([])).as_array_mut()
                    .ok_or_else(|| format!("Devin {event} hooks must be an array."))?
                    .push(serde_json::json!({"hooks":[{"type":"command","command":command,"timeout":10}]}));
            }
            let script = managed_script_path(&SETTINGS)
                .ok_or_else(|| "Could not resolve Devin script path.".to_string())?;
            fs::create_dir_all(script.parent().unwrap()).map_err(|error| error.to_string())?;
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
