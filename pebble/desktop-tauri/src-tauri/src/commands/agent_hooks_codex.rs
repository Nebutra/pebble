use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    error_status, home_dir, AgentHookInstallState, AgentHookInstallStatus, ClaudeCompatibleSettings,
};

const EVENTS: &[(&str, &str)] = &[
    ("SessionStart", "session_start"),
    ("UserPromptSubmit", "user_prompt_submit"),
    ("PreToolUse", "pre_tool_use"),
    ("PermissionRequest", "permission_request"),
    ("PostToolUse", "post_tool_use"),
    ("Stop", "stop"),
];
const TIMEOUT: u64 = 10;
const RESOURCE_ENTRIES: &[&str] = &[
    "skills",
    "hooks",
    "plugins",
    "plugin-state",
    "profile-v2",
    "themes",
    "prompts",
];
const SETTINGS: ClaudeCompatibleSettings = ClaudeCompatibleSettings {
    agent: "codex",
    config_dir_name: ".codex",
    script_base_name: "codex-hook",
};

fn system_home() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".codex"))
}

fn user_data() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PEBBLE_USER_DATA_PATH") {
        return Some(path.into());
    }
    let home = home_dir()?;
    #[cfg(target_os = "macos")]
    return Some(home.join("Library/Application Support/pebble"));
    #[cfg(target_os = "windows")]
    return Some(
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("pebble"),
    );
    #[cfg(all(unix, not(target_os = "macos")))]
    return Some(
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("pebble"),
    );
}

fn runtime_home() -> Option<PathBuf> {
    user_data().map(|path| path.join("codex-runtime-home/home"))
}
fn hooks_path() -> Option<PathBuf> {
    runtime_home().map(|home| home.join("hooks.json"))
}
fn toml_path() -> Option<PathBuf> {
    runtime_home().map(|home| home.join("config.toml"))
}
fn script_path() -> Option<PathBuf> {
    let extension = if cfg!(windows) { "cmd" } else { "sh" };
    home_dir().map(|home| home.join(format!(".pebble/agent-hooks/codex-hook.{extension}")))
}

fn command() -> Option<String> {
    let path = script_path()?;
    if cfg!(windows) {
        use base64::Engine;
        let path = path.to_string_lossy().replace('\'', "''");
        let powershell = format!("& '{path}'; exit $LASTEXITCODE");
        let encoded = base64::engine::general_purpose::STANDARD.encode(
            powershell
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        return Some(format!(
            "{}/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand {encoded}",
            system_root.replace('\\', "/")
        ));
    }
    let path = path.to_string_lossy().replace('\'', "'\\''");
    Some(format!("if [ -x '{path}' ]; then /bin/sh '{path}'; fi"))
}

fn managed(command: &str) -> bool {
    command.contains("agent-hooks/codex-hook.sh")
        || command.contains("agent-hooks/codex-hook.cmd")
        || command.contains("agent-hooks\\codex-hook.cmd")
}

fn read_hooks(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|_| "Could not parse Codex hooks.json".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({ "hooks": {} })),
        Err(error) => Err(error.to_string()),
    }
}

fn copy_recursively(source: &Path, target: &Path) -> Result<(), String> {
    if source.is_dir() {
        fs::create_dir_all(target).map_err(|error| error.to_string())?;
        for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            copy_recursively(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(source, target).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn sync_system_resources() -> Result<(), String> {
    let system = system_home().ok_or("Could not resolve system Codex home")?;
    let runtime = runtime_home().ok_or("Could not resolve runtime Codex home")?;
    fs::create_dir_all(&runtime).map_err(|error| error.to_string())?;
    let markers = runtime.join(".pebble-resource-copies");
    for name in RESOURCE_ENTRIES {
        let source = system.join(name);
        let target = runtime.join(name);
        let marker = markers.join(format!("{name}.json"));
        if !source.exists() {
            continue;
        }
        let points_to_source = fs::read_link(&target)
            .ok()
            .is_some_and(|path| path == source);
        if points_to_source {
            let _ = fs::remove_file(&marker);
            continue;
        }
        if target.exists() && !marker.exists() {
            continue;
        }
        if target.exists() {
            if target.is_dir() {
                fs::remove_dir_all(&target)
            } else {
                fs::remove_file(&target)
            }
            .map_err(|error| error.to_string())?;
        }
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&source, &target).is_ok();
        #[cfg(windows)]
        let linked = if source.is_dir() {
            std::os::windows::fs::symlink_dir(&source, &target).is_ok()
        } else {
            std::os::windows::fs::symlink_file(&source, &target).is_ok()
        };
        if linked {
            let _ = fs::remove_file(&marker);
            continue;
        }
        copy_recursively(&source, &target)?;
        fs::create_dir_all(&markers).map_err(|error| error.to_string())?;
        fs::write(
            &marker,
            format!(
                "{{\"sourcePath\":{}}}\n",
                serde_json::to_string(&source.display().to_string()).unwrap()
            ),
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn system_user_hooks() -> Result<Option<serde_json::Map<String, Value>>, String> {
    let Some(path) = system_home().map(|home| home.join("hooks.json")) else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let config = read_hooks(&path)?;
    let Some(hooks) = config.get("hooks").and_then(Value::as_object) else {
        return Ok(Some(serde_json::Map::new()));
    };
    let mut mirrored = serde_json::Map::new();
    for (event, definitions) in hooks {
        let Some(definitions) = definitions.as_array() else {
            continue;
        };
        let cleaned = remove_managed(definitions)
            .into_iter()
            .filter(|definition| {
                !definition.to_string().contains("${CLAUDE_PLUGIN_")
                    && !definition.to_string().contains("${PLUGIN_")
            })
            .fold(Vec::new(), |mut output, definition| {
                if !output.contains(&definition) {
                    output.push(definition);
                }
                output
            });
        if !cleaned.is_empty() {
            mirrored.insert(event.clone(), Value::Array(cleaned));
        }
    }
    Ok(Some(mirrored))
}

fn remove_managed(definitions: &[Value]) -> Vec<Value> {
    definitions
        .iter()
        .filter_map(|definition| {
            let mut next = definition.clone();
            let hooks = next.get_mut("hooks")?.as_array_mut()?;
            hooks.retain(|hook| {
                !hook
                    .get("command")
                    .and_then(Value::as_str)
                    .is_some_and(managed)
            });
            (!hooks.is_empty()).then_some(next)
        })
        .collect()
}

fn canonical_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}

fn trust_key(path: &Path, event_label: &str, group: usize, handler: usize) -> String {
    format!("{}:{event_label}:{group}:{handler}", canonical_path(path))
}

fn hook_hash(event_label: &str, command: &str, timeout: u64, asynchronous: bool, matcher: Option<&str>, status_message: Option<&str>) -> String {
    let mut handler = BTreeMap::new();
    handler.insert("async", json!(asynchronous));
    handler.insert("command", json!(command));
    if let Some(message) = status_message { handler.insert("statusMessage", json!(message)); }
    handler.insert("timeout", json!(timeout.max(1)));
    handler.insert("type", json!("command"));
    let mut identity = BTreeMap::new();
    identity.insert("event_name", json!(event_label));
    identity.insert("hooks", json!([handler]));
    if !matches!(event_label, "user_prompt_submit" | "stop") {
        if let Some(matcher) = matcher { identity.insert("matcher", json!(matcher)); }
    }
    let serialized = serde_json::to_vec(&identity).expect("JSON identity is serializable");
    format!("sha256:{:x}", Sha256::digest(serialized))
}

pub(super) fn trusted_hash(event_label: &str, command: &str) -> String {
    hook_hash(event_label, command, TIMEOUT, false, None, None)
}

fn escape_toml(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

fn trust_header(key: &str) -> String {
    format!("[hooks.state.\"{}\"]", escape_toml(key))
}

fn table_ranges(content: &str) -> Vec<(usize, usize, &str)> {
    let mut starts = content
        .match_indices('[')
        .filter(|(index, _)| *index == 0 || content.as_bytes().get(index - 1) == Some(&b'\n'))
        .filter_map(|(start, _)| {
            content[start..]
                .find('\n')
                .map(|length| (start, start + length, &content[start..start + length]))
        })
        .collect::<Vec<_>>();
    let content_len = content.len();
    let boundaries = starts
        .iter()
        .map(|item| item.0)
        .skip(1)
        .chain(std::iter::once(content_len))
        .collect::<Vec<_>>();
    for (item, end) in starts.iter_mut().zip(boundaries) {
        item.1 = end;
    }
    starts
}

fn upsert_trust(mut content: String, entries: &[(&str, String, bool)]) -> String {
    for (key, hash, enabled) in entries {
        let header = trust_header(key);
        let block = format!(
            "{header}\nenabled = {enabled}\ntrusted_hash = \"{}\"\n",
            escape_toml(hash)
        );
        let range = table_ranges(&content)
            .into_iter()
            .find(|(_, _, found)| *found == header);
        content = if let Some((start, end, _)) = range {
            format!("{}{}{}", &content[..start], block, &content[end..])
        } else {
            let separator = if content.is_empty() {
                ""
            } else if content.ends_with("\n\n") {
                ""
            } else if content.ends_with('\n') {
                "\n"
            } else {
                "\n\n"
            };
            format!("{content}{separator}{block}")
        };
    }
    content
}

fn remove_managed_trust(content: String, hooks_path: &Path, command: &str) -> String {
    let keys = EVENTS
        .iter()
        .map(|(_, label)| trust_key(hooks_path, label, 0, 0))
        .collect::<Vec<_>>();
    let hashes = EVENTS
        .iter()
        .map(|(_, label)| trusted_hash(label, command))
        .collect::<Vec<_>>();
    let ranges = table_ranges(&content);
    let mut output = String::new();
    let mut cursor = 0;
    for (start, end, header) in ranges {
        let owned = keys
            .iter()
            .zip(&hashes)
            .any(|(key, hash)| header == trust_header(key) && content[start..end].contains(hash));
        if owned {
            output.push_str(&content[cursor..start]);
            cursor = end;
        }
    }
    output.push_str(&content[cursor..]);
    output
}

fn mirror_system_config(runtime_path: &Path) -> Result<String, String> {
    let existing = fs::read_to_string(runtime_path).unwrap_or_default();
    let Some(system) = system_home().map(|home| home.join("config.toml")) else {
        return Ok(existing);
    };
    let Ok(system_content) = fs::read_to_string(system) else {
        return Ok(existing);
    };
    let preserved = table_ranges(&existing)
        .into_iter()
        .filter(|(_, _, header)| {
            header.starts_with("[hooks.state.") || header.starts_with("[projects.")
        })
        .map(|(start, end, _)| existing[start..end].trim().to_string())
        .collect::<Vec<_>>();
    let system_ranges = table_ranges(&system_content);
    let first_table = system_ranges
        .first()
        .map(|range| range.0)
        .unwrap_or(system_content.len());
    let mut system_without_runtime = system_content[..first_table].trim().to_string();
    for (start, end, header) in system_ranges {
        if !header.starts_with("[hooks.state.") {
            if !system_without_runtime.is_empty() {
                system_without_runtime.push_str("\n\n");
            }
            system_without_runtime.push_str(system_content[start..end].trim());
        }
    }
    let base = system_without_runtime.trim().to_string();
    Ok(if preserved.is_empty() {
        format!("{base}\n")
    } else {
        format!("{base}\n\n{}\n", preserved.join("\n\n"))
    })
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".codex-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn script() -> String {
    if cfg!(windows) {
        return r#"@echo off
setlocal
if defined PEBBLE_AGENT_HOOK_ENDPOINT if exist "%PEBBLE_AGENT_HOOK_ENDPOINT%" call "%PEBBLE_AGENT_HOOK_ENDPOINT%" 2>nul
if "%PEBBLE_AGENT_HOOK_PORT%"=="" exit /b 0
if "%PEBBLE_AGENT_HOOK_TOKEN%"=="" exit /b 0
if "%PEBBLE_PANE_KEY%"=="" exit /b 0
"%SystemRoot%\System32\curl.exe" -sS -X POST "http://127.0.0.1:%PEBBLE_AGENT_HOOK_PORT%/hook/codex" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/x-www-form-urlencoded" -H "X-Pebble-Agent-Hook-Token: %PEBBLE_AGENT_HOOK_TOKEN%" --data-urlencode "paneKey=%PEBBLE_PANE_KEY%" --data-urlencode "tabId=%PEBBLE_TAB_ID%" --data-urlencode "launchToken=%PEBBLE_AGENT_LAUNCH_TOKEN%" --data-urlencode "worktreeId=%PEBBLE_WORKTREE_ID%" --data-urlencode "env=%PEBBLE_AGENT_HOOK_ENV%" --data-urlencode "version=%PEBBLE_AGENT_HOOK_VERSION%" --data-urlencode "payload@-" >nul 2>&1
exit /b 0
"#
        .replace('\n', "\r\n");
    }
    r#"#!/bin/sh
if [ -n "$PEBBLE_AGENT_HOOK_ENDPOINT" ] && [ -r "$PEBBLE_AGENT_HOOK_ENDPOINT" ]; then . "$PEBBLE_AGENT_HOOK_ENDPOINT" 2>/dev/null || :; fi
if [ -z "$PEBBLE_AGENT_HOOK_PORT" ] || [ -z "$PEBBLE_AGENT_HOOK_TOKEN" ] || [ -z "$PEBBLE_PANE_KEY" ]; then exit 0; fi
payload=$(cat); if [ -z "$payload" ]; then exit 0; fi
printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:${PEBBLE_AGENT_HOOK_PORT}/hook/codex" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/x-www-form-urlencoded" -H "X-Pebble-Agent-Hook-Token: ${PEBBLE_AGENT_HOOK_TOKEN}" --data-urlencode "paneKey=${PEBBLE_PANE_KEY}" --data-urlencode "tabId=${PEBBLE_TAB_ID}" --data-urlencode "launchToken=${PEBBLE_AGENT_LAUNCH_TOKEN}" --data-urlencode "worktreeId=${PEBBLE_WORKTREE_ID}" --data-urlencode "env=${PEBBLE_AGENT_HOOK_ENV}" --data-urlencode "version=${PEBBLE_AGENT_HOOK_VERSION}" --data-urlencode "payload@-" >/dev/null 2>&1 || true
exit 0
"#
    .into()
}

fn trust_state(content: &str, key: &str, expected_hash: &str) -> (bool, bool) {
    let header = trust_header(key);
    let Some((start, end, _)) = table_ranges(content)
        .into_iter()
        .find(|(_, _, found)| *found == header)
    else {
        return (false, false);
    };
    let block = &content[start..end];
    (
        block.contains(&format!(
            "trusted_hash = \"{}\"",
            escape_toml(expected_hash)
        )),
        block.contains("enabled = false"),
    )
}

pub(super) fn status() -> AgentHookInstallStatus {
    let Some(path) = hooks_path() else {
        return error_status(
            &SETTINGS,
            String::new(),
            "Could not resolve Codex runtime home".into(),
        );
    };
    let path_text = path.display().to_string();
    let config = match read_hooks(&path) {
        Ok(value) => value,
        Err(detail) => return error_status(&SETTINGS, path_text, detail),
    };
    let expected = command();
    let toml = toml_path()
        .and_then(|path| fs::read_to_string(path).ok())
        .unwrap_or_default();
    let mut present = 0;
    let mut missing = Vec::new();
    let mut trust_missing = Vec::new();
    let mut disabled = Vec::new();
    for (event, label) in EVENTS {
        let definitions = config
            .get("hooks")
            .and_then(|hooks| hooks.get(*event))
            .and_then(Value::as_array);
        let found = definitions.and_then(|items| {
            items
                .iter()
                .enumerate()
                .rev()
                .find_map(|(group, definition)| {
                    definition
                        .get("hooks")?
                        .as_array()?
                        .iter()
                        .enumerate()
                        .rev()
                        .find_map(|(handler, hook)| {
                            (hook.get("command").and_then(Value::as_str) == expected.as_deref())
                                .then_some((group, handler))
                        })
                })
        });
        let Some((group, handler)) = found else {
            missing.push(*event);
            continue;
        };
        present += 1;
        let command = expected.as_deref().unwrap_or_default();
        let key = trust_key(&path, label, group, handler);
        let (trusted, is_disabled) = trust_state(&toml, &key, &trusted_hash(label, command));
        if !trusted {
            trust_missing.push(*event);
        } else if is_disabled {
            disabled.push(*event);
        }
    }
    let managed_hooks_present = present > 0;
    let (state, detail) = if present == 0 {
        (AgentHookInstallState::NotInstalled, None)
    } else if missing.is_empty() && trust_missing.is_empty() && disabled.is_empty() {
        (AgentHookInstallState::Installed, None)
    } else {
        let mut parts = Vec::new();
        if !missing.is_empty() {
            parts.push(format!(
                "Managed hook missing for events: {}",
                missing.join(", ")
            ));
        }
        if !trust_missing.is_empty() {
            parts.push(format!(
                "Trust entry missing or stale for events: {}",
                trust_missing.join(", ")
            ));
        }
        if !disabled.is_empty() {
            parts.push(format!(
                "Managed hook disabled for events: {}",
                disabled.join(", ")
            ));
        }
        (AgentHookInstallState::Partial, Some(parts.join("; ")))
    };
    AgentHookInstallStatus {
        agent: "codex",
        state,
        config_path: path_text,
        managed_hooks_present,
        detail,
    }
}

pub(super) fn apply(enabled: bool) -> AgentHookInstallStatus {
    let Some(path) = hooks_path() else {
        return error_status(
            &SETTINGS,
            String::new(),
            "Could not resolve Codex runtime home".into(),
        );
    };
    let result = (|| -> Result<(), String> {
        sync_system_resources()?;
        let mut config = read_hooks(&path)?;
        let root = config
            .as_object_mut()
            .ok_or("Codex hooks.json root must be an object")?;
        let mirrored = enabled.then(system_user_hooks).transpose()?.flatten();
        if let Some(mirrored) = mirrored {
            root.insert("hooks".into(), Value::Object(mirrored));
        }
        let hooks = root
            .entry("hooks")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or("Codex hooks must be an object")?;
        for definitions in hooks.values_mut() {
            if let Some(items) = definitions.as_array_mut() {
                *items = remove_managed(items);
            }
        }
        hooks.retain(|_, value| !value.as_array().is_some_and(Vec::is_empty));
        let command = command().ok_or("Could not resolve Codex managed command")?;
        if enabled {
            let script_path = script_path().ok_or("Could not resolve Codex script path")?;
            write_atomic(&script_path, script().as_bytes())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&script_path, fs::Permissions::from_mode(0o700))
                    .map_err(|error| error.to_string())?;
            }
            for (event, _) in EVENTS {
                let current = hooks
                    .entry(*event)
                    .or_insert_with(|| Value::Array(Vec::new()))
                    .as_array_mut()
                    .ok_or("Codex event hooks must be arrays")?;
                current.insert(0, json!({ "hooks": [{ "type": "command", "command": command, "timeout": TIMEOUT }] }));
            }
        }
        write_atomic(
            &path,
            &[
                serde_json::to_vec_pretty(&json!({ "hooks": hooks }))
                    .map_err(|error| error.to_string())?,
                b"\n".to_vec(),
            ]
            .concat(),
        )?;
        let toml_path = toml_path().ok_or("Could not resolve Codex config.toml")?;
        let mut toml = mirror_system_config(&toml_path)?;
        if enabled {
            let entries = EVENTS
                .iter()
                .map(|(_, label)| (trust_key(&path, label, 0, 0), trusted_hash(label, &command)))
                .collect::<Vec<_>>();
            let borrowed = entries
                .iter()
                .map(|(key, hash)| (key.as_str(), hash.clone()))
                .collect::<Vec<_>>();
            toml = upsert_trust(toml, &borrowed);
        } else {
            toml = remove_managed_trust(toml, &path, &command);
        }
        write_atomic(&toml_path, toml.as_bytes())
    })();
    match result {
        Ok(()) => status(),
        Err(detail) => error_status(&SETTINGS, path.display().to_string(), detail),
    }
}
