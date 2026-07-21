use std::fs;
use std::path::{Path, PathBuf};

use serde_yaml::{Mapping, Value};

use super::{
    error_status, home_dir, AgentHookInstallState, AgentHookInstallStatus, ClaudeCompatibleSettings,
};

const PLUGIN: &str = "pebble-status";
const MARKER: &str = "Managed by Pebble. Do not edit; changes may be overwritten.";
const EVENTS: &[&str] = &[
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
];
const SETTINGS: ClaudeCompatibleSettings = ClaudeCompatibleSettings {
    agent: "hermes",
    config_dir_name: ".hermes",
    script_base_name: "hermes-plugin",
};
const INIT_SOURCE: &str = include_str!("agent_hooks_hermes_plugin.py");

fn hermes_home() -> Option<PathBuf> {
    std::env::var("HERMES_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".hermes")))
}

fn config_path() -> Option<PathBuf> {
    hermes_home().map(|home| home.join("config.yaml"))
}

fn plugin_dir() -> Option<PathBuf> {
    hermes_home().map(|home| home.join("plugins").join(PLUGIN))
}

fn manifest() -> String {
    let hooks = EVENTS
        .iter()
        .map(|event| format!("  - {event}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "# {MARKER}\nname: {PLUGIN}\nversion: 1.0.0\ndescription: \"Reports Hermes Agent lifecycle events to Pebble.\"\nauthor: \"Pebble\"\nkind: standalone\nprovides_hooks:\n{hooks}\n"
    )
}

fn read_config(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(Value::Mapping(Mapping::new())),
        Ok(text) => {
            match serde_yaml::from_str::<Value>(&text).map_err(|error| error.to_string())? {
                Value::Mapping(map) => Ok(Value::Mapping(map)),
                Value::Null => Ok(Value::Mapping(Mapping::new())),
                _ => Err("Hermes config.yaml root must be a mapping".into()),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(Value::Mapping(Mapping::new()))
        }
        Err(error) => Err(error.to_string()),
    }
}

fn string_list(value: Option<&Value>) -> Result<Vec<String>, ()> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Value::Sequence(items) = value else {
        return Err(());
    };
    items
        .iter()
        .map(|item| item.as_str().map(str::to_owned).ok_or(()))
        .collect()
}

fn plugins_mapping(config: &mut Value) -> &mut Mapping {
    let root = config.as_mapping_mut().expect("validated mapping");
    let key = Value::String("plugins".into());
    if !root.get(&key).is_some_and(Value::is_mapping) {
        root.insert(key.clone(), Value::Mapping(Mapping::new()));
    }
    root.get_mut(&key).unwrap().as_mapping_mut().unwrap()
}

fn set_list(plugins: &mut Mapping, key: &str, values: Vec<String>) {
    plugins.insert(
        Value::String(key.into()),
        Value::Sequence(values.into_iter().map(Value::String).collect()),
    );
}

fn enable(config: &mut Value) {
    let plugins = plugins_mapping(config);
    let mut enabled = string_list(plugins.get(Value::String("enabled".into()))).unwrap_or_default();
    if !enabled.iter().any(|item| item == PLUGIN) {
        enabled.push(PLUGIN.into());
    }
    enabled.sort();
    enabled.dedup();
    let disabled = string_list(plugins.get(Value::String("disabled".into())))
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item != PLUGIN)
        .collect();
    set_list(plugins, "enabled", enabled);
    set_list(plugins, "disabled", disabled);
}

fn disable(config: &mut Value) {
    let plugins = plugins_mapping(config);
    if let Ok(enabled) = string_list(plugins.get(Value::String("enabled".into()))) {
        set_list(
            plugins,
            "enabled",
            enabled.into_iter().filter(|item| item != PLUGIN).collect(),
        );
    }
}

fn plugin_state() -> (bool, bool, Option<String>) {
    let Some(dir) = plugin_dir() else {
        return (
            false,
            false,
            Some("Could not resolve Hermes plugin directory".into()),
        );
    };
    let manifest_path = dir.join("plugin.yaml");
    let init_path = dir.join("__init__.py");
    if !manifest_path.exists() || !init_path.exists() {
        return (
            false,
            false,
            Some("Managed Hermes plugin files are missing".into()),
        );
    }
    match (
        fs::read_to_string(manifest_path),
        fs::read_to_string(init_path),
    ) {
        (Ok(manifest), Ok(init)) => {
            let managed = manifest.contains(MARKER) && init.contains(MARKER);
            (
                true,
                managed,
                (!managed)
                    .then(|| "Hermes pebble-status plugin exists but is not Pebble-managed".into()),
            )
        }
        (Err(error), _) | (_, Err(error)) => (true, false, Some(error.to_string())),
    }
}

fn enablement(config: &Value) -> (bool, bool, Option<String>) {
    let Some(plugins) = config
        .as_mapping()
        .and_then(|root| root.get(Value::String("plugins".into())))
        .and_then(Value::as_mapping)
    else {
        return (false, false, Some("plugins.enabled is missing".into()));
    };
    let enabled = match string_list(plugins.get(Value::String("enabled".into()))) {
        Ok(items) => items,
        Err(()) => {
            return (
                false,
                false,
                Some("plugins.enabled is not a string list".into()),
            )
        }
    };
    let disabled = match string_list(plugins.get(Value::String("disabled".into()))) {
        Ok(items) => items,
        Err(()) => {
            return (
                false,
                false,
                Some("plugins.disabled is not a string list".into()),
            )
        }
    };
    (
        enabled.iter().any(|item| item == PLUGIN),
        disabled.iter().any(|item| item == PLUGIN),
        None,
    )
}

fn write_atomic(path: &Path, content: &[u8], backup: bool) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".hermes-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    if backup && path.exists() {
        fs::copy(path, format!("{}.bak", path.display())).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn write_config(path: &Path, config: &Value) -> Result<(), String> {
    let mut serialized = serde_yaml::to_string(config).map_err(|error| error.to_string())?;
    if let Some(stripped) = serialized.strip_prefix("---\n") {
        serialized = stripped.into();
    }
    write_atomic(path, serialized.as_bytes(), true)
}

fn write_plugin() -> Result<(), String> {
    let dir = plugin_dir().ok_or("Could not resolve Hermes plugin directory")?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    write_atomic(&dir.join("plugin.yaml"), manifest().as_bytes(), false)?;
    write_atomic(&dir.join("__init__.py"), INIT_SOURCE.as_bytes(), false)
}

pub(super) fn status() -> AgentHookInstallStatus {
    let Some(path) = config_path() else {
        return error_status(
            &SETTINGS,
            String::new(),
            "Could not resolve Hermes config path".into(),
        );
    };
    let path_text = path.display().to_string();
    let config = match read_config(&path) {
        Ok(value) => value,
        Err(detail) => {
            return error_status(
                &SETTINGS,
                path_text,
                format!("Could not parse Hermes config.yaml: {detail}"),
            )
        }
    };
    let (present, managed, plugin_detail) = plugin_state();
    let (enabled, disabled, config_detail) = enablement(&config);
    let state = if !present && !enabled {
        AgentHookInstallState::NotInstalled
    } else if present && managed && enabled && !disabled {
        AgentHookInstallState::Installed
    } else {
        AgentHookInstallState::Partial
    };
    let detail = matches!(state, AgentHookInstallState::Partial).then(|| {
        [
            plugin_detail,
            config_detail,
            (!enabled).then(|| "pebble-status is not enabled in Hermes config.yaml".into()),
            disabled.then(|| "pebble-status is disabled in Hermes config.yaml".into()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("; ")
    });
    AgentHookInstallStatus {
        agent: "hermes",
        state,
        config_path: path_text,
        managed_hooks_present: present && managed,
        detail,
    }
}

pub(super) fn apply(enabled: bool) -> AgentHookInstallStatus {
    let Some(path) = config_path() else {
        return error_status(
            &SETTINGS,
            String::new(),
            "Could not resolve Hermes config path".into(),
        );
    };
    let result = (|| -> Result<(), String> {
        let mut config = read_config(&path)?;
        if enabled {
            // Why: config must never enable a plugin whose files were only partially written.
            write_plugin()?;
            enable(&mut config);
        } else {
            let (present, managed, _) = plugin_state();
            if present && managed {
                fs::remove_dir_all(plugin_dir().unwrap()).map_err(|error| error.to_string())?;
            }
            disable(&mut config);
        }
        write_config(&path, &config)
    })();
    match result {
        Ok(()) => status(),
        Err(detail) => error_status(&SETTINGS, path.display().to_string(), detail),
    }
}
