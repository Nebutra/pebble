use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueCommandRunnerInput {
    repo_path: String,
    worktree_path: String,
    command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueCommandRunnerResult {
    runner_script_path: String,
    env_vars: HashMap<String, String>,
}

#[tauri::command]
pub fn hooks_create_issue_command_runner(
    input: IssueCommandRunnerInput,
) -> Result<IssueCommandRunnerResult, String> {
    let repo_path = non_empty_path(&input.repo_path, "repo path")?;
    let worktree_path = non_empty_path(&input.worktree_path, "worktree path")?;
    let command = input.command.trim();
    if command.is_empty() {
        return Err("Issue command is required.".to_string());
    }

    let runner_name = if cfg!(windows) {
        "pebble/issue-command-runner.cmd"
    } else {
        "pebble/issue-command-runner.sh"
    };
    let runner_script_path = resolve_git_path(&worktree_path, runner_name)?;
    if let Some(parent) = runner_script_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create issue command runner directory: {error}"))?;
    }
    let content = if cfg!(windows) {
        build_windows_runner_script(command)
    } else {
        build_posix_runner_script(command)
    };
    fs::write(&runner_script_path, content)
        .map_err(|error| format!("Could not write issue command runner: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&runner_script_path, fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("Could not make issue command runner executable: {error}"))?;
    }

    Ok(IssueCommandRunnerResult {
        runner_script_path: runner_script_path.to_string_lossy().to_string(),
        env_vars: build_issue_command_env_vars(&repo_path, &worktree_path),
    })
}

fn non_empty_path(value: &str, name: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{name} is required."));
    }
    Ok(PathBuf::from(trimmed))
}

fn resolve_git_path(worktree_path: &Path, runner_name: &str) -> Result<PathBuf, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(worktree_path)
        .arg("rev-parse")
        .arg("--git-path")
        .arg(runner_name)
        .output()
        .map_err(|error| format!("Could not resolve issue command runner path: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() {
        return Err("Git returned an empty issue command runner path.".to_string());
    }
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        Ok(path)
    } else {
        // Why: `git rev-parse --git-path` may return `.git/...` relative to the
        // queried worktree; writing relative to the app cwd would hit the wrong repo.
        Ok(worktree_path.join(path))
    }
}

fn build_posix_runner_script(command: &str) -> String {
    format!(
        "#!/usr/bin/env bash\nset -e\n{}\n",
        normalize_crlf_line_endings(command)
    )
}

fn build_windows_runner_script(command: &str) -> String {
    let mut runner = String::from("@echo off\r\nsetlocal EnableExtensions\r\n");
    for line in command.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            runner.push_str("\r\n");
            continue;
        }
        runner.push_str("call ");
        runner.push_str(trimmed);
        runner.push_str("\r\nif errorlevel 1 exit /b %errorlevel%\r\n");
    }
    runner
}

fn normalize_crlf_line_endings(command: &str) -> String {
    command.replace("\r\n", "\n")
}

fn build_issue_command_env_vars(repo_path: &Path, worktree_path: &Path) -> HashMap<String, String> {
    let repo_path = repo_path.to_string_lossy().to_string();
    let worktree_path = worktree_path.to_string_lossy().to_string();
    let mut env_vars = HashMap::new();
    env_vars.insert("PEBBLE_ROOT_PATH".to_string(), repo_path.clone());
    env_vars.insert("PEBBLE_WORKTREE_PATH".to_string(), worktree_path.clone());
    env_vars.insert(
        "PEBBLE_WORKSPACE_NAME".to_string(),
        runtime_path_basename(&worktree_path),
    );
    // Why: existing user hooks may still reference the historical names even
    // after the Pebble rename; Tauri must preserve Electron's launch contract.
    env_vars.insert("CONDUCTOR_ROOT_PATH".to_string(), repo_path.clone());
    env_vars.insert("GHOSTX_ROOT_PATH".to_string(), repo_path);
    env_vars
}

fn runtime_path_basename(value: &str) -> String {
    value
        .trim_end_matches(|character| character == '/' || character == '\\')
        .rsplit(|character| character == '/' || character == '\\')
        .find(|part| !part.is_empty())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, io,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TempProject {
        root: PathBuf,
    }

    impl TempProject {
        fn new(name: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock before unix epoch")
                .as_nanos();
            let root = env::temp_dir().join(format!(
                "pebble-tauri-hooks-{name}-{}-{stamp}",
                std::process::id()
            ));
            fs::create_dir_all(&root).expect("create temp project");
            Self { root }
        }

        fn path(&self, relative: &str) -> PathBuf {
            self.root.join(relative)
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn rejects_blank_runner_inputs() {
        let result = hooks_create_issue_command_runner(IssueCommandRunnerInput {
            repo_path: "   ".to_string(),
            worktree_path: "/tmp/worktree".to_string(),
            command: "echo hi".to_string(),
        });

        assert_eq!(result.unwrap_err(), "repo path is required.");

        let result = hooks_create_issue_command_runner(IssueCommandRunnerInput {
            repo_path: "/tmp/repo".to_string(),
            worktree_path: "/tmp/worktree".to_string(),
            command: " \n\t ".to_string(),
        });

        assert_eq!(result.unwrap_err(), "Issue command is required.");
    }

    #[test]
    fn builds_electron_compatible_env_vars() {
        let env_vars = build_issue_command_env_vars(
            Path::new("/Users/test/repo"),
            Path::new(r"C:\Users\test\repo-feature\"),
        );

        assert_eq!(
            env_vars.get("PEBBLE_ROOT_PATH"),
            Some(&"/Users/test/repo".to_string())
        );
        assert_eq!(
            env_vars.get("PEBBLE_WORKTREE_PATH"),
            Some(&r"C:\Users\test\repo-feature\".to_string())
        );
        assert_eq!(
            env_vars.get("PEBBLE_WORKSPACE_NAME"),
            Some(&"repo-feature".to_string())
        );
        assert_eq!(
            env_vars.get("CONDUCTOR_ROOT_PATH"),
            Some(&"/Users/test/repo".to_string())
        );
        assert_eq!(
            env_vars.get("GHOSTX_ROOT_PATH"),
            Some(&"/Users/test/repo".to_string())
        );
    }

    #[test]
    fn writes_runner_under_linked_worktree_git_dir() {
        let temp = TempProject::new("linked-worktree");
        let repo_path = temp.path("repo");
        let worktree_path = temp.path("feature-worktree");
        fs::create_dir_all(&repo_path).expect("create repo path");
        run_git(&repo_path, ["init"]).expect("git init");
        fs::write(repo_path.join("README.md"), "hello\n").expect("write readme");
        run_git(&repo_path, ["add", "README.md"]).expect("git add");
        run_git(
            &repo_path,
            [
                "-c",
                "user.name=Pebble Test",
                "-c",
                "user.email=pebble@example.com",
                "commit",
                "-m",
                "init",
            ],
        )
        .expect("git commit");
        run_git(
            &repo_path,
            [
                "worktree",
                "add",
                "-b",
                "feature-test",
                worktree_path.to_str().expect("utf8 worktree path"),
            ],
        )
        .expect("git worktree add");

        let result = hooks_create_issue_command_runner(IssueCommandRunnerInput {
            repo_path: repo_path.to_string_lossy().to_string(),
            worktree_path: worktree_path.to_string_lossy().to_string(),
            command: "codex exec \"ship it\"\r\npnpm test".to_string(),
        })
        .expect("create runner");

        let expected_runner = run_git_stdout(
            &worktree_path,
            ["rev-parse", "--git-path", "pebble/issue-command-runner.sh"],
        )
        .expect("resolve runner path");
        let expected_runner = PathBuf::from(expected_runner.trim());
        assert_eq!(PathBuf::from(&result.runner_script_path), expected_runner);
        assert_eq!(
            fs::read_to_string(&expected_runner).expect("read runner"),
            "#!/usr/bin/env bash\nset -e\ncodex exec \"ship it\"\npnpm test\n"
        );
        assert_eq!(
            result.env_vars.get("PEBBLE_ROOT_PATH"),
            Some(&repo_path.to_string_lossy().to_string())
        );
        assert_eq!(
            result.env_vars.get("PEBBLE_WORKTREE_PATH"),
            Some(&worktree_path.to_string_lossy().to_string())
        );
        assert_eq!(
            result.env_vars.get("PEBBLE_WORKSPACE_NAME"),
            Some(&"feature-worktree".to_string())
        );
    }

    #[test]
    fn builds_fail_fast_windows_runner_script() {
        assert_eq!(
            build_windows_runner_script("pnpm install\n\npnpm build"),
            "@echo off\r\nsetlocal EnableExtensions\r\ncall pnpm install\r\nif errorlevel 1 exit /b %errorlevel%\r\n\r\ncall pnpm build\r\nif errorlevel 1 exit /b %errorlevel%\r\n"
        );
    }

    fn run_git<const N: usize>(cwd: &Path, args: [&str; N]) -> io::Result<()> {
        let output = Command::new("git").arg("-C").arg(cwd).args(args).output()?;
        if output.status.success() {
            return Ok(());
        }
        Err(io::Error::new(
            io::ErrorKind::Other,
            String::from_utf8_lossy(&output.stderr).to_string(),
        ))
    }

    fn run_git_stdout<const N: usize>(cwd: &Path, args: [&str; N]) -> io::Result<String> {
        let output = Command::new("git").arg("-C").arg(cwd).args(args).output()?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).to_string());
        }
        Err(io::Error::new(
            io::ErrorKind::Other,
            String::from_utf8_lossy(&output.stderr).to_string(),
        ))
    }
}
