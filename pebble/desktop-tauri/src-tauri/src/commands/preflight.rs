use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
};

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightDetectCommandsInput {
    commands: Vec<String>,
}

#[tauri::command]
pub fn preflight_detect_commands(input: PreflightDetectCommandsInput) -> Vec<String> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for command in input.commands {
        let command = command.trim();
        if command.is_empty() || !seen.insert(command.to_string()) {
            continue;
        }
        if is_command_on_path(command) {
            found.push(command.to_string());
        }
    }
    found
}

fn is_command_on_path(command: &str) -> bool {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 {
        return is_executable_file(command_path);
    }
    search_path_dirs()
        .into_iter()
        .flat_map(|dir| {
            executable_names(command)
                .into_iter()
                .map(move |name| dir.join(name))
        })
        .any(|candidate| is_executable_file(&candidate))
}

fn search_path_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path_env) = env::var_os("PATH") {
        dirs.extend(env::split_paths(&path_env));
    }
    dirs.extend(common_agent_install_dirs());
    dedupe_paths(dirs)
}

fn common_agent_install_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join(".bun/bin"));
        dirs.push(home.join(".deno/bin"));
        dirs.push(home.join(".npm-global/bin"));
        dirs.push(home.join("Library/pnpm"));
        dirs.push(home.join("Library/Application Support/fnm"));
        dirs.push(home.join("AppData/Roaming/npm"));
        dirs.push(home.join("AppData/Local/Microsoft/WinGet/Packages"));
    }
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs
}

fn executable_names(command: &str) -> Vec<String> {
    if cfg!(windows) {
        let extensions =
            env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD;.PS1".to_string());
        let has_extension = Path::new(command).extension().is_some();
        if has_extension {
            return vec![command.to_string()];
        }
        return extensions
            .split(';')
            .filter(|extension| !extension.trim().is_empty())
            .map(|extension| format!("{command}{}", extension.to_ascii_lowercase()))
            .chain(std::iter::once(command.to_string()))
            .collect();
    }
    vec![command.to_string()]
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_names_include_windows_extensions() {
        let names = executable_names("codex");
        if cfg!(windows) {
            assert!(names.iter().any(|name| name == "codex.exe"));
        } else {
            assert_eq!(names, vec!["codex"]);
        }
    }
}
