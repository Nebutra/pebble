use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn app_floating_terminal_cwd(path: Option<String>) -> Result<String, String> {
    let home =
        home_dir().ok_or_else(|| "Could not resolve the user home directory.".to_string())?;
    resolve_floating_terminal_cwd(&home, path.as_deref())
        .map(|value| value.to_string_lossy().into_owned())
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(|| {
                let drive = std::env::var_os("HOMEDRIVE")?;
                let path = std::env::var_os("HOMEPATH")?;
                Some(PathBuf::from(drive).join(path))
            })
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn resolve_floating_terminal_cwd(home: &Path, requested: Option<&str>) -> Result<PathBuf, String> {
    let requested = requested.map(str::trim).filter(|value| !value.is_empty());
    let resolved = match requested {
        None | Some("~") => home.to_path_buf(),
        Some(value) if value.starts_with("~/") || value.starts_with("~\\") => {
            home.join(&value[2..])
        }
        Some(value) => PathBuf::from(value),
    };
    if !resolved.is_dir() {
        return Err(format!(
            "Terminal working directory does not exist: {}",
            resolved.to_string_lossy()
        ));
    }
    Ok(resolved)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownDocument {
    file_path: String,
    relative_path: String,
    basename: String,
    name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    platform: String,
    os_release: String,
    display_server: Option<String>,
}

#[tauri::command]
pub fn app_platform_info() -> PlatformInfo {
    PlatformInfo {
        platform: match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        }
        .to_string(),
        os_release: platform_os_release(),
        display_server: linux_display_server(),
    }
}

fn platform_os_release() -> String {
    #[cfg(target_os = "windows")]
    let command = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "[Environment]::OSVersion.Version.ToString()",
        ])
        .output();
    #[cfg(not(target_os = "windows"))]
    let command = Command::new("uname").arg("-r").output();
    command
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn linux_display_server() -> Option<String> {
    if std::env::consts::OS != "linux" {
        return None;
    }
    let session = std::env::var("XDG_SESSION_TYPE")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if session == "wayland" || std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return Some("wayland".to_string());
    }
    if session == "x11" || std::env::var_os("DISPLAY").is_some() {
        return Some("x11".to_string());
    }
    None
}

#[cfg(test)]
mod platform_tests {
    use super::*;

    #[test]
    fn reports_node_compatible_platform_and_release() {
        let info = app_platform_info();
        assert!(matches!(
            info.platform.as_str(),
            "darwin" | "win32" | "linux"
        ));
        assert!(!info.os_release.is_empty());
    }
}

#[cfg(test)]
mod floating_terminal_tests {
    use super::*;

    #[test]
    fn resolves_home_and_home_relative_paths() {
        let home = std::env::temp_dir();
        assert_eq!(
            resolve_floating_terminal_cwd(&home, Some("~")).unwrap(),
            home
        );
        let child = home.join("pebble-floating-terminal-test");
        fs::create_dir_all(&child).unwrap();
        assert_eq!(
            resolve_floating_terminal_cwd(&home, Some("~/pebble-floating-terminal-test")).unwrap(),
            child
        );
        let _ = fs::remove_dir(child);
    }

    #[test]
    fn rejects_missing_working_directories() {
        let missing = std::env::temp_dir().join("pebble-missing-floating-terminal-directory");
        let error = resolve_floating_terminal_cwd(&std::env::temp_dir(), missing.to_str())
            .expect_err("missing cwd must be rejected");
        assert!(error.contains("does not exist"));
    }
}

#[tauri::command]
pub fn app_floating_markdown_directory(app: AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("floating-workspace");
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn app_pick_floating_workspace_directory() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn app_pick_floating_markdown_document(
    app: AppHandle,
) -> Result<Option<MarkdownDocument>, String> {
    let root = PathBuf::from(app_floating_markdown_directory(app)?);
    let Some(path) = rfd::FileDialog::new()
        .set_directory(&root)
        .add_filter("Markdown", &["md", "mdx", "markdown"])
        .pick_file()
    else {
        return Ok(None);
    };
    if !is_markdown_path(&path) {
        return Err("Selected file is not a markdown document.".to_string());
    }
    Ok(Some(markdown_document(&root, &path)))
}

#[tauri::command]
pub fn app_keyboard_input_source_id() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("defaults")
            .args([
                "read",
                "com.apple.HIToolbox",
                "AppleCurrentKeyboardLayoutInputSourceID",
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return (!value.is_empty()).then_some(value);
    }
    #[cfg(not(target_os = "macos"))]
    None
}

#[tauri::command]
pub fn app_list_fonts() -> Vec<String> {
    let mut fonts = BTreeSet::new();
    #[cfg(target_os = "macos")]
    collect_font_command(
        &mut fonts,
        "system_profiler",
        &["SPFontsDataType", "-detailLevel", "mini"],
    );
    #[cfg(target_os = "linux")]
    collect_font_command(&mut fonts, "fc-list", &[":", "family"]);
    #[cfg(target_os = "windows")]
    collect_font_command(
        &mut fonts,
        "powershell",
        &[
            "-NoProfile",
            "-Command",
            "(New-Object Drawing.Text.InstalledFontCollection).Families.Name",
        ],
    );
    fonts.into_iter().collect()
}

fn collect_font_command(fonts: &mut BTreeSet<String>, command: &str, args: &[&str]) {
    let Ok(output) = Command::new(command).args(args).output() else {
        return;
    };
    if !output.status.success() {
        return;
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let value = line
            .trim()
            .trim_start_matches("Full Name:")
            .trim_start_matches("Family:")
            .trim();
        for family in value.split(',') {
            let family = family.trim();
            if !family.is_empty() && !family.contains(':') && family.len() < 128 {
                fonts.insert(family.to_string());
            }
        }
    }
}

fn is_markdown_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("md" | "mdx" | "markdown")
    )
}

fn markdown_document(root: &Path, path: &Path) -> MarkdownDocument {
    let basename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    let relative_path = path
        .strip_prefix(root)
        .ok()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(&basename)
        .replace('\\', "/");
    MarkdownDocument {
        file_path: path.to_string_lossy().into_owned(),
        relative_path,
        basename,
        name,
    }
}
