use std::fs;
use std::path::PathBuf;

use super::{
    error_status, home_dir, AgentHookInstallState, AgentHookInstallStatus, ClaudeCompatibleSettings,
};

const EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "Stop",
    "StopFailure",
];
const BLOCK_START: &str = "# >>> pebble-managed-kimi-hooks (managed by Pebble; do not edit) >>>";
const BLOCK_END: &str = "# <<< pebble-managed-kimi-hooks <<<";
const SETTINGS: ClaudeCompatibleSettings = ClaudeCompatibleSettings {
    agent: "kimi",
    config_dir_name: ".kimi-code",
    script_base_name: "kimi-hook",
};

fn kimi_home() -> Option<PathBuf> {
    std::env::var_os("KIMI_CODE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".kimi-code")))
}

fn config_path() -> Option<PathBuf> {
    kimi_home().map(|home| home.join("config.toml"))
}

fn script_path() -> Option<PathBuf> {
    home_dir().map(|home| {
        home.join(".pebble")
            .join("agent-hooks")
            .join("kimi-hook.sh")
    })
}

fn strip_managed(text: &str) -> (String, bool) {
    let Some(start) = text.find(BLOCK_START) else {
        return (text.to_string(), false);
    };
    let prefix_start = text[..start].trim_end_matches(['\r', '\n']).len();
    let end = text[start..]
        .find(BLOCK_END)
        .map(|offset| {
            let marker_end = start + offset + BLOCK_END.len();
            text[marker_end..]
                .find('\n')
                .map(|tail| marker_end + tail + 1)
                .unwrap_or(text.len())
        })
        .unwrap_or(text.len());
    let mut next = String::with_capacity(text.len());
    next.push_str(&text[..prefix_start]);
    next.push_str(&text[end..]);
    let trimmed = next.trim_end();
    (
        if trimmed.is_empty() {
            String::new()
        } else {
            format!("{trimmed}\n")
        },
        true,
    )
}

fn command() -> Option<String> {
    let path = script_path()?
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "'\\''");
    Some(format!("if [ -x '{path}' ]; then /bin/sh '{path}'; fi"))
}

fn managed_block(command: &str) -> String {
    let literal = command
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    let entries = EVENTS
        .iter()
        .map(|event| {
            format!("[[hooks]]\nevent = \"{event}\"\ncommand = \"{literal}\"\ntimeout = 10")
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("{BLOCK_START}\n{entries}\n{BLOCK_END}\n")
}

fn read_text(path: &std::path::Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("Could not read Kimi config.toml: {error}")),
    }
}

fn write_text_atomically(path: &std::path::Path, text: &str) -> Result<(), String> {
    if fs::read_to_string(path).ok().as_deref() == Some(text) {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Kimi config path has no parent.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".kimi-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, text).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::copy(path, path.with_extension("toml.bak")).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

fn present_events(text: &str) -> Vec<&'static str> {
    let Some(start) = text.find(BLOCK_START) else {
        return Vec::new();
    };
    let block = &text[start..];
    EVENTS
        .iter()
        .copied()
        .filter(|event| {
            block.contains(&format!("event = \"{event}\""))
                && block.contains("agent-hooks/kimi-hook.sh")
        })
        .collect()
}

fn script_body() -> &'static str {
    r##"#!/bin/sh
if [ -n "$PEBBLE_AGENT_HOOK_ENDPOINT" ] && [ -r "$PEBBLE_AGENT_HOOK_ENDPOINT" ]; then . "$PEBBLE_AGENT_HOOK_ENDPOINT" 2>/dev/null || :; fi
if [ -z "$PEBBLE_AGENT_HOOK_PORT" ] || [ -z "$PEBBLE_AGENT_HOOK_TOKEN" ] || [ -z "$PEBBLE_PANE_KEY" ]; then exit 0; fi
payload=$(cat)
[ -n "$payload" ] || exit 0
printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:${PEBBLE_AGENT_HOOK_PORT}/hook/kimi" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/x-www-form-urlencoded" -H "X-Pebble-Agent-Hook-Token: ${PEBBLE_AGENT_HOOK_TOKEN}" --data-urlencode "paneKey=${PEBBLE_PANE_KEY}" --data-urlencode "tabId=${PEBBLE_TAB_ID}" --data-urlencode "launchToken=${PEBBLE_AGENT_LAUNCH_TOKEN}" --data-urlencode "worktreeId=${PEBBLE_WORKTREE_ID}" --data-urlencode "env=${PEBBLE_AGENT_HOOK_ENV}" --data-urlencode "version=${PEBBLE_AGENT_HOOK_VERSION}" --data-urlencode "payload@-" >/dev/null 2>&1 || true
exit 0
"##
}

pub(super) fn status() -> AgentHookInstallStatus {
    let Some(path) = config_path() else {
        return error_status(
            &SETTINGS,
            String::new(),
            "Could not resolve Kimi home.".into(),
        );
    };
    let path_text = path.display().to_string();
    let text = match read_text(&path) {
        Ok(text) => text,
        Err(detail) => return error_status(&SETTINGS, path_text, detail),
    };
    let present = present_events(&text);
    let missing = EVENTS
        .iter()
        .filter(|event| !present.contains(event))
        .copied()
        .collect::<Vec<_>>();
    let state = if missing.is_empty() {
        AgentHookInstallState::Installed
    } else if present.is_empty() {
        AgentHookInstallState::NotInstalled
    } else {
        AgentHookInstallState::Partial
    };
    AgentHookInstallStatus {
        agent: "kimi",
        state,
        config_path: path_text,
        managed_hooks_present: !present.is_empty(),
        detail: (!present.is_empty() && !missing.is_empty())
            .then(|| format!("Managed hook missing for events: {}", missing.join(", "))),
    }
}

pub(super) fn apply(enabled: bool) -> AgentHookInstallStatus {
    let Some(path) = config_path() else {
        return error_status(
            &SETTINGS,
            String::new(),
            "Could not resolve Kimi home.".into(),
        );
    };
    let result = (|| -> Result<(), String> {
        let current = read_text(&path)?;
        let (base, _) = strip_managed(&current);
        if enabled {
            let command =
                command().ok_or_else(|| "Could not build Kimi hook command.".to_string())?;
            let next = if base.is_empty() {
                managed_block(&command)
            } else {
                format!("{}\n{}", base.trim_end(), managed_block(&command))
            };
            let script =
                script_path().ok_or_else(|| "Could not resolve Kimi script path.".to_string())?;
            fs::create_dir_all(script.parent().unwrap()).map_err(|error| error.to_string())?;
            fs::write(&script, script_body()).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&script, fs::Permissions::from_mode(0o700))
                    .map_err(|error| error.to_string())?;
            }
            write_text_atomically(&path, &next)?;
        } else {
            write_text_atomically(&path, &base)?;
            if let Some(script) = script_path() {
                let _ = fs::remove_file(script);
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => status(),
        Err(detail) => error_status(&SETTINGS, path.display().to_string(), detail),
    }
}
