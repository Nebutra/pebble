use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesRunsInput {
    job_id: String,
    page: usize,
    page_size: usize,
}

#[derive(Debug, Serialize)]
pub struct HermesRunsPage {
    total: usize,
    runs: Vec<Value>,
}

#[derive(Clone)]
struct RunRef {
    id: String,
    run_at: Option<String>,
    run_key: Option<String>,
    output_path: Option<PathBuf>,
    session_id: Option<String>,
}

#[tauri::command]
pub async fn external_automations_list_local_runs(
    input: HermesRunsInput,
) -> Result<HermesRunsPage, String> {
    tauri::async_runtime::spawn_blocking(move || read_runs_page(input))
        .await
        .map_err(|_| "Hermes history reader failed.".to_string())?
}

fn read_runs_page(input: HermesRunsInput) -> Result<HermesRunsPage, String> {
    validate_job_id(&input.job_id)?;
    let home = hermes_home();
    let mut refs = output_refs(&home, &input.job_id)?;
    merge_session_refs(&mut refs, session_refs(&home, &input.job_id));
    refs.sort_by(|left, right| right.run_at.cmp(&left.run_at).then(right.id.cmp(&left.id)));

    let total = refs.len();
    let page = input.page.max(1);
    let page_size = input.page_size.clamp(1, 100);
    let start = page.saturating_sub(1).saturating_mul(page_size);
    let runs = refs
        .into_iter()
        .skip(start)
        .take(page_size)
        .map(|run_ref| hydrate_run(&home, &input.job_id, run_ref))
        .collect();
    Ok(HermesRunsPage { total, runs })
}

pub(crate) fn count_local_runs(job_id: &str) -> usize {
    if validate_job_id(job_id).is_err() {
        return 0;
    }
    let home = hermes_home();
    let Ok(mut refs) = output_refs(&home, job_id) else {
        return 0;
    };
    merge_session_refs(&mut refs, session_refs(&home, job_id));
    refs.len()
}

fn output_refs(home: &Path, job_id: &str) -> Result<Vec<RunRef>, String> {
    let directory = home.join("cron").join("output").join(job_id);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let pattern = Regex::new(r"^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.md$")
        .expect("static Hermes output regex");
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    Ok(entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let captures = pattern.captures(&name)?;
            let values = (1..=6)
                .map(|index| captures.get(index).map(|value| value.as_str()))
                .collect::<Option<Vec<_>>>()?;
            Some(RunRef {
                id: format!("{job_id}:{name}"),
                run_at: Some(format!(
                    "{}-{}-{}T{}:{}:{}",
                    values[0], values[1], values[2], values[3], values[4], values[5]
                )),
                run_key: Some(format!(
                    "{}{}{}_{}{}{}",
                    values[0], values[1], values[2], values[3], values[4], values[5]
                )),
                output_path: Some(entry.path()),
                session_id: None,
            })
        })
        .collect())
}

fn session_refs(home: &Path, job_id: &str) -> Vec<RunRef> {
    let path = home.join("state.db");
    let Ok(connection) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return Vec::new();
    };
    let escaped = job_id
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let Ok(mut statement) = connection.prepare(
        "SELECT id, started_at FROM sessions WHERE id LIKE ?1 ESCAPE '\\' ORDER BY started_at DESC",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([format!("cron\\_{escaped}\\_%")], |row| {
        let id: String = row.get(0)?;
        let started_at: Option<f64> = row.get(1)?;
        Ok((id, started_at))
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .map(|(id, started_at)| RunRef {
            run_key: id
                .strip_prefix(&format!("cron_{job_id}_"))
                .map(str::to_string),
            run_at: started_at.and_then(unix_seconds_to_iso),
            session_id: Some(id.clone()),
            id,
            output_path: None,
        })
        .collect()
}

fn merge_session_refs(output: &mut Vec<RunRef>, sessions: Vec<RunRef>) {
    for session in sessions {
        let exact = output
            .iter()
            .position(|candidate| candidate.run_key == session.run_key);
        let nearest = exact.or_else(|| nearest_output_index(output, &session));
        if let Some(existing) = nearest.and_then(|index| output.get_mut(index)) {
            existing.session_id = session.session_id;
        } else {
            output.push(session);
        }
    }
}

fn nearest_output_index(output: &[RunRef], session: &RunRef) -> Option<usize> {
    let session_time = run_key_seconds(session.run_key.as_deref()?)?;
    output
        .iter()
        .enumerate()
        .filter_map(|(index, candidate)| {
            let output_time = run_key_seconds(candidate.run_key.as_deref()?)?;
            let gap = output_time.checked_sub(session_time)?;
            (gap <= 24 * 60 * 60).then_some((index, gap))
        })
        .min_by_key(|(_, gap)| *gap)
        .map(|(index, _)| index)
}

fn run_key_seconds(value: &str) -> Option<i64> {
    let compact = value.replace('_', "");
    if compact.len() != 14 || !compact.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let description = time::macros::format_description!("[year][month][day][hour][minute][second]");
    time::PrimitiveDateTime::parse(&compact, description)
        .ok()?
        .assume_utc()
        .unix_timestamp()
        .into()
}

fn hydrate_run(home: &Path, job_id: &str, run_ref: RunRef) -> Value {
    let mut output = run_ref
        .output_path
        .as_ref()
        .and_then(|path| read_output(path, job_id, &run_ref));
    let session = run_ref
        .session_id
        .as_deref()
        .and_then(|id| read_session(home, job_id, id));
    match (&mut output, session) {
        (Some(Value::Object(record)), Some(Value::Object(session))) => {
            if record.get("output_preview").is_none_or(Value::is_null) {
                record.insert("output_preview".into(), session["output_preview"].clone());
            }
            let transcript = session.get("output_content").and_then(Value::as_str);
            if let Some(transcript) = transcript {
                let current = record
                    .get("output_content")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                record.insert(
                    "output_content".into(),
                    Value::String(format!(
                        "{current}\n\n---\n\n## Full session log\n\n{transcript}"
                    )),
                );
            }
            output.unwrap_or(Value::Object(session))
        }
        (Some(output), _) => output.clone(),
        (_, Some(session)) => session,
        _ => json!({"id": run_ref.id, "job_id": job_id, "run_at": run_ref.run_at}),
    }
}

fn read_output(path: &Path, job_id: &str, run_ref: &RunRef) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    let error = markdown_section(&content, "## Error");
    let response = markdown_section(&content, "## Response");
    let failed = error.is_some()
        || content.lines().any(|line| {
            line.starts_with('#') && line.contains("Cron Job:") && line.contains("(FAILED)")
        });
    let preview = response.as_deref().or(error.as_deref()).map(preview_text);
    Some(json!({
        "id": run_ref.id,
        "job_id": job_id,
        "run_at": run_ref.run_at,
        "run_key": run_ref.run_key,
        "status": if failed { "failed" } else if response.is_some() { "completed" } else { "unknown" },
        "output_preview": preview,
        "output_content": content,
        "error": error.map(|value| preview_text(&value)),
        "output_path": path,
    }))
}

fn read_session(home: &Path, job_id: &str, session_id: &str) -> Option<Value> {
    let connection =
        Connection::open_with_flags(home.join("state.db"), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    let (started_at, ended_at, title, model): (
        Option<f64>,
        Option<f64>,
        Option<String>,
        Option<String>,
    ) = connection
        .query_row(
            "SELECT started_at, ended_at, title, model FROM sessions WHERE id = ?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok()?;
    let mut statement = connection.prepare("SELECT role, content, tool_name, reasoning, reasoning_content FROM messages WHERE session_id = ?1 ORDER BY timestamp, id").ok()?;
    let messages = statement
        .query_map([session_id], |row| {
            let role: Option<String> = row.get(0)?;
            let content: Option<String> = row.get(1)?;
            let tool: Option<String> = row.get(2)?;
            let reasoning: Option<String> = row.get::<_, Option<String>>(4)?.or(row.get(3)?);
            Ok(format!(
                "## {}{}\n\n{}{}",
                role.unwrap_or_else(|| "message".into()),
                tool.map(|value| format!(" / {value}")).unwrap_or_default(),
                reasoning
                    .map(|value| format!("### Reasoning\n\n{value}\n\n"))
                    .unwrap_or_default(),
                content.unwrap_or_else(|| "(empty)".into())
            ))
        })
        .ok()?
        .filter_map(Result::ok)
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    let preview = [title, model.map(|value| format!("Model: {value}"))]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
    Some(
        json!({"id": session_id, "job_id": job_id, "run_at": started_at.and_then(unix_seconds_to_iso), "status": if ended_at.is_some() {"completed"} else {"unknown"}, "output_preview": if preview.is_empty() {None} else {Some(preview)}, "output_content": if messages.is_empty() {None} else {Some(messages)}, "error": null, "output_path": home.join("state.db")}),
    )
}

fn markdown_section(content: &str, heading: &str) -> Option<String> {
    let start = content.find(heading)? + heading.len();
    let body = content[start..].trim_start_matches(['\r', '\n', ' ', '\t']);
    let end = body.find("\n## ").unwrap_or(body.len());
    Some(body[..end].trim().trim_matches('`').trim().to_string()).filter(|value| !value.is_empty())
}

fn preview_text(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= 180 {
        compact
    } else {
        format!("{}...", compact.chars().take(177).collect::<String>())
    }
}

fn unix_seconds_to_iso(value: f64) -> Option<String> {
    time::OffsetDateTime::from_unix_timestamp(value as i64)
        .ok()
        .and_then(|date| {
            date.format(&time::format_description::well_known::Iso8601::DEFAULT)
                .ok()
        })
}

fn hermes_home() -> PathBuf {
    env::var_os("HERMES_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::var_os("HOME")
                .or_else(|| env::var_os("USERPROFILE"))
                .map(PathBuf::from)
                .unwrap_or_default()
                .join(".hermes")
        })
}

fn validate_job_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err("Invalid external automation job ID.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn reads_and_pages_markdown_runs_newest_first() {
        let directory = tempdir().expect("tempdir");
        let output = directory.path().join("cron/output/job-1");
        fs::create_dir_all(&output).expect("output directory");
        fs::write(
            output.join("2026-05-14_09-00-00.md"),
            "# Cron Job: Daily\n\n## Response\n\nFinished the newest run.",
        )
        .expect("new output");
        fs::write(
            output.join("2026-05-13_09-00-00.md"),
            "# Cron Job: Daily (FAILED)\n\n## Error\n\n```text\ncommand failed\n```",
        )
        .expect("old output");

        let mut refs = output_refs(directory.path(), "job-1").expect("refs");
        refs.sort_by(|left, right| right.run_at.cmp(&left.run_at));
        let newest = hydrate_run(directory.path(), "job-1", refs.remove(0));
        let oldest = hydrate_run(directory.path(), "job-1", refs.remove(0));

        assert_eq!(newest["status"], "completed");
        assert_eq!(newest["output_preview"], "Finished the newest run.");
        assert_eq!(oldest["status"], "failed");
        assert_eq!(oldest["error"], "text command failed");
    }

    #[test]
    fn rejects_paths_disguised_as_job_ids() {
        assert!(validate_job_id("job-1:nightly").is_ok());
        assert!(validate_job_id("../state.db").is_err());
        assert!(validate_job_id("job/child").is_err());
    }

    #[test]
    fn merges_the_nearest_preceding_session_within_one_day() {
        let mut outputs = vec![RunRef {
            id: "output".into(),
            run_at: None,
            run_key: Some("20260514_090010".into()),
            output_path: Some(PathBuf::from("run.md")),
            session_id: None,
        }];
        let sessions = vec![RunRef {
            id: "cron_job-1_20260514_090000".into(),
            run_at: None,
            run_key: Some("20260514_090000".into()),
            output_path: None,
            session_id: Some("cron_job-1_20260514_090000".into()),
        }];

        merge_session_refs(&mut outputs, sessions);

        assert_eq!(outputs.len(), 1);
        assert_eq!(
            outputs[0].session_id.as_deref(),
            Some("cron_job-1_20260514_090000")
        );
    }
}
