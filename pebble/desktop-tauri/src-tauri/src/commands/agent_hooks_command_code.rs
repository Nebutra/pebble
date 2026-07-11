use std::fs;

use super::{
    command_references_managed_script, config_path, error_status, managed_command,
    managed_script_path, read_settings_for_mutation, write_json_atomically, AgentHookInstallState,
    AgentHookInstallStatus, ClaudeCompatibleSettings,
};

const EVENTS: &[(&str, bool)] = &[("PreToolUse", true), ("PostToolUse", true), ("Stop", false)];
const SETTINGS: ClaudeCompatibleSettings = ClaudeCompatibleSettings {
    agent: "command-code",
    config_dir_name: ".commandcode",
    script_base_name: "command-code-hook",
};

const POSIX_SCRIPT: &str = r##"#!/bin/sh
__pebble_read_ancestor_var() {
  __pebble_name="$1"
  __pebble_pid="${PPID:-}"
  while [ -n "$__pebble_pid" ] && [ "$__pebble_pid" != "0" ] && [ "$__pebble_pid" != "1" ]; do
    __pebble_value=""
    if [ -r "/proc/$__pebble_pid/environ" ]; then
      __pebble_value=$(tr "\000" "\n" < "/proc/$__pebble_pid/environ" 2>/dev/null | sed -n "s/^${__pebble_name}=//p" | head -n 1)
    fi
    if [ -z "$__pebble_value" ]; then
      __pebble_value=$(ps eww -p "$__pebble_pid" -o command= 2>/dev/null | tr " " "\n" | sed -n "s/^${__pebble_name}=//p" | head -n 1)
    fi
    if [ -n "$__pebble_value" ]; then printf "%s\n" "$__pebble_value"; return 0; fi
    __pebble_pid=$(ps -o ppid= -p "$__pebble_pid" 2>/dev/null | tr -d " ")
  done
  return 1
}
__pebble_fill_from_ancestor() {
  __pebble_name="$1"
  eval "__pebble_current=\${$__pebble_name:-}"
  [ -z "$__pebble_current" ] || return 0
  __pebble_value=$(__pebble_read_ancestor_var "$__pebble_name") || return 0
  [ -n "$__pebble_value" ] && export "$__pebble_name=$__pebble_value"
}
__pebble_endpoint_value() {
  sed -n "s/^$1=//p" "$2" 2>/dev/null | head -n 1
}
__pebble_fill_from_endpoint_file() {
  __pebble_endpoint_path="$1"
  [ -r "$__pebble_endpoint_path" ] || return 0
  __pebble_endpoint_port=$(__pebble_endpoint_value PEBBLE_AGENT_HOOK_PORT "$__pebble_endpoint_path")
  if [ -n "${PEBBLE_AGENT_HOOK_PORT:-}" ] && [ -n "$__pebble_endpoint_port" ] && [ "$__pebble_endpoint_port" != "$PEBBLE_AGENT_HOOK_PORT" ]; then return 0; fi
  for __pebble_endpoint_name in AGENT_HOOK_PORT AGENT_HOOK_TOKEN AGENT_HOOK_ENV AGENT_HOOK_VERSION; do
    eval "__pebble_current=\${PEBBLE_$__pebble_endpoint_name:-}"
    [ -z "$__pebble_current" ] || continue
    __pebble_endpoint_value=$(__pebble_endpoint_value "PEBBLE_$__pebble_endpoint_name" "$__pebble_endpoint_path")
    [ -n "$__pebble_endpoint_value" ] && export "PEBBLE_$__pebble_endpoint_name=$__pebble_endpoint_value"
  done
}
for __pebble_name in PEBBLE_AGENT_HOOK_ENDPOINT PEBBLE_AGENT_HOOK_PORT PEBBLE_AGENT_HOOK_TOKEN PEBBLE_AGENT_HOOK_ENV PEBBLE_AGENT_HOOK_VERSION PEBBLE_PANE_KEY PEBBLE_TAB_ID PEBBLE_WORKTREE_ID PEBBLE_AGENT_LAUNCH_TOKEN; do
  __pebble_fill_from_ancestor "$__pebble_name"
done
if [ -n "$PEBBLE_AGENT_HOOK_ENDPOINT" ] && [ -r "$PEBBLE_AGENT_HOOK_ENDPOINT" ]; then
  __pebble_fill_from_endpoint_file "$PEBBLE_AGENT_HOOK_ENDPOINT"
fi
if [ -z "$PEBBLE_AGENT_HOOK_TOKEN" ] && [ -n "$PEBBLE_AGENT_HOOK_PORT" ]; then
  for endpoint in \
    "$HOME/Library/Application Support/pebble-dev/agent-hooks"/*/endpoint.env \
    "$HOME/Library/Application Support/pebble-dev/agent-hooks/endpoint.env" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/pebble-dev/agent-hooks"/*/endpoint.env \
    "${XDG_CONFIG_HOME:-$HOME/.config}/pebble-dev/agent-hooks/endpoint.env" \
    "$HOME/Library/Application Support/pebble/agent-hooks/endpoint.env" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/pebble/agent-hooks/endpoint.env"; do
    [ -r "$endpoint" ] || continue
    endpoint_port=$(sed -n "s/^PEBBLE_AGENT_HOOK_PORT=//p" "$endpoint" | head -n 1)
    if [ "$endpoint_port" = "$PEBBLE_AGENT_HOOK_PORT" ]; then __pebble_fill_from_endpoint_file "$endpoint"; break; fi
  done
fi
if [ -z "$PEBBLE_AGENT_HOOK_PORT" ] || [ -z "$PEBBLE_AGENT_HOOK_TOKEN" ] || [ -z "$PEBBLE_PANE_KEY" ]; then exit 0; fi
payload=$(cat)
[ -n "$payload" ] || exit 0
printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:${PEBBLE_AGENT_HOOK_PORT}/hook/command-code" \
  --connect-timeout 0.5 --max-time 1.5 \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Pebble-Agent-Hook-Token: ${PEBBLE_AGENT_HOOK_TOKEN}" \
  --data-urlencode "paneKey=${PEBBLE_PANE_KEY}" --data-urlencode "tabId=${PEBBLE_TAB_ID}" \
  --data-urlencode "launchToken=${PEBBLE_AGENT_LAUNCH_TOKEN}" --data-urlencode "worktreeId=${PEBBLE_WORKTREE_ID}" \
  --data-urlencode "env=${PEBBLE_AGENT_HOOK_ENV}" --data-urlencode "version=${PEBBLE_AGENT_HOOK_VERSION}" \
  --data-urlencode "payload@-" >/dev/null 2>&1 || true
exit 0
"##;

const WINDOWS_SCRIPT: &str = r#"@echo off
setlocal
if "%PEBBLE_AGENT_HOOK_PORT%"=="" if defined PEBBLE_AGENT_HOOK_ENDPOINT if exist "%PEBBLE_AGENT_HOOK_ENDPOINT%" call "%PEBBLE_AGENT_HOOK_ENDPOINT%" 2>nul
if "%PEBBLE_AGENT_HOOK_TOKEN%"=="" if not "%PEBBLE_AGENT_HOOK_PORT%"=="" call :sourceEndpointByPort
if "%PEBBLE_AGENT_HOOK_PORT%"=="" exit /b 0
if "%PEBBLE_AGENT_HOOK_TOKEN%"=="" exit /b 0
if "%PEBBLE_PANE_KEY%"=="" exit /b 0
"%SystemRoot%\System32\curl.exe" -sS -X POST "http://127.0.0.1:%PEBBLE_AGENT_HOOK_PORT%/hook/command-code" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/x-www-form-urlencoded" -H "X-Pebble-Agent-Hook-Token: %PEBBLE_AGENT_HOOK_TOKEN%" --data-urlencode "paneKey=%PEBBLE_PANE_KEY%" --data-urlencode "tabId=%PEBBLE_TAB_ID%" --data-urlencode "launchToken=%PEBBLE_AGENT_LAUNCH_TOKEN%" --data-urlencode "worktreeId=%PEBBLE_WORKTREE_ID%" --data-urlencode "env=%PEBBLE_AGENT_HOOK_ENV%" --data-urlencode "version=%PEBBLE_AGENT_HOOK_VERSION%" --data-urlencode "payload@-" >nul 2>nul
exit /b 0
:sourceEndpointByPort
if not defined APPDATA exit /b 0
if exist "%APPDATA%\pebble-dev\agent-hooks" for /r "%APPDATA%\pebble-dev\agent-hooks" %%F in (endpoint.cmd) do call :maybeSourceEndpoint "%%~fF"
if "%PEBBLE_AGENT_HOOK_TOKEN%"=="" if exist "%APPDATA%\pebble\agent-hooks" for /r "%APPDATA%\pebble\agent-hooks" %%F in (endpoint.cmd) do call :maybeSourceEndpoint "%%~fF"
exit /b 0
:maybeSourceEndpoint
if not "%PEBBLE_AGENT_HOOK_TOKEN%"=="" exit /b 0
for /f "tokens=2 delims==" %%P in ('findstr /b /c:"set PEBBLE_AGENT_HOOK_PORT=" "%~1" 2^>nul') do if "%%P"=="%PEBBLE_AGENT_HOOK_PORT%" call "%~1" 2>nul
exit /b 0
"#;

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
    let Some(path) = config_path(&SETTINGS) else {
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
        agent: "command-code",
        state,
        config_path: path_text,
        managed_hooks_present: present > 0,
        detail: (present > 0 && !missing.is_empty())
            .then(|| format!("Managed hook missing for events: {}", missing.join(", "))),
    }
}

pub(super) fn apply(enabled: bool) -> AgentHookInstallStatus {
    let Some(path) = config_path(&SETTINGS) else {
        return error_status(
            &SETTINGS,
            String::new(),
            "Could not resolve home directory.".into(),
        );
    };
    let result = (|| -> Result<(), String> {
        let mut root = read_settings_for_mutation(&path)?;
        if !root.is_object() {
            return Err("Command Code settings must contain a JSON object.".into());
        }
        remove_managed(&mut root);
        if enabled {
            let command = managed_command(&SETTINGS)
                .ok_or_else(|| "Could not build Command Code hook command.".to_string())?;
            let hooks = root
                .as_object_mut()
                .unwrap()
                .entry("hooks")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or_else(|| "Command Code hooks must be an object.".to_string())?;
            for (event, matcher) in EVENTS {
                let mut definition = serde_json::json!({"hooks":[{"type":"command","command":command,"timeout":10}]});
                if *matcher {
                    definition["matcher"] = serde_json::Value::String(".*".into());
                }
                hooks
                    .entry((*event).to_string())
                    .or_insert_with(|| serde_json::json!([]))
                    .as_array_mut()
                    .ok_or_else(|| format!("Command Code {event} hooks must be an array."))?
                    .push(definition);
            }
            let script = managed_script_path(&SETTINGS)
                .ok_or_else(|| "Could not resolve Command Code script path.".to_string())?;
            fs::create_dir_all(script.parent().unwrap()).map_err(|error| error.to_string())?;
            fs::write(
                &script,
                if cfg!(windows) {
                    WINDOWS_SCRIPT
                } else {
                    POSIX_SCRIPT
                },
            )
            .map_err(|error| error.to_string())?;
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
