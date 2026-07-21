use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::Manager;

const MAX_CONFIG_BYTES: u64 = 1_000_000;
const MAX_THEME_BYTES: u64 = 262_144;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhosttySource {
    path: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhosttySourcesResult {
    configs: Vec<GhosttySource>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhosttyThemeInput {
    name: String,
}

#[tauri::command]
pub fn settings_read_ghostty_sources(
    app: tauri::AppHandle,
) -> Result<GhosttySourcesResult, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let mut configs = Vec::new();
    for path in config_candidates(&home) {
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if metadata.len() > MAX_CONFIG_BYTES {
            return Err(format!(
                "Config file is too large to import ({} bytes, limit {MAX_CONFIG_BYTES}).",
                metadata.len()
            ));
        }
        let content =
            fs::read_to_string(&path).map_err(|error| format!("Could not read config: {error}"))?;
        configs.push(GhosttySource {
            path: path.to_string_lossy().into_owned(),
            content,
        });
    }
    Ok(GhosttySourcesResult { configs })
}

#[tauri::command]
pub fn settings_read_ghostty_theme(
    app: tauri::AppHandle,
    input: GhosttyThemeInput,
) -> Result<Option<String>, String> {
    let name = input.name.trim();
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let requested = Path::new(name);
    if requested.is_absolute() {
        return read_bounded_theme(requested);
    }
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Ok(None);
    }
    for directory in theme_directories(&home) {
        let path = directory.join(name);
        match read_bounded_theme(&path)? {
            Some(content) => return Ok(Some(content)),
            None => continue,
        }
    }
    Ok(None)
}

fn config_candidates(home: &Path) -> Vec<PathBuf> {
    let mut directories = vec![xdg_config_root(home).join("ghostty")];
    #[cfg(target_os = "macos")]
    directories.push(home.join("Library/Application Support/com.mitchellh.ghostty"));
    #[cfg(target_os = "windows")]
    {
        directories.clear();
        directories.push(
            env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.to_path_buf())
                .join("ghostty"),
        );
    }
    directories
        .into_iter()
        .flat_map(|directory| [directory.join("config.ghostty"), directory.join("config")])
        .collect()
}

fn theme_directories(home: &Path) -> Vec<PathBuf> {
    let mut directories = vec![xdg_config_root(home).join("ghostty/themes")];
    if let Some(resources) = env::var_os("GHOSTTY_RESOURCES_DIR") {
        directories.push(PathBuf::from(resources).join("themes"));
        return directories;
    }
    #[cfg(target_os = "macos")]
    directories.push(PathBuf::from(
        "/Applications/Ghostty.app/Contents/Resources/ghostty/themes",
    ));
    #[cfg(target_os = "linux")]
    directories.extend([
        PathBuf::from("/usr/share/ghostty/themes"),
        PathBuf::from("/usr/local/share/ghostty/themes"),
    ]);
    directories
}

fn xdg_config_root(home: &Path) -> PathBuf {
    env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
}

fn read_bounded_theme(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
    };
    if !metadata.is_file() || metadata.len() > MAX_THEME_BYTES {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_candidates_keep_modern_before_legacy() {
        let candidates = config_candidates(Path::new("/home/alice"));
        assert!(candidates.len() >= 2);
        assert_eq!(candidates[0].file_name().unwrap(), "config.ghostty");
        assert_eq!(candidates[1].file_name().unwrap(), "config");
    }

    #[test]
    fn bounded_theme_rejects_oversized_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large-theme");
        fs::write(&path, vec![b'x'; MAX_THEME_BYTES as usize + 1]).unwrap();
        assert!(read_bounded_theme(&path).unwrap().is_none());
    }
}
