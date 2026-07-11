use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::hermes_automation_history::count_local_runs;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalExternalAutomationSource {
    provider: String,
    command_available: bool,
    jobs: Value,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAutomationMutationInput {
    provider: String,
    operation: String,
    job_id: Option<String>,
    action: Option<String>,
    name: Option<String>,
    prompt: Option<String>,
    schedule: Option<String>,
    workdir: Option<String>,
}

#[tauri::command]
pub async fn external_automations_list_local() -> Vec<LocalExternalAutomationSource> {
    tauri::async_runtime::spawn_blocking(|| vec![read_source("hermes"), read_source("openclaw")])
        .await
        .unwrap_or_else(|_| {
            vec![LocalExternalAutomationSource {
                provider: "hermes".to_string(),
                command_available: false,
                jobs: Value::Array(Vec::new()),
                error: Some("External automation reader failed.".to_string()),
            }]
        })
}

#[tauri::command]
pub async fn external_automations_mutate_local(
    input: ExternalAutomationMutationInput,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || mutate_local(input))
        .await
        .map_err(|_| "External automation command worker failed.".to_string())?
}

fn read_source(provider: &str) -> LocalExternalAutomationSource {
    let command_available = resolve_command(provider).is_some();
    let path = jobs_path(provider);
    match read_jobs(&path, provider) {
        Ok(jobs) => LocalExternalAutomationSource {
            provider: provider.to_string(),
            command_available,
            jobs: if provider == "hermes" {
                attach_hermes_run_counts(jobs)
            } else {
                jobs
            },
            error: None,
        },
        Err(error) => LocalExternalAutomationSource {
            provider: provider.to_string(),
            command_available,
            jobs: Value::Array(Vec::new()),
            error: Some(error),
        },
    }
}

fn attach_hermes_run_counts(jobs: Value) -> Value {
    let Value::Array(jobs) = jobs else {
        return Value::Array(Vec::new());
    };
    Value::Array(
        jobs.into_iter()
            .map(|mut job| {
                if let Some(record) = job.as_object_mut() {
                    let count = record
                        .get("id")
                        .and_then(Value::as_str)
                        .map(count_local_runs)
                        .unwrap_or_default();
                    record.insert("run_count".into(), Value::from(count));
                    // Why: history is paged separately so manager discovery never hydrates large logs.
                    record.insert("runs".into(), Value::Array(Vec::new()));
                }
                job
            })
            .collect(),
    )
}

fn read_jobs(path: &Path, provider: &str) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Array(Vec::new()));
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let parsed: Value = serde_json::from_str(&content).map_err(|error| error.to_string())?;
    if provider == "hermes" {
        return Ok(match parsed {
            Value::Array(_) => parsed,
            Value::Object(ref object) if object.get("jobs").is_some_and(Value::is_array) => {
                object["jobs"].clone()
            }
            _ => Value::Array(Vec::new()),
        });
    }
    Ok(parsed)
}

fn mutate_local(input: ExternalAutomationMutationInput) -> Result<(), String> {
    if input.provider != "hermes" && input.provider != "openclaw" {
        return Err("Unsupported external automation provider.".to_string());
    }
    let command = resolve_command(&input.provider)
        .ok_or_else(|| format!("{} CLI is not on PATH.", provider_label(&input.provider)))?;
    let args = mutation_args(&input)?;
    run_bounded_command(&command, &args)
}

fn mutation_args(input: &ExternalAutomationMutationInput) -> Result<Vec<String>, String> {
    match input.operation.as_str() {
        "create" => {
            if input.provider != "hermes" {
                return Err("Only Hermes cron creation and editing are supported.".to_string());
            }
            let name = required_text(input.name.as_deref(), "Hermes cron requires a name.")?;
            let prompt = required_text(input.prompt.as_deref(), "Hermes cron requires a prompt.")?;
            let schedule = required_text(
                input.schedule.as_deref(),
                "Hermes cron requires a schedule.",
            )?;
            let mut args = vec![
                "cron".into(),
                "create".into(),
                schedule,
                prompt,
                "--name".into(),
                name,
                "--deliver".into(),
                "local".into(),
            ];
            append_workdir(&mut args, input.workdir.as_deref());
            Ok(args)
        }
        "update" => {
            if input.provider != "hermes" {
                return Err("Only Hermes cron creation and editing are supported.".to_string());
            }
            let job_id = valid_job_id(input.job_id.as_deref())?;
            let name = required_text(input.name.as_deref(), "Hermes cron requires a name.")?;
            let prompt = required_text(input.prompt.as_deref(), "Hermes cron requires a prompt.")?;
            let schedule = required_text(
                input.schedule.as_deref(),
                "Hermes cron requires a schedule.",
            )?;
            let mut args = vec![
                "cron".into(),
                "edit".into(),
                job_id,
                "--schedule".into(),
                schedule,
                "--prompt".into(),
                prompt,
                "--name".into(),
                name,
            ];
            append_workdir(&mut args, input.workdir.as_deref());
            Ok(args)
        }
        "action" => {
            let job_id = valid_job_id(input.job_id.as_deref())?;
            let action = input.action.as_deref().unwrap_or_default();
            let command = match (input.provider.as_str(), action) {
                ("hermes", "pause") => "pause",
                ("hermes", "resume") => "resume",
                ("hermes", "run") => "run",
                ("hermes", "delete") => "remove",
                ("openclaw", "pause") => "disable",
                ("openclaw", "resume") => "enable",
                ("openclaw", "run") => "run",
                ("openclaw", "delete") => "rm",
                _ => return Err("Invalid external automation action.".to_string()),
            };
            Ok(vec!["cron".into(), command.into(), job_id])
        }
        _ => Err("Invalid external automation operation.".to_string()),
    }
}

fn run_bounded_command(command: &Path, args: &[String]) -> Result<(), String> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            if status.success() {
                return Ok(());
            }
            let output = child
                .wait_with_output()
                .map_err(|error| error.to_string())?;
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                format!("External automation command exited with {status}.")
            } else {
                detail
            });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("External automation command timed out after 30000ms.".to_string());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn resolve_command(command: &str) -> Option<PathBuf> {
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            let candidate = directory.join(executable_name(command));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    resolve_command_from_login_shell(command)
}

#[cfg(not(windows))]
fn resolve_command_from_login_shell(command: &str) -> Option<PathBuf> {
    let shell = env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/sh"));
    let output = Command::new(shell)
        .args(["-lc", &format!("command -v {command}")])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    path.is_file().then_some(path)
}

#[cfg(windows)]
fn resolve_command_from_login_shell(command: &str) -> Option<PathBuf> {
    let output = Command::new("where.exe").arg(command).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

fn jobs_path(provider: &str) -> PathBuf {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    if provider == "hermes" {
        let root = env::var_os("HERMES_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".hermes"));
        return root.join("cron").join("jobs.json");
    }
    home.join(".openclaw").join("cron").join("jobs.json")
}

fn valid_job_id(value: Option<&str>) -> Result<String, String> {
    let value = value.unwrap_or_default().trim();
    if value.is_empty()
        || value.len() > 200
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err("Invalid external automation job ID.".to_string());
    }
    Ok(value.to_string())
}

fn required_text(value: Option<&str>, error: &str) -> Result<String, String> {
    let value = value.unwrap_or_default().trim();
    if value.is_empty() {
        return Err(error.to_string());
    }
    Ok(value.to_string())
}

fn append_workdir(args: &mut Vec<String>, value: Option<&str>) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        args.extend(["--workdir".to_string(), value.to_string()]);
    }
}

fn executable_name(command: &str) -> String {
    if cfg!(windows) {
        format!("{command}.exe")
    } else {
        command.to_string()
    }
}

fn provider_label(provider: &str) -> &str {
    if provider == "hermes" {
        "Hermes"
    } else {
        "OpenClaw"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(operation: &str) -> ExternalAutomationMutationInput {
        ExternalAutomationMutationInput {
            provider: "hermes".to_string(),
            operation: operation.to_string(),
            job_id: Some("job-1".to_string()),
            action: None,
            name: Some("Daily review".to_string()),
            prompt: Some("Summarize changes".to_string()),
            schedule: Some("0 9 * * *".to_string()),
            workdir: Some("/workspace/pebble".to_string()),
        }
    }

    #[test]
    fn builds_source_faithful_hermes_create_and_edit_arguments() {
        assert_eq!(
            mutation_args(&input("create")).unwrap(),
            [
                "cron",
                "create",
                "0 9 * * *",
                "Summarize changes",
                "--name",
                "Daily review",
                "--deliver",
                "local",
                "--workdir",
                "/workspace/pebble",
            ]
        );
        assert_eq!(
            mutation_args(&input("update")).unwrap(),
            [
                "cron",
                "edit",
                "job-1",
                "--schedule",
                "0 9 * * *",
                "--prompt",
                "Summarize changes",
                "--name",
                "Daily review",
                "--workdir",
                "/workspace/pebble",
            ]
        );
    }

    #[test]
    fn maps_openclaw_actions_and_rejects_unsafe_job_ids() {
        let mut action = input("action");
        action.provider = "openclaw".to_string();
        action.action = Some("delete".to_string());
        assert_eq!(mutation_args(&action).unwrap(), ["cron", "rm", "job-1"]);
        action.job_id = Some("../../escape".to_string());
        assert_eq!(
            mutation_args(&action).unwrap_err(),
            "Invalid external automation job ID."
        );
    }

    #[test]
    fn reads_hermes_array_or_wrapped_jobs_without_changing_records() {
        let directory = env::temp_dir().join(format!(
            "pebble-external-automation-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("jobs.json");
        fs::write(&path, r#"{"jobs":[{"id":"job-1","enabled":true}]}"#).unwrap();
        let jobs = read_jobs(&path, "hermes").unwrap();
        assert_eq!(jobs[0]["id"], "job-1");
        fs::write(&path, r#"[{"id":"job-2"}]"#).unwrap();
        let jobs = read_jobs(&path, "hermes").unwrap();
        assert_eq!(jobs[0]["id"], "job-2");
        let _ = fs::remove_dir_all(directory);
    }
}
