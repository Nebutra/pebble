use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const GENERATION_POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_GIT_CONTEXT_BYTES: usize = 10 * 1024 * 1024;

#[derive(Default)]
pub struct SourceControlTextGenerationState {
    canceled_lanes: Arc<Mutex<HashSet<String>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlCommitContextInput {
    pub cwd: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlCommitContextResult {
    pub branch: Option<String>,
    pub staged_summary: String,
    pub staged_patch: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlPullRequestContextInput {
    pub cwd: String,
    pub base: String,
    pub current_title: String,
    pub current_body: String,
    pub current_draft: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlPullRequestContextResult {
    pub branch: Option<String>,
    pub base: String,
    pub branch_changed_by_preparation: bool,
    pub current_title: String,
    pub current_body: String,
    pub current_draft: bool,
    pub commit_summary: String,
    pub change_summary: String,
    pub patch: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlGenerationPlanInput {
    pub lane_key: String,
    pub cwd: String,
    pub binary: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub stdin_payload: Option<String>,
    #[serde(default = "default_generation_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlGenerationPlanResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub canceled: bool,
    pub spawn_error: Option<String>,
}

#[tauri::command]
pub async fn source_control_text_generation_commit_context(
    input: SourceControlCommitContextInput,
) -> Result<SourceControlCommitContextResult, String> {
    tauri::async_runtime::spawn_blocking(move || read_commit_context_blocking(&input.cwd))
        .await
        .map_err(|_| "commit context task panicked".to_string())?
}

#[tauri::command]
pub async fn source_control_text_generation_pull_request_context(
    input: SourceControlPullRequestContextInput,
) -> Result<Option<SourceControlPullRequestContextResult>, String> {
    tauri::async_runtime::spawn_blocking(move || read_pull_request_context_blocking(input))
        .await
        .map_err(|_| "pull request context task panicked".to_string())?
}

#[tauri::command]
pub async fn source_control_text_generation_execute_plan(
    input: SourceControlGenerationPlanInput,
    state: State<'_, SourceControlTextGenerationState>,
) -> Result<SourceControlGenerationPlanResult, String> {
    let canceled_lanes = state.canceled_lanes.clone();
    clear_canceled_lane(&canceled_lanes, &input.lane_key)?;
    tauri::async_runtime::spawn_blocking(move || execute_plan_blocking(input, canceled_lanes))
        .await
        .map_err(|_| "text-generation task panicked".to_string())?
}

#[tauri::command]
pub fn source_control_text_generation_cancel(
    lane_key: String,
    state: State<'_, SourceControlTextGenerationState>,
) -> Result<(), String> {
    let mut lanes = state
        .canceled_lanes
        .lock()
        .map_err(|_| "text-generation cancel state lock is poisoned".to_string())?;
    lanes.insert(lane_key);
    Ok(())
}

fn read_commit_context_blocking(cwd: &str) -> Result<SourceControlCommitContextResult, String> {
    validate_cwd(cwd)?;
    let branch = run_git_capture(cwd, &["branch", "--show-current"], MAX_GIT_CONTEXT_BYTES)
        .unwrap_or_default();
    let staged_summary = run_git_capture(
        cwd,
        &["diff", "--cached", "--name-status", "--"],
        256 * 1024,
    )?;
    let staged_patch = run_git_capture(
        cwd,
        &[
            "diff",
            "--cached",
            "--patch",
            "--minimal",
            "--no-color",
            "--no-ext-diff",
            "--",
        ],
        MAX_GIT_CONTEXT_BYTES,
    )?;
    Ok(SourceControlCommitContextResult {
        branch: normalize_optional_text(&branch),
        staged_summary,
        staged_patch,
    })
}

fn read_pull_request_context_blocking(
    input: SourceControlPullRequestContextInput,
) -> Result<Option<SourceControlPullRequestContextResult>, String> {
    validate_cwd(&input.cwd)?;
    let base = input.base.trim().to_string();
    if base.is_empty() || base.starts_with('-') {
        return Ok(None);
    }

    let remote_state = read_remote_state(&input.cwd)?;
    let (comparison_base, fetch_target) = resolve_comparison_base(&base, &remote_state);
    if let Some(target) = fetch_target {
        let refspec = format!(
            "+refs/heads/{}:refs/remotes/{}/{}",
            target.branch, target.remote, target.branch
        );
        run_git_capture(
            &input.cwd,
            &[
                "fetch",
                "--no-tags",
                target.remote.as_str(),
                refspec.as_str(),
            ],
            256 * 1024,
        )?;
    }

    let branch =
        run_git_capture(&input.cwd, &["branch", "--show-current"], 256 * 1024).unwrap_or_default();
    let merge_base = run_git_capture(
        &input.cwd,
        &["merge-base", comparison_base.as_str(), "HEAD"],
        256 * 1024,
    )
    .unwrap_or_default();
    let merge_base = merge_base.trim().to_string();
    if merge_base.is_empty() {
        return Ok(None);
    }
    let range = format!("{merge_base}..HEAD");
    let commit_summary = run_git_capture(
        &input.cwd,
        &[
            "log",
            "--pretty=format:- %s",
            "--max-count=50",
            range.as_str(),
        ],
        MAX_GIT_CONTEXT_BYTES,
    )
    .unwrap_or_default();
    let change_summary = run_git_capture(
        &input.cwd,
        &["diff", "--name-status", range.as_str()],
        MAX_GIT_CONTEXT_BYTES,
    )
    .unwrap_or_default();
    let patch = run_git_capture(
        &input.cwd,
        &[
            "diff",
            "--patch",
            "--minimal",
            "--no-color",
            "--no-ext-diff",
            range.as_str(),
        ],
        MAX_GIT_CONTEXT_BYTES,
    )
    .unwrap_or_default();

    if commit_summary.trim().is_empty()
        && change_summary.trim().is_empty()
        && patch.trim().is_empty()
    {
        return Ok(None);
    }

    Ok(Some(SourceControlPullRequestContextResult {
        branch: normalize_optional_text(&branch),
        base,
        branch_changed_by_preparation: false,
        current_title: input.current_title,
        current_body: input.current_body,
        current_draft: input.current_draft,
        commit_summary,
        change_summary,
        patch,
    }))
}

#[derive(Debug, Clone)]
struct RemoteState {
    remotes: Vec<String>,
    refs: Vec<String>,
}

#[derive(Debug, Clone)]
struct RemoteBranch {
    remote: String,
    branch: String,
    reference: String,
}

fn read_remote_state(cwd: &str) -> Result<RemoteState, String> {
    let remotes =
        split_git_lines(&run_git_capture(cwd, &["remote"], 256 * 1024).unwrap_or_default());
    let refs = split_git_lines(
        &run_git_capture(
            cwd,
            &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
            512 * 1024,
        )
        .unwrap_or_default(),
    )
    .into_iter()
    .filter(|line| !line.ends_with("/HEAD"))
    .collect();
    Ok(RemoteState { remotes, refs })
}

fn resolve_comparison_base(base: &str, state: &RemoteState) -> (String, Option<RemoteBranch>) {
    if let Some(qualified) = parse_remote_branch(base, &state.remotes) {
        return (qualified.reference.clone(), Some(qualified));
    }
    if state.refs.iter().any(|reference| reference == base) {
        return (base.to_string(), parse_remote_ref(base, &state.remotes));
    }

    for reference in [format!("origin/{base}"), format!("upstream/{base}")] {
        let parsed = parse_remote_ref(&reference, &state.remotes);
        if parsed.as_ref().is_some_and(|branch| {
            state.refs.contains(&reference) || state.remotes.contains(&branch.remote)
        }) {
            return (reference, parsed);
        }
    }

    let matching_refs: Vec<&String> = state
        .refs
        .iter()
        .filter(|reference| reference.ends_with(&format!("/{base}")))
        .collect();
    if matching_refs.len() == 1 {
        let reference = matching_refs[0].clone();
        return (
            reference.clone(),
            parse_remote_ref(&reference, &state.remotes),
        );
    }

    (base.to_string(), None)
}

fn parse_remote_branch(reference: &str, remotes: &[String]) -> Option<RemoteBranch> {
    let mut sorted = remotes.to_vec();
    sorted.sort_by_key(|remote| std::cmp::Reverse(remote.len()));
    for remote in sorted {
        let prefix = format!("{remote}/");
        if reference.starts_with(&prefix) {
            let branch = reference[prefix.len()..].to_string();
            if branch.is_empty() {
                return None;
            }
            return Some(RemoteBranch {
                remote,
                branch,
                reference: reference.to_string(),
            });
        }
    }
    None
}

fn parse_remote_ref(reference: &str, remotes: &[String]) -> Option<RemoteBranch> {
    if let Some(parsed) = parse_remote_branch(reference, remotes) {
        return Some(parsed);
    }
    let (remote, branch) = reference.split_once('/')?;
    if remote.is_empty() || branch.is_empty() {
        return None;
    }
    Some(RemoteBranch {
        remote: remote.to_string(),
        branch: branch.to_string(),
        reference: reference.to_string(),
    })
}

fn split_git_lines(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn run_git_capture(cwd: &str, args: &[&str], max_bytes: usize) -> Result<String, String> {
    let result = run_command_capture(
        "git",
        args,
        cwd,
        None,
        GIT_COMMAND_TIMEOUT,
        max_bytes,
        false,
        "",
        None,
    );
    if let Some(error) = result.spawn_error {
        return Err(error);
    }
    if result.timed_out {
        return Err("git command timed out".to_string());
    }
    if result.exit_code != Some(0) {
        let detail = normalize_optional_text(&result.stderr)
            .or_else(|| normalize_optional_text(&result.stdout))
            .unwrap_or_else(|| "git command failed".to_string());
        return Err(detail);
    }
    Ok(result.stdout)
}

fn execute_plan_blocking(
    input: SourceControlGenerationPlanInput,
    canceled_lanes: Arc<Mutex<HashSet<String>>>,
) -> Result<SourceControlGenerationPlanResult, String> {
    validate_cwd(&input.cwd)?;
    let timeout = Duration::from_millis(input.timeout_ms.clamp(1_000, 120_000));
    let max_bytes = input.max_output_bytes.clamp(1024, 8 * 1024 * 1024);
    let arg_refs: Vec<&str> = input.args.iter().map(String::as_str).collect();
    Ok(run_command_capture(
        &input.binary,
        &arg_refs,
        &input.cwd,
        input.stdin_payload.as_deref(),
        timeout,
        max_bytes,
        true,
        &input.lane_key,
        Some(&canceled_lanes),
    )
    .with_cancel_state(&canceled_lanes))
}

fn run_command_capture(
    binary: &str,
    args: &[&str],
    cwd: &str,
    stdin_payload: Option<&str>,
    timeout: Duration,
    max_bytes: usize,
    cancellable: bool,
    lane_key: &str,
    cancel_state: Option<&Arc<Mutex<HashSet<String>>>>,
) -> RunningCommandResult {
    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return RunningCommandResult {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                timed_out: false,
                canceled: false,
                spawn_error: Some(error.to_string()),
                lane_key: lane_key.to_string(),
                cancellable,
            };
        }
    };

    if let Some(payload) = stdin_payload {
        if let Some(mut stdin) = child.stdin.take() {
            let payload = payload.as_bytes().to_vec();
            thread::spawn(move || {
                let _ = stdin.write_all(&payload);
            });
        }
    }

    let stdout = child
        .stdout
        .take()
        .map(|reader| spawn_capped_reader(reader, max_bytes));
    let stderr = child
        .stderr
        .take()
        .map(|reader| spawn_capped_reader(reader, max_bytes));

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let mut canceled = false;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(error) => {
                kill_child(&mut child);
                break None.or_else(|| {
                    let _ = error;
                    None
                });
            }
        }
        if Instant::now() >= deadline {
            timed_out = true;
            kill_child(&mut child);
            let _ = child.wait();
            break None;
        }
        if cancellable
            && cancel_state
                .and_then(|state| is_lane_canceled(state, lane_key).ok())
                .unwrap_or(false)
        {
            canceled = true;
            kill_child(&mut child);
            let _ = child.wait();
            break None;
        }
        thread::sleep(GENERATION_POLL_INTERVAL);
    };

    RunningCommandResult {
        stdout: join_reader(stdout),
        stderr: join_reader(stderr),
        exit_code,
        timed_out,
        canceled,
        spawn_error: None,
        lane_key: lane_key.to_string(),
        cancellable,
    }
}

struct RunningCommandResult {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
    canceled: bool,
    spawn_error: Option<String>,
    lane_key: String,
    cancellable: bool,
}

impl RunningCommandResult {
    fn with_cancel_state(
        self,
        canceled_lanes: &Arc<Mutex<HashSet<String>>>,
    ) -> SourceControlGenerationPlanResult {
        if self.cancellable {
            let _ = clear_canceled_lane(canceled_lanes, &self.lane_key);
        }
        SourceControlGenerationPlanResult {
            stdout: self.stdout,
            stderr: self.stderr,
            exit_code: self.exit_code,
            timed_out: self.timed_out,
            canceled: self.canceled,
            spawn_error: self.spawn_error,
        }
    }
}

fn spawn_capped_reader<R>(mut reader: R, max_bytes: usize) -> thread::JoinHandle<String>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let remaining = max_bytes.saturating_sub(output.len());
                    if remaining > 0 {
                        output.extend_from_slice(&buffer[..count.min(remaining)]);
                    }
                }
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&output).into_owned()
    })
}

fn join_reader(handle: Option<thread::JoinHandle<String>>) -> String {
    handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default()
}

fn validate_cwd(cwd: &str) -> Result<(), String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Err("worktree path is required".to_string());
    }
    if !Path::new(trimmed).is_dir() {
        return Err("worktree path does not exist".to_string());
    }
    Ok(())
}

fn clear_canceled_lane(
    canceled_lanes: &Arc<Mutex<HashSet<String>>>,
    lane_key: &str,
) -> Result<(), String> {
    let mut lanes = canceled_lanes
        .lock()
        .map_err(|_| "text-generation cancel state lock is poisoned".to_string())?;
    lanes.remove(lane_key);
    Ok(())
}

fn is_lane_canceled(
    canceled_lanes: &Arc<Mutex<HashSet<String>>>,
    lane_key: &str,
) -> Result<bool, String> {
    let lanes = canceled_lanes
        .lock()
        .map_err(|_| "text-generation cancel state lock is poisoned".to_string())?;
    Ok(lanes.contains(lane_key))
}

fn kill_child(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/pid", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

fn normalize_optional_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn default_generation_timeout_ms() -> u64 {
    60_000
}

fn default_max_output_bytes() -> usize {
    4 * 1024 * 1024
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn run_git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .expect("git should start");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn initialize_repo() -> tempfile::TempDir {
        let repo = tempfile::tempdir().expect("temp repo");
        run_git(repo.path(), &["init", "-b", "main"]);
        run_git(
            repo.path(),
            &["config", "user.email", "pebble@example.test"],
        );
        run_git(repo.path(), &["config", "user.name", "Pebble Test"]);
        fs::write(repo.path().join("README.md"), "one\n").expect("write initial file");
        run_git(repo.path(), &["add", "README.md"]);
        run_git(repo.path(), &["commit", "-m", "Initialize project"]);
        repo
    }

    #[test]
    fn reads_real_staged_commit_context() {
        let repo = initialize_repo();
        fs::write(repo.path().join("README.md"), "one\ntwo\n").expect("write staged change");
        run_git(repo.path(), &["add", "README.md"]);

        let context = read_commit_context_blocking(repo.path().to_string_lossy().as_ref())
            .expect("read staged context");

        assert_eq!(context.branch.as_deref(), Some("main"));
        assert!(context.staged_summary.contains("README.md"));
        assert!(context.staged_patch.contains("+two"));
    }

    #[test]
    fn reads_real_pull_request_comparison_context() {
        let repo = initialize_repo();
        run_git(
            repo.path(),
            &["checkout", "-b", "feature/native-generation"],
        );
        fs::write(repo.path().join("README.md"), "one\nfeature\n").expect("write feature change");
        run_git(repo.path(), &["add", "README.md"]);
        run_git(repo.path(), &["commit", "-m", "Add native generation"]);

        let context = read_pull_request_context_blocking(SourceControlPullRequestContextInput {
            cwd: repo.path().to_string_lossy().into_owned(),
            base: "main".to_string(),
            current_title: "Draft".to_string(),
            current_body: "".to_string(),
            current_draft: false,
        })
        .expect("read pull request context")
        .expect("feature branch should differ from main");

        assert_eq!(context.branch.as_deref(), Some("feature/native-generation"));
        assert_eq!(context.base, "main");
        assert!(context.commit_summary.contains("Add native generation"));
        assert!(context.change_summary.contains("README.md"));
        assert!(context.patch.contains("+feature"));
    }
}
