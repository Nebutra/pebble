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

#[tauri::command]
pub fn git_search_base_ref_details(input: GitBaseRefSearchInput) -> Vec<GitBaseRefSearchResult> {
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
pub fn git_get_base_ref_default(input: GitBaseRefDefaultInput) -> GitBaseRefDefaultResult {
    let remotes = list_remotes(&input.repo_path);
    GitBaseRefDefaultResult {
        default_base_ref: resolve_default_base_ref(&input.repo_path, &remotes),
        remote_count: remotes.len(),
    }
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

fn has_git_ref(repo_path: &str, ref_name: &str) -> bool {
    Command::new("git")
        .args(["-C", repo_path, "rev-parse", "--verify", ref_name])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn git_stdout(repo_path: &str, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_refs_without_head_entries() {
        let stdout = "refs/remotes/origin/HEAD\0origin/HEAD\nrefs/remotes/origin/main\0origin/main\nrefs/heads/local\0local\n";
        let refs = parse_base_ref_details(stdout, "", 10, &["origin".to_string()]);
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].ref_name, "origin/main");
        assert_eq!(refs[0].local_branch_name, "main");
        assert_eq!(refs[1].ref_name, "local");
    }
}
