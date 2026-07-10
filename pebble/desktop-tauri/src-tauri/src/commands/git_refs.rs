use std::{collections::HashSet, process::Command};

use serde::{Deserialize, Serialize};

const REF_SEARCH_CANDIDATE_LIMIT: usize = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBaseRefSearchInput {
    repo_path: String,
    query: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBaseRefDefaultInput {
    repo_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBaseRefSearchResult {
    ref_name: String,
    local_branch_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBaseRefDefaultResult {
    default_base_ref: Option<String>,
    remote_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitResolvePrStartPointInput {
    repo_path: String,
    pr_number: u64,
    head_ref_name: Option<String>,
    base_ref_name: Option<String>,
    is_cross_repository: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitResolveMrStartPointInput {
    repo_path: String,
    mr_iid: u64,
    source_branch: Option<String>,
    target_branch: Option<String>,
    is_cross_repository: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushTarget {
    remote_name: String,
    branch_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewStartPointResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compare_base_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    push_target: Option<GitPushTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    head_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch_name_override: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    maintainer_can_modify: Option<bool>,
}

#[derive(Debug)]
struct GitCommandError {
    message: String,
}

// Why: sync tauri commands run on the main thread; these spawn `git` child
// processes (fetches/ref walks can take seconds on large or cold repos), which
// would freeze the whole window. Run the blocking body on the blocking pool.
#[tauri::command]
pub async fn git_search_base_ref_details(
    input: GitBaseRefSearchInput,
) -> Vec<GitBaseRefSearchResult> {
    tauri::async_runtime::spawn_blocking(move || search_base_ref_details_blocking(input))
        .await
        .unwrap_or_default()
}

fn search_base_ref_details_blocking(input: GitBaseRefSearchInput) -> Vec<GitBaseRefSearchResult> {
    let limit = input.limit.unwrap_or(25).min(100);
    if limit == 0 {
        return Vec::new();
    }
    let remotes = list_remotes(&input.repo_path);
    let output = git_stdout(
        &input.repo_path,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)",
            "--sort=-committerdate",
            &format!("--count={REF_SEARCH_CANDIDATE_LIMIT}"),
            "refs/heads",
            "refs/remotes",
        ],
    )
    .unwrap_or_default();
    parse_base_ref_details(&output, &normalize_ref_query(&input.query), limit, &remotes)
}

#[tauri::command]
pub async fn git_get_base_ref_default(input: GitBaseRefDefaultInput) -> GitBaseRefDefaultResult {
    tauri::async_runtime::spawn_blocking(move || {
        let remotes = list_remotes(&input.repo_path);
        GitBaseRefDefaultResult {
            default_base_ref: resolve_default_base_ref(&input.repo_path, &remotes),
            remote_count: remotes.len(),
        }
    })
    .await
    .unwrap_or(GitBaseRefDefaultResult {
        default_base_ref: None,
        remote_count: 0,
    })
}

#[tauri::command]
pub async fn git_resolve_pr_start_point(
    input: GitResolvePrStartPointInput,
) -> GitReviewStartPointResult {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_pr_start_point(input).unwrap_or_else(GitReviewStartPointResult::failure)
    })
    .await
    .unwrap_or_else(|_| GitReviewStartPointResult::failure("git probe task panicked".to_string()))
}

#[tauri::command]
pub async fn git_resolve_mr_start_point(
    input: GitResolveMrStartPointInput,
) -> GitReviewStartPointResult {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_mr_start_point(input).unwrap_or_else(GitReviewStartPointResult::failure)
    })
    .await
    .unwrap_or_else(|_| GitReviewStartPointResult::failure("git probe task panicked".to_string()))
}

fn resolve_default_base_ref(repo_path: &str, remotes: &[String]) -> Option<String> {
    if remotes.iter().any(|remote| remote == "origin") {
        if let Some(origin_head) = git_stdout(
            repo_path,
            &[
                "symbolic-ref",
                "--quiet",
                "--short",
                "refs/remotes/origin/HEAD",
            ],
        )
        .and_then(|value| value.lines().next().map(str::trim).map(ToOwned::to_owned))
        .filter(|value| !value.is_empty() && value != "origin/HEAD")
        {
            return Some(origin_head);
        }
    }
    [
        "origin/main",
        "origin/master",
        "upstream/main",
        "main",
        "master",
    ]
    .into_iter()
    .find(|candidate| has_git_ref(repo_path, candidate))
    .map(ToOwned::to_owned)
}

fn resolve_pr_start_point(
    input: GitResolvePrStartPointInput,
) -> Result<GitReviewStartPointResult, String> {
    let head_ref_name = normalized_optional(input.head_ref_name).ok_or_else(|| {
        format!(
            "PR #{} has no head branch metadata. Select the PR again or pass headRefName.",
            input.pr_number
        )
    })?;
    let base_ref_name = normalized_optional(input.base_ref_name);
    let remote = default_remote_from_remotes(&list_remotes(&input.repo_path))?;
    let compare_base_ref = base_ref_name
        .as_ref()
        .map(|branch| format!("refs/remotes/{remote}/{branch}"));

    let fetch_compare_base_ref = || -> Result<(), String> {
        let Some(branch) = base_ref_name.as_ref() else {
            return Ok(());
        };
        fetch_remote_tracking_ref(&input.repo_path, &remote, branch)
            .map_err(|error| format!("Failed to fetch {remote}/{branch}: {}", error.message))
    };

    // Why: fork PR heads are exposed by GitHub on the upstream repo, not as a
    // normal refs/heads branch under the configured remote.
    if input.is_cross_repository == Some(true) {
        let head_sha = fetch_github_pr_head_sha(&input.repo_path, &remote, input.pr_number)?;
        fetch_compare_base_ref()?;
        return Ok(GitReviewStartPointResult::success(
            GitReviewStartPointFields {
                base_branch: head_sha.clone(),
                compare_base_ref,
                head_sha: Some(head_sha),
                branch_name_override: Some(head_ref_name),
                push_target: None,
                maintainer_can_modify: None,
            },
        ));
    }

    match fetch_remote_tracking_ref(&input.repo_path, &remote, &head_ref_name) {
        Ok(()) => {}
        Err(error) if is_missing_remote_ref_error(&error.message) => {
            let head_sha = fetch_github_pr_head_sha(&input.repo_path, &remote, input.pr_number)?;
            fetch_compare_base_ref()?;
            return Ok(GitReviewStartPointResult::success(
                GitReviewStartPointFields {
                    base_branch: head_sha.clone(),
                    compare_base_ref,
                    head_sha: Some(head_sha),
                    branch_name_override: Some(head_ref_name),
                    push_target: None,
                    maintainer_can_modify: None,
                },
            ));
        }
        Err(error) => {
            return Err(format!(
                "Failed to fetch {remote}/{head_ref_name}: {}",
                error.message
            ));
        }
    }

    let remote_ref = format!("{remote}/{head_ref_name}");
    let head_sha = git_stdout_result(&input.repo_path, &["rev-parse", "--verify", &remote_ref])
        .map(|value| value.trim().to_string())
        .map_err(|_| format!("Remote ref {remote_ref} does not exist after fetch."))?;
    if head_sha.is_empty() {
        return Err(format!("Empty SHA resolving PR #{} head.", input.pr_number));
    }
    fetch_compare_base_ref()?;
    Ok(GitReviewStartPointResult::success(
        GitReviewStartPointFields {
            base_branch: head_sha.clone(),
            compare_base_ref,
            head_sha: Some(head_sha),
            branch_name_override: Some(head_ref_name.clone()),
            push_target: Some(GitPushTarget {
                remote_name: remote,
                branch_name: head_ref_name,
            }),
            maintainer_can_modify: None,
        },
    ))
}

fn resolve_mr_start_point(
    input: GitResolveMrStartPointInput,
) -> Result<GitReviewStartPointResult, String> {
    let source_branch = normalized_optional(input.source_branch).ok_or_else(|| {
        format!(
            "MR !{} has no source branch metadata. Select the MR again or pass sourceBranch.",
            input.mr_iid
        )
    })?;
    let target_branch = normalized_optional(input.target_branch);
    let remote = default_remote_from_remotes(&list_remotes(&input.repo_path))?;
    let compare_base_ref = target_branch
        .as_ref()
        .map(|branch| format!("refs/remotes/{remote}/{branch}"));

    let fetch_compare_base_ref = || -> Option<String> {
        let branch = target_branch.as_ref()?;
        match fetch_remote_tracking_ref(&input.repo_path, &remote, branch) {
            Ok(()) => compare_base_ref.clone(),
            Err(_) => None,
        }
    };

    if input.is_cross_repository == Some(true) {
        let mr_ref = format!("refs/merge-requests/{}/head", input.mr_iid);
        git_stdout_result(&input.repo_path, &["fetch", &remote, &mr_ref])
            .map_err(|error| format!("Failed to fetch {mr_ref}: {}", error.message))?;
        let head_sha =
            git_stdout_result(&input.repo_path, &["rev-parse", "--verify", "FETCH_HEAD"])
                .map(|value| value.trim().to_string())
                .map_err(|_| {
                    format!(
                        "Could not resolve fork MR !{} head after fetch.",
                        input.mr_iid
                    )
                })?;
        if head_sha.is_empty() {
            return Err(format!(
                "Empty SHA resolving fork MR !{} head.",
                input.mr_iid
            ));
        }
        return Ok(GitReviewStartPointResult::success(
            GitReviewStartPointFields {
                base_branch: head_sha,
                compare_base_ref: fetch_compare_base_ref(),
                head_sha: None,
                branch_name_override: None,
                push_target: None,
                maintainer_can_modify: None,
            },
        ));
    }

    fetch_remote_tracking_ref(&input.repo_path, &remote, &source_branch).map_err(|error| {
        format!(
            "Failed to fetch {remote}/{source_branch}: {}",
            error.message
        )
    })?;
    let remote_ref = format!("{remote}/{source_branch}");
    git_stdout_result(&input.repo_path, &["rev-parse", "--verify", &remote_ref])
        .map_err(|_| format!("Remote ref {remote_ref} does not exist after fetch."))?;
    Ok(GitReviewStartPointResult::success(
        GitReviewStartPointFields {
            base_branch: remote_ref,
            compare_base_ref: fetch_compare_base_ref(),
            head_sha: None,
            branch_name_override: None,
            push_target: Some(GitPushTarget {
                remote_name: remote,
                branch_name: source_branch,
            }),
            maintainer_can_modify: None,
        },
    ))
}

fn parse_base_ref_details(
    stdout: &str,
    normalized_query: &str,
    limit: usize,
    remotes: &[String],
) -> Vec<GitBaseRefSearchResult> {
    let mut seen = HashSet::new();
    let sorted_remotes = sorted_remotes(remotes);
    stdout
        .lines()
        .filter_map(parse_ref_line)
        .filter(|(full, short)| {
            !is_remote_head(full) && matches_query(short, normalized_query, full, &sorted_remotes)
        })
        .filter(|(_, short)| seen.insert(short.clone()))
        .map(|(full, short)| GitBaseRefSearchResult {
            local_branch_name: resolve_local_branch_name(&full, &short, &sorted_remotes),
            ref_name: short,
        })
        .take(limit)
        .collect()
}

fn parse_ref_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    let nul = trimmed.find('\0')?;
    Some((trimmed[..nul].to_string(), trimmed[nul + 1..].to_string()))
}

fn matches_query(
    short_ref: &str,
    normalized_query: &str,
    full_ref: &str,
    remotes: &[String],
) -> bool {
    if normalized_query.is_empty() {
        return true;
    }
    let query = normalized_query.to_ascii_lowercase();
    short_ref.to_ascii_lowercase().contains(&query)
        || resolve_local_branch_name(full_ref, short_ref, remotes)
            .to_ascii_lowercase()
            .contains(&query)
}

fn resolve_local_branch_name(full_ref: &str, short_ref: &str, remotes: &[String]) -> String {
    let Some(remote_and_branch) = full_ref.strip_prefix("refs/remotes/") else {
        return short_ref.to_string();
    };
    if let Some(remote) = remotes
        .iter()
        .find(|remote| remote_and_branch.starts_with(&format!("{remote}/")))
    {
        return remote_and_branch[remote.len() + 1..].to_string();
    }
    remote_and_branch
        .split('/')
        .skip(1)
        .collect::<Vec<_>>()
        .join("/")
}

fn is_remote_head(full_ref: &str) -> bool {
    full_ref.starts_with("refs/remotes/") && full_ref.ends_with("/HEAD")
}

fn normalize_ref_query(query: &str) -> String {
    query
        .trim()
        .chars()
        .filter(|character| !matches!(character, '*' | '?' | '[' | ']' | '\\'))
        .collect()
}

fn sorted_remotes(remotes: &[String]) -> Vec<String> {
    let mut sorted = remotes.to_vec();
    sorted.sort_by_key(|remote| std::cmp::Reverse(remote.len()));
    sorted
}

fn list_remotes(repo_path: &str) -> Vec<String> {
    git_stdout(repo_path, &["remote"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn default_remote_from_remotes(remotes: &[String]) -> Result<String, String> {
    if remotes.iter().any(|remote| remote == "origin") {
        return Ok("origin".to_string());
    }
    if remotes.iter().any(|remote| remote == "upstream") {
        return Ok("upstream".to_string());
    }
    match remotes {
        [] => Err("Repo has no configured git remotes.".to_string()),
        [remote] => Ok(remote.clone()),
        _ => Err(format!(
            "Repo has multiple remotes ({}) and no origin/upstream default.",
            remotes.join(", ")
        )),
    }
}

fn has_git_ref(repo_path: &str, ref_name: &str) -> bool {
    Command::new("git")
        .args(["-C", repo_path, "rev-parse", "--verify", ref_name])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn fetch_remote_tracking_ref(
    repo_path: &str,
    remote: &str,
    branch: &str,
) -> Result<(), GitCommandError> {
    let destination = format!("refs/remotes/{remote}/{branch}");
    let refspec = format!("+refs/heads/{branch}:{destination}");
    git_stdout_result(repo_path, &["fetch", remote, &refspec]).map(|_| ())
}

fn fetch_github_pr_head_sha(
    repo_path: &str,
    remote: &str,
    pr_number: u64,
) -> Result<String, String> {
    let pull_ref = format!("refs/pull/{pr_number}/head");
    git_stdout_result(repo_path, &["fetch", remote, &pull_ref])
        .map_err(|error| format!("Failed to fetch {pull_ref}: {}", error.message))?;
    let head_sha = git_stdout_result(repo_path, &["rev-parse", "--verify", "FETCH_HEAD"])
        .map(|value| value.trim().to_string())
        .map_err(|_| format!("Could not resolve fork PR #{pr_number} head after fetch."))?;
    if head_sha.is_empty() {
        return Err(format!("Empty SHA resolving fork PR #{pr_number} head."));
    }
    Ok(head_sha)
}

fn git_stdout(repo_path: &str, args: &[&str]) -> Option<String> {
    git_stdout_result(repo_path, args).ok()
}

fn git_stdout_result(repo_path: &str, args: &[&str]) -> Result<String, GitCommandError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()
        .map_err(|error| GitCommandError {
            message: error.to_string(),
        })?;
    if !output.status.success() {
        return Err(GitCommandError {
            message: format_git_failure(&output.stderr),
        });
    }
    String::from_utf8(output.stdout).map_err(|error| GitCommandError {
        message: error.to_string(),
    })
}

fn format_git_failure(stderr: &[u8]) -> String {
    let message = String::from_utf8_lossy(stderr).trim().to_string();
    if message.is_empty() {
        return "git command failed".to_string();
    }
    message
        .lines()
        .next()
        .unwrap_or("git command failed")
        .to_string()
}

fn is_missing_remote_ref_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("couldn't find remote ref") || lower.contains("could not find remote ref")
}

fn normalized_optional(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

struct GitReviewStartPointFields {
    base_branch: String,
    compare_base_ref: Option<String>,
    push_target: Option<GitPushTarget>,
    head_sha: Option<String>,
    branch_name_override: Option<String>,
    maintainer_can_modify: Option<bool>,
}

impl GitReviewStartPointResult {
    fn failure(error: String) -> Self {
        Self {
            error: Some(error),
            base_branch: None,
            compare_base_ref: None,
            push_target: None,
            head_sha: None,
            branch_name_override: None,
            maintainer_can_modify: None,
        }
    }

    fn success(fields: GitReviewStartPointFields) -> Self {
        Self {
            error: None,
            base_branch: Some(fields.base_branch),
            compare_base_ref: fields.compare_base_ref,
            push_target: fields.push_target,
            head_sha: fields.head_sha,
            branch_name_override: fields.branch_name_override,
            maintainer_can_modify: fields.maintainer_can_modify,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn parses_remote_refs_without_head_entries() {
        let stdout = "refs/remotes/origin/HEAD\0origin/HEAD\nrefs/remotes/origin/main\0origin/main\nrefs/heads/local\0local\n";
        let refs = parse_base_ref_details(stdout, "", 10, &["origin".to_string()]);
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].ref_name, "origin/main");
        assert_eq!(refs[0].local_branch_name, "main");
        assert_eq!(refs[1].ref_name, "local");
    }

    #[test]
    fn default_remote_prefers_origin_then_upstream() {
        assert_eq!(
            default_remote_from_remotes(&["fork".to_string(), "origin".to_string()]).unwrap(),
            "origin"
        );
        assert_eq!(
            default_remote_from_remotes(&["fork".to_string(), "upstream".to_string()]).unwrap(),
            "upstream"
        );
        assert_eq!(
            default_remote_from_remotes(&["only".to_string()]).unwrap(),
            "only"
        );
    }

    #[test]
    fn missing_remote_ref_detection_matches_git_variants() {
        assert!(is_missing_remote_ref_error(
            "fatal: couldn't find remote ref refs/heads/feature"
        ));
        assert!(is_missing_remote_ref_error(
            "fatal: could not find remote ref refs/heads/feature"
        ));
        assert!(!is_missing_remote_ref_error("fatal: authentication failed"));
    }

    #[test]
    fn resolves_same_project_mr_start_point_from_local_remote() {
        let Some(repo) = create_git_fixture() else {
            return;
        };
        let result = resolve_mr_start_point(GitResolveMrStartPointInput {
            repo_path: repo.worktree.to_string_lossy().to_string(),
            mr_iid: 7,
            source_branch: Some("feature".to_string()),
            target_branch: Some("main".to_string()),
            is_cross_repository: Some(false),
        })
        .expect("MR start point should resolve");

        assert_eq!(result.error, None);
        assert_eq!(result.base_branch.as_deref(), Some("origin/feature"));
        assert_eq!(
            result.compare_base_ref.as_deref(),
            Some("refs/remotes/origin/main")
        );
        assert_eq!(
            result
                .push_target
                .as_ref()
                .map(|target| target.branch_name.as_str()),
            Some("feature")
        );
    }

    struct GitFixture {
        worktree: PathBuf,
    }

    fn create_git_fixture() -> Option<GitFixture> {
        if Command::new("git").arg("--version").output().is_err() {
            return None;
        }
        let root = std::env::temp_dir().join(format!(
            "pebble-git-refs-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_nanos()
        ));
        let remote = root.join("remote.git");
        let worktree = root.join("worktree");
        fs::create_dir_all(&root).ok()?;
        run_git_command(&root, &["init", "--bare", remote.to_str()?]).ok()?;
        run_git_command(&root, &["clone", remote.to_str()?, worktree.to_str()?]).ok()?;
        run_git_command(&worktree, &["config", "user.email", "pebble@example.test"]).ok()?;
        run_git_command(&worktree, &["config", "user.name", "Pebble Test"]).ok()?;
        fs::write(worktree.join("README.md"), "main\n").ok()?;
        run_git_command(&worktree, &["add", "README.md"]).ok()?;
        run_git_command(&worktree, &["commit", "-m", "main"]).ok()?;
        run_git_command(&worktree, &["branch", "-M", "main"]).ok()?;
        run_git_command(&worktree, &["push", "origin", "main"]).ok()?;
        run_git_command(&worktree, &["checkout", "-b", "feature"]).ok()?;
        fs::write(worktree.join("README.md"), "feature\n").ok()?;
        run_git_command(&worktree, &["commit", "-am", "feature"]).ok()?;
        run_git_command(&worktree, &["push", "origin", "feature"]).ok()?;
        Some(GitFixture { worktree })
    }

    fn run_git_command(cwd: &Path, args: &[&str]) -> Result<(), String> {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }
}
