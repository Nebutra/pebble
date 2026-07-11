use std::fs;
use std::path::PathBuf;

use serde_json::{json, Map, Value};

use super::{
    error_status, home_dir, AgentHookInstallState, AgentHookInstallStatus, ClaudeCompatibleSettings,
};

const EVENTS: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "subagentStart",
    "SubagentStop",
    "PreCompact",
    "Stop",
    "ErrorOccurred",
    "PermissionRequest",
    "Notification",
];
const SETTINGS: ClaudeCompatibleSettings = ClaudeCompatibleSettings {
    agent: "copilot",
    config_dir_name: ".copilot",
    script_base_name: "copilot-hook",
};

fn copilot_home() -> Option<PathBuf> {
    std::env::var("COPILOT_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".copilot")))
}

fn config_path() -> Option<PathBuf> {
    copilot_home().map(|home| home.join("hooks").join("pebble.json"))
}

fn script_path() -> Option<PathBuf> {
    let extension = if cfg!(windows) { "ps1" } else { "sh" };
    home_dir().map(|home| {
        home.join(".pebble")
            .join("agent-hooks")
            .join(format!("copilot-hook.{extension}"))
    })
}

fn command(path: &std::path::Path, event: &str) -> String {
    if cfg!(windows) {
        let path = path.to_string_lossy().replace('\'', "''");
        return format!("$env:PEBBLE_COPILOT_HOOK_EVENT = '{event}'; powershell.exe -NoProfile -ExecutionPolicy Bypass -File '{path}'");
    }
    let path = path.to_string_lossy().replace('\'', "'\\''");
    format!("if [ -x '{path}' ]; then PEBBLE_COPILOT_HOOK_EVENT='{event}' /bin/sh '{path}'; fi")
}

fn managed(value: &str) -> bool {
    value.contains("agent-hooks/copilot-hook.sh")
        || value.contains("agent-hooks/copilot-hook.ps1")
        || value.contains("agent-hooks\\copilot-hook.ps1")
}

fn definition_commands(definition: &Value) -> Vec<&str> {
    let mut commands = ["command", "bash", "powershell"]
        .into_iter()
        .filter_map(|key| definition.get(key).and_then(Value::as_str))
        .collect::<Vec<_>>();
    if let Some(hooks) = definition.get("hooks").and_then(Value::as_array) {
        commands.extend(
            hooks
                .iter()
                .filter_map(|hook| hook.get("command").and_then(Value::as_str)),
        );
    }
    commands
}

fn remove_managed(definitions: &[Value]) -> Vec<Value> {
    definitions
        .iter()
        .filter(|definition| !definition_commands(definition).into_iter().any(managed))
        .cloned()
        .collect()
}

fn read_config(path: &std::path::Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|_| "Could not parse Copilot hooks/pebble.json".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({ "hooks": {} })),
        Err(error) => Err(error.to_string()),
    }
}

fn script() -> &'static str {
    if cfg!(windows) {
        return r#"Write-Output '{}'
if ($env:PEBBLE_AGENT_HOOK_ENDPOINT -and (Test-Path -LiteralPath $env:PEBBLE_AGENT_HOOK_ENDPOINT)) {
  try { Get-Content -LiteralPath $env:PEBBLE_AGENT_HOOK_ENDPOINT | ForEach-Object { if ($_ -match '^set ([A-Za-z0-9_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } } } catch {}
}
if (-not $env:PEBBLE_AGENT_HOOK_PORT -or -not $env:PEBBLE_AGENT_HOOK_TOKEN -or -not $env:PEBBLE_PANE_KEY) { exit 0 }
$inputData = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($inputData)) { exit 0 }
try { $payload = $inputData | ConvertFrom-Json; $body = @{ paneKey=$env:PEBBLE_PANE_KEY; launchToken=$env:PEBBLE_AGENT_LAUNCH_TOKEN; tabId=$env:PEBBLE_TAB_ID; worktreeId=$env:PEBBLE_WORKTREE_ID; hookEventName=$env:PEBBLE_COPILOT_HOOK_EVENT; env=$env:PEBBLE_AGENT_HOOK_ENV; version=$env:PEBBLE_AGENT_HOOK_VERSION; payload=$payload } | ConvertTo-Json -Depth 100; Invoke-WebRequest -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $env:PEBBLE_AGENT_HOOK_PORT + '/hook/copilot') -Headers @{ 'Content-Type'='application/json'; 'X-Pebble-Agent-Hook-Token'=$env:PEBBLE_AGENT_HOOK_TOKEN } -Body $body -TimeoutSec 2 | Out-Null } catch {}
exit 0
"#;
    }
    r#"#!/bin/sh
printf '{}\n'
if [ -n "$PEBBLE_AGENT_HOOK_ENDPOINT" ] && [ -r "$PEBBLE_AGENT_HOOK_ENDPOINT" ]; then . "$PEBBLE_AGENT_HOOK_ENDPOINT" 2>/dev/null || :; fi
if [ -z "$PEBBLE_AGENT_HOOK_PORT" ] || [ -z "$PEBBLE_AGENT_HOOK_TOKEN" ] || [ -z "$PEBBLE_PANE_KEY" ]; then exit 0; fi
payload=$(cat)
if [ -z "$payload" ]; then exit 0; fi
printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:${PEBBLE_AGENT_HOOK_PORT}/hook/copilot" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/x-www-form-urlencoded" -H "X-Pebble-Agent-Hook-Token: ${PEBBLE_AGENT_HOOK_TOKEN}" --data-urlencode "paneKey=${PEBBLE_PANE_KEY}" --data-urlencode "tabId=${PEBBLE_TAB_ID}" --data-urlencode "launchToken=${PEBBLE_AGENT_LAUNCH_TOKEN}" --data-urlencode "worktreeId=${PEBBLE_WORKTREE_ID}" --data-urlencode "hookEventName=${PEBBLE_COPILOT_HOOK_EVENT}" --data-urlencode "env=${PEBBLE_AGENT_HOOK_ENV}" --data-urlencode "version=${PEBBLE_AGENT_HOOK_VERSION}" --data-urlencode "payload@-" >/dev/null 2>&1 || true
exit 0
"#
}

fn write_atomic(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".copilot-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn write_script(path: &std::path::Path) -> Result<(), String> {
    write_atomic(path, script().as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn status() -> AgentHookInstallStatus {
    let Some(config_path) = config_path() else {
        return error_status(
            &SETTINGS,
            String::new(),
            "Could not resolve Copilot home".into(),
        );
    };
    let path_text = config_path.display().to_string();
    let config = match read_config(&config_path) {
        Ok(value) => value,
        Err(detail) => return error_status(&SETTINGS, path_text, detail),
    };
    let hooks = config.get("hooks").and_then(Value::as_object);
    let script = script_path();
    let mut present = 0;
    let mut missing = Vec::new();
    let mut stale = false;
    for event in EVENTS {
        let expected = script.as_ref().map(|path| command(path, event));
        let definitions = hooks
            .and_then(|hooks| hooks.get(*event))
            .and_then(Value::as_array);
        if definitions.is_some_and(|defs| {
            defs.iter().any(|definition| {
                expected.as_ref().is_some_and(|expected| {
                    definition_commands(definition).contains(&expected.as_str())
                })
            })
        }) {
            present += 1
        } else {
            missing.push(*event)
        }
    }
    if let Some(hooks) = hooks {
        for (event, definitions) in hooks {
            let expected = if EVENTS.contains(&event.as_str()) {
                script.as_ref().map(|path| command(path, event))
            } else {
                None
            };
            stale |= definitions.as_array().is_some_and(|defs| {
                defs.iter()
                    .flat_map(definition_commands)
                    .any(|item| managed(item) && expected.as_deref() != Some(item))
            });
        }
    }
    let managed_hooks_present = present > 0 || stale;
    let (state, detail) =
        if config.get("disableAllHooks") == Some(&Value::Bool(true)) && managed_hooks_present {
            (
                AgentHookInstallState::Partial,
                Some("Managed Copilot hook file is disabled".into()),
            )
        } else if stale {
            (
                AgentHookInstallState::Partial,
                Some("Managed Copilot hook file contains stale entries".into()),
            )
        } else if missing.is_empty() {
            (AgentHookInstallState::Installed, None)
        } else if present == 0 {
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
        agent: "copilot",
        state,
        config_path: path_text,
        managed_hooks_present,
        detail,
    }
}

pub(super) fn apply(enabled: bool) -> AgentHookInstallStatus {
    let Some(config_path) = config_path() else {
        return error_status(
            &SETTINGS,
            String::new(),
            "Could not resolve Copilot home".into(),
        );
    };
    let result = (|| -> Result<(), String> {
        let mut config = read_config(&config_path)?;
        let root = config
            .as_object_mut()
            .ok_or("Copilot pebble.json root must be an object")?;
        let hooks = root
            .entry("hooks")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or("Copilot hooks must be an object")?;
        for definitions in hooks.values_mut() {
            if let Some(array) = definitions.as_array_mut() {
                *array = remove_managed(array);
            }
        }
        hooks.retain(|_, definitions| !definitions.as_array().is_some_and(Vec::is_empty));
        if enabled {
            let path = script_path().ok_or("Could not resolve Copilot managed script path")?;
            write_script(&path)?;
            for event in EVENTS {
                hooks.entry(*event).or_insert_with(|| Value::Array(Vec::new())).as_array_mut().ok_or("Copilot event hooks must be arrays")?.push(if cfg!(windows) { json!({ "type": "command", "powershell": command(&path, event), "timeoutSec": 5 }) } else { json!({ "type": "command", "bash": command(&path, event), "timeoutSec": 5 }) });
            }
            root.insert("version".into(), Value::Number(1.into()));
            root.remove("disableAllHooks");
        }
        let serialized = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
        write_atomic(&config_path, &[serialized, b"\n".to_vec()].concat())
    })();
    match result {
        Ok(()) => status(),
        Err(detail) => error_status(&SETTINGS, config_path.display().to_string(), detail),
    }
}
