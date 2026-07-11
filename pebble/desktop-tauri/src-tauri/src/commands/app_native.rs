use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownDocument {
    file_path: String,
    relative_path: String,
    basename: String,
    name: String,
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
