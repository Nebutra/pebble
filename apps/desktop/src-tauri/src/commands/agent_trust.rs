use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use uuid::Uuid;

const MAX_WORKSPACE_PATH_BYTES: usize = 32 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTrustInput {
    preset: String,
    workspace_path: String,
    connection_id: Option<String>,
}

#[tauri::command]
pub fn agent_trust_mark_trusted(
    app: tauri::AppHandle,
    input: AgentTrustInput,
) -> Result<(), String> {
    validate_input(&input)?;
    if input
        .connection_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Err("Remote agent trust requires the paired runtime.".to_string());
    }
    let workspace = fs::canonicalize(&input.workspace_path)
        .unwrap_or_else(|_| PathBuf::from(&input.workspace_path));
    let home = user_home().ok_or("Could not resolve the user home directory.")?;
    match input.preset.as_str() {
        "cursor" => mark_cursor(&home, &workspace),
        "copilot" => mark_copilot(&home, &workspace),
        "codex" => {
            mark_codex(&home.join(".codex").join("config.toml"), &workspace)?;
            let managed = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("Could not resolve Pebble app data: {error}"))?
                .join("codex-runtime-home")
                .join("home")
                .join("config.toml");
            mark_codex(&managed, &workspace)
        }
        _ => Err("Unsupported agent trust preset.".to_string()),
    }
}

fn validate_input(input: &AgentTrustInput) -> Result<(), String> {
    if input.workspace_path.is_empty()
        || input.workspace_path.len() > MAX_WORKSPACE_PATH_BYTES
        || input.workspace_path.contains('\0')
        || input.workspace_path.contains('\r')
        || input.workspace_path.contains('\n')
    {
        return Err("Invalid agent trust workspace path.".to_string());
    }
    Ok(())
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn mark_cursor(home: &Path, workspace: &Path) -> Result<(), String> {
    let path = workspace.to_string_lossy();
    let slug = path
        .trim_start_matches(['/', '\\'])
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "-");
    if slug.is_empty() {
        return Ok(());
    }
    let target = home
        .join(".cursor")
        .join("projects")
        .join(slug)
        .join(".workspace-trusted");
    if target.exists() {
        return Ok(());
    }
    let payload = serde_json::json!({
        "trustedAt": chrono::Utc::now().to_rfc3339(),
        "workspacePath": path.as_ref(),
    });
    atomic_write(
        &target,
        format!("{}\n", serde_json::to_string_pretty(&payload).unwrap()).as_bytes(),
    )
}

fn mark_copilot(home: &Path, workspace: &Path) -> Result<(), String> {
    let target = home.join(".copilot").join("config.json");
    let mut config = if target.exists() {
        let bytes =
            fs::read(&target).map_err(|error| format!("Could not read Copilot config: {error}"))?;
        serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "Copilot config.json is invalid; refusing to overwrite it.".to_string())?
    } else {
        Value::Object(Map::new())
    };
    let object = config
        .as_object_mut()
        .ok_or("Copilot config.json root must be an object.")?;
    let workspace = workspace.to_string_lossy().to_string();
    let folders = object
        .entry("trustedFolders")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or("Copilot trustedFolders must be an array.")?;
    if folders
        .iter()
        .any(|entry| entry.as_str() == Some(&workspace))
    {
        return Ok(());
    }
    folders.push(Value::String(workspace));
    atomic_write(
        &target,
        format!("{}\n", serde_json::to_string_pretty(&config).unwrap()).as_bytes(),
    )
}

fn mark_codex(target: &Path, workspace: &Path) -> Result<(), String> {
    let existing = fs::read_to_string(target).unwrap_or_default();
    let workspace = workspace.to_string_lossy();
    let escaped = escape_toml(&workspace);
    let header = format!("[projects.\"{escaped}\"]");
    let header_pattern = Regex::new(&format!(
        r#"(?m)^[ \t]*\[projects[ \t]*\.[ \t]*\"{}\"[ \t]*\][ \t]*(?:#.*)?$"#,
        regex::escape(&escaped)
    ))
    .map_err(|error| error.to_string())?;
    let updated = if let Some(found) = header_pattern.find(&existing) {
        upsert_codex_trust_line(&existing, found.end())
    } else {
        let separator = if existing.is_empty() {
            ""
        } else if existing.ends_with("\n\n") {
            ""
        } else if existing.ends_with('\n') {
            "\n"
        } else {
            "\n\n"
        };
        format!("{existing}{separator}{header}\ntrust_level = \"trusted\"\n")
    };
    if updated == existing {
        return Ok(());
    }
    atomic_write(target, updated.as_bytes())
}

fn upsert_codex_trust_line(content: &str, header_end: usize) -> String {
    let remainder = &content[header_end..];
    let block_end = remainder
        .find("\n[")
        .map(|offset| header_end + offset + 1)
        .unwrap_or(content.len());
    let block = &content[header_end..block_end];
    let trust_pattern = Regex::new(
        r#"(?m)^[ \t]*trust_level[ \t]*=[ \t]*(?:\"(?:trusted|untrusted)\"|'(?:trusted|untrusted)')[ \t]*(?:#.*)?$"#,
    )
    .unwrap();
    if trust_pattern.is_match(block) {
        format!(
            "{}{}{}",
            &content[..header_end],
            trust_pattern.replace(block, "trust_level = \"trusted\""),
            &content[block_end..]
        )
    } else {
        format!(
            "{}\ntrust_level = \"trusted\"{}",
            &content[..header_end],
            &content[header_end..]
        )
    }
}

fn escape_toml(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or("Trust target has no parent directory.")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create trust directory: {error}"))?;
    let temporary = parent.join(format!(".agent-trust-{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, bytes).map_err(|error| format!("Could not write trust file: {error}"))?;
    let result = replace_file(&temporary, target);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|error| format!("Could not replace trust file: {error}"))
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    let backup = target.with_extension("agent-trust.bak");
    if target.exists() {
        fs::copy(target, &backup)
            .map_err(|error| format!("Could not back up trust file: {error}"))?;
        fs::remove_file(target)
            .map_err(|error| format!("Could not prepare trust file: {error}"))?;
    }
    if let Err(error) = fs::rename(source, target) {
        if backup.exists() {
            let _ = fs::rename(&backup, target);
        }
        return Err(format!("Could not replace trust file: {error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_upsert_preserves_other_tables() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config.toml");
        fs::write(
            &config,
            "model = \"gpt-5\"\n\n[projects.\"/tmp/demo\"]\ntrust_level = \"untrusted\"\n\n[other]\nvalue = true\n",
        )
        .unwrap();
        mark_codex(&config, Path::new("/tmp/demo")).unwrap();
        let result = fs::read_to_string(config).unwrap();
        assert!(result.contains("trust_level = \"trusted\""));
        assert!(result.contains("[other]\nvalue = true"));
    }

    #[test]
    fn copilot_keeps_unrelated_config() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        fs::create_dir(home.join(".copilot")).unwrap();
        fs::write(home.join(".copilot/config.json"), "{\"theme\":\"dark\"}").unwrap();
        mark_copilot(home, Path::new("/tmp/demo")).unwrap();
        let result: Value =
            serde_json::from_slice(&fs::read(home.join(".copilot/config.json")).unwrap()).unwrap();
        assert_eq!(result["theme"], "dark");
        assert_eq!(result["trustedFolders"][0], "/tmp/demo");
    }
}
