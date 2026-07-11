use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::{
    error_status, home_dir, AgentHookInstallState, AgentHookInstallStatus, ClaudeCompatibleSettings,
};

struct Event {
    name: &'static str,
    tool_schema: bool,
    wrapper: &'static str,
}

const EVENTS: &[Event] = &[
    Event {
        name: "PreInvocation",
        tool_schema: false,
        wrapper: "antigravity-pre-invocation.cmd",
    },
    Event {
        name: "PostInvocation",
        tool_schema: false,
        wrapper: "antigravity-post-invocation.cmd",
    },
    Event {
        name: "Stop",
        tool_schema: false,
        wrapper: "antigravity-stop.cmd",
    },
    Event {
        name: "PostToolUse",
        tool_schema: true,
        wrapper: "antigravity-post-tool-use.cmd",
    },
];
const BUNDLE: &str = "pebble-status";
const LEGACY_BUNDLE: &str = "orca-status";
const SETTINGS: ClaudeCompatibleSettings = ClaudeCompatibleSettings {
    agent: "antigravity",
    config_dir_name: ".gemini/config",
    script_base_name: "antigravity-hook",
};

fn config_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".gemini/config/hooks.json"))
}

fn scripts_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".pebble/agent-hooks"))
}

fn core_path() -> Option<PathBuf> {
    scripts_dir().map(|dir| {
        dir.join(if cfg!(windows) {
            "antigravity-hook.cmd"
        } else {
            "antigravity-hook.sh"
        })
    })
}

fn event_command(event: &Event) -> Option<String> {
    let dir = scripts_dir()?;
    if cfg!(windows) {
        return Some(dir.join(event.wrapper).display().to_string());
    }
    let path = dir
        .join("antigravity-hook.sh")
        .to_string_lossy()
        .replace('\'', "'\\''");
    Some(format!(
        "if [ -x '{path}' ]; then PEBBLE_ANTIGRAVITY_EVENT='{}' /bin/sh '{path}'; fi",
        event.name
    ))
}

fn is_managed(command: &str) -> bool {
    [
        "antigravity-hook.sh",
        "antigravity-hook.cmd",
        "antigravity-pre-invocation.cmd",
        "antigravity-post-invocation.cmd",
        "antigravity-stop.cmd",
        "antigravity-post-tool-use.cmd",
    ]
    .iter()
    .any(|name| command.contains(name))
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
        .filter(|definition| !definition_commands(definition).into_iter().any(is_managed))
        .cloned()
        .collect()
}

fn legacy_managed(command: &str) -> bool {
    command.contains(".orca/agent-hooks/antigravity-hook.sh")
        && command.contains("ORCA_ANTIGRAVITY_EVENT")
}

fn remove_legacy_managed(definitions: &[Value]) -> Vec<Value> {
    definitions
        .iter()
        .filter(|definition| {
            !definition_commands(definition)
                .into_iter()
                .any(legacy_managed)
        })
        .cloned()
        .collect()
}

fn sweep_legacy_bundle(root: &mut Map<String, Value>) {
    let Some(bundle) = root.get_mut(LEGACY_BUNDLE).and_then(Value::as_object_mut) else {
        return;
    };
    // Why: this is a one-way brand migration, not runtime compatibility; only
    // definitions with both old managed signatures are eligible for deletion.
    for definitions in bundle.values_mut() {
        if let Some(items) = definitions.as_array_mut() {
            *items = remove_legacy_managed(items);
        }
    }
    bundle.retain(|_, definitions| !definitions.as_array().is_some_and(Vec::is_empty));
    if bundle.is_empty() {
        root.remove(LEGACY_BUNDLE);
    }
}

fn read_config(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|_| "Could not parse Antigravity hooks.json".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Map::new())),
        Err(error) => Err(error.to_string()),
    }
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".antigravity-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn write_script(path: &Path, content: &str) -> Result<(), String> {
    write_atomic(path, content.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn posix_script() -> &'static str {
    r#"#!/bin/sh
case "$PEBBLE_ANTIGRAVITY_EVENT" in Stop) printf '{"decision":""}\n' ;; *) printf '{}\n' ;; esac
if [ -n "$PEBBLE_AGENT_HOOK_ENDPOINT" ] && [ -r "$PEBBLE_AGENT_HOOK_ENDPOINT" ]; then . "$PEBBLE_AGENT_HOOK_ENDPOINT" 2>/dev/null || :; fi
if [ -z "$PEBBLE_AGENT_HOOK_PORT" ] || [ -z "$PEBBLE_AGENT_HOOK_TOKEN" ] || [ -z "$PEBBLE_PANE_KEY" ]; then exit 0; fi
payload=$(cat); if [ -z "$payload" ]; then payload='{}'; fi
printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:${PEBBLE_AGENT_HOOK_PORT}/hook/antigravity" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/x-www-form-urlencoded" -H "X-Pebble-Agent-Hook-Token: ${PEBBLE_AGENT_HOOK_TOKEN}" --data-urlencode "paneKey=${PEBBLE_PANE_KEY}" --data-urlencode "tabId=${PEBBLE_TAB_ID}" --data-urlencode "launchToken=${PEBBLE_AGENT_LAUNCH_TOKEN}" --data-urlencode "worktreeId=${PEBBLE_WORKTREE_ID}" --data-urlencode "env=${PEBBLE_AGENT_HOOK_ENV}" --data-urlencode "version=${PEBBLE_AGENT_HOOK_VERSION}" --data-urlencode "hook_event_name=${PEBBLE_ANTIGRAVITY_EVENT}" --data-urlencode "payload@-" >/dev/null 2>&1 || true
exit 0
"#
}

fn windows_core() -> String {
    r#"@echo off
setlocal
if /I "%PEBBLE_ANTIGRAVITY_EVENT%"=="Stop" (echo {"decision":""}) else (echo {})
if defined PEBBLE_AGENT_HOOK_ENDPOINT if exist "%PEBBLE_AGENT_HOOK_ENDPOINT%" call "%PEBBLE_AGENT_HOOK_ENDPOINT%" 2>nul
if "%PEBBLE_AGENT_HOOK_PORT%"=="" exit /b 0
if "%PEBBLE_AGENT_HOOK_TOKEN%"=="" exit /b 0
if "%PEBBLE_PANE_KEY%"=="" exit /b 0
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$utf8=[System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding=$utf8; $inputData=[Console]::In.ReadToEnd(); try { $payload=if ([string]::IsNullOrWhiteSpace($inputData)) { @{} } else { $inputData | ConvertFrom-Json }; $body=@{ paneKey=$env:PEBBLE_PANE_KEY; launchToken=$env:PEBBLE_AGENT_LAUNCH_TOKEN; tabId=$env:PEBBLE_TAB_ID; worktreeId=$env:PEBBLE_WORKTREE_ID; env=$env:PEBBLE_AGENT_HOOK_ENV; version=$env:PEBBLE_AGENT_HOOK_VERSION; hook_event_name=$env:PEBBLE_ANTIGRAVITY_EVENT; payload=$payload } | ConvertTo-Json -Depth 100 -Compress; Invoke-WebRequest -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $env:PEBBLE_AGENT_HOOK_PORT + '/hook/antigravity') -ContentType 'application/json; charset=utf-8' -Headers @{ 'X-Pebble-Agent-Hook-Token'=$env:PEBBLE_AGENT_HOOK_TOKEN } -Body $utf8.GetBytes($body) -TimeoutSec 2 | Out-Null } catch {}"
exit /b 0
"#
    .replace('\n', "\r\n")
}

fn windows_wrapper(event: &Event) -> String {
    format!(
        "@echo off\r\nsetlocal\r\nset \"PEBBLE_ANTIGRAVITY_EVENT={}\"\r\nset \"PEBBLE_ANTIGRAVITY_CORE=%~dp0antigravity-hook.cmd\"\r\nif exist \"%PEBBLE_ANTIGRAVITY_CORE%\" (call \"%PEBBLE_ANTIGRAVITY_CORE%\" & exit /b 0)\r\nif /I \"%PEBBLE_ANTIGRAVITY_EVENT%\"==\"Stop\" (echo {{\"decision\":\"\"}}) else (echo {{}})\r\nexit /b 0\r\n",
        event.name
    )
}

fn bundle(config: &Value) -> Option<&Map<String, Value>> {
    config.get(BUNDLE).and_then(Value::as_object)
}

pub(super) fn status() -> AgentHookInstallStatus {
    let Some(path) = config_path() else {
        return error_status(
            &SETTINGS,
            String::new(),
            "Could not resolve Antigravity config path".into(),
        );
    };
    let path_text = path.display().to_string();
    let config = match read_config(&path) {
        Ok(value) => value,
        Err(detail) => return error_status(&SETTINGS, path_text, detail),
    };
    let mut present = 0;
    let mut missing = Vec::new();
    let mut stale = false;
    for event in EVENTS {
        let expected = event_command(event);
        let definitions = bundle(&config)
            .and_then(|bundle| bundle.get(event.name))
            .and_then(Value::as_array);
        if definitions.is_some_and(|items| {
            items
                .iter()
                .flat_map(definition_commands)
                .any(|item| expected.as_deref() == Some(item))
        }) {
            present += 1;
        } else {
            missing.push(event.name);
        }
    }
    if let Some(bundle) = bundle(&config) {
        for (name, definitions) in bundle {
            let expected = EVENTS
                .iter()
                .find(|event| event.name == name)
                .and_then(event_command);
            stale |= definitions.as_array().is_some_and(|items| {
                items
                    .iter()
                    .flat_map(definition_commands)
                    .any(|item| is_managed(item) && expected.as_deref() != Some(item))
            });
        }
    }
    let managed_hooks_present = present > 0 || stale;
    let (state, detail) = if missing.is_empty() && !stale {
        (AgentHookInstallState::Installed, None)
    } else if present == 0 && !stale {
        (AgentHookInstallState::NotInstalled, None)
    } else if !missing.is_empty() {
        (
            AgentHookInstallState::Partial,
            Some(format!(
                "Managed hook missing for events: {}",
                missing.join(", ")
            )),
        )
    } else {
        (
            AgentHookInstallState::Partial,
            Some("Stale managed hook entries need cleanup".into()),
        )
    };
    AgentHookInstallStatus {
        agent: "antigravity",
        state,
        config_path: path_text,
        managed_hooks_present,
        detail,
    }
}

pub(super) fn apply(enabled: bool) -> AgentHookInstallStatus {
    let Some(path) = config_path() else {
        return error_status(
            &SETTINGS,
            String::new(),
            "Could not resolve Antigravity config path".into(),
        );
    };
    let result = (|| -> Result<(), String> {
        let mut config = read_config(&path)?;
        let root = config
            .as_object_mut()
            .ok_or("Antigravity hooks.json root must be an object")?;
        sweep_legacy_bundle(root);
        let bundle = root
            .entry(BUNDLE)
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or("Antigravity pebble-status bundle must be an object")?;
        for definitions in bundle.values_mut() {
            if let Some(items) = definitions.as_array_mut() {
                *items = remove_managed(items);
            }
        }
        bundle.retain(|_, definitions| !definitions.as_array().is_some_and(Vec::is_empty));
        if enabled {
            let core = core_path().ok_or("Could not resolve Antigravity script path")?;
            let core_source = if cfg!(windows) {
                windows_core()
            } else {
                posix_script().into()
            };
            write_script(&core, &core_source)?;
            if cfg!(windows) {
                let dir = scripts_dir().unwrap();
                for event in EVENTS {
                    write_script(&dir.join(event.wrapper), &windows_wrapper(event))?;
                }
            }
            for event in EVENTS {
                let current = bundle
                    .entry(event.name)
                    .or_insert_with(|| Value::Array(Vec::new()))
                    .as_array_mut()
                    .ok_or("Antigravity event must be an array")?;
                let command =
                    event_command(event).ok_or("Could not resolve Antigravity command")?;
                current.push(if event.tool_schema {
                    json!({ "matcher": "*", "hooks": [{ "type": "command", "command": command, "timeout": 5 }] })
                } else {
                    json!({ "type": "command", "command": command, "timeout": 5 })
                });
            }
        } else if bundle.is_empty() {
            root.remove(BUNDLE);
        }
        let serialized = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
        write_atomic(&path, &[serialized, b"\n".to_vec()].concat())
    })();
    match result {
        Ok(()) => status(),
        Err(detail) => error_status(&SETTINGS, path.display().to_string(), detail),
    }
}
