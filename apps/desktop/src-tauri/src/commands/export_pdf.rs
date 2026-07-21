use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::webview::{PageLoadEvent, WebviewWindowBuilder};
use tauri::{AppHandle, WebviewUrl};

const MAX_EXPORT_HTML_BYTES: usize = 16 * 1024 * 1024;
const EXPORT_LOAD_TIMEOUT: Duration = Duration::from_secs(30);
const EXPORT_RENDER_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportHtmlToPdfInput {
    html: String,
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", untagged)]
pub enum ExportHtmlToPdfResult {
    Success { success: bool, file_path: String },
    Cancelled { success: bool, cancelled: bool },
    Error { success: bool, error: String },
}

#[tauri::command]
pub async fn export_html_to_pdf(
    app: AppHandle,
    input: ExportHtmlToPdfInput,
) -> ExportHtmlToPdfResult {
    match export_html_to_pdf_inner(&app, input).await {
        Ok(Some(path)) => ExportHtmlToPdfResult::Success {
            success: true,
            file_path: path.to_string_lossy().into_owned(),
        },
        Ok(None) => ExportHtmlToPdfResult::Cancelled {
            success: false,
            cancelled: true,
        },
        Err(error) => ExportHtmlToPdfResult::Error {
            success: false,
            error,
        },
    }
}

async fn export_html_to_pdf_inner(
    app: &AppHandle,
    input: ExportHtmlToPdfInput,
) -> Result<Option<PathBuf>, String> {
    let html = validate_export_html(input.html)?;
    let label = format!("pdf-export-{}", uuid::Uuid::new_v4());
    let ready_marker = format!("pebble-pdf-ready-{}", uuid::Uuid::new_v4());
    let temp_path = std::env::temp_dir().join(format!("{label}.html"));
    std::fs::write(&temp_path, html).map_err(|error| error.to_string())?;
    let result =
        render_pdf_and_choose_path(app, &label, &ready_marker, &temp_path, &input.title).await;
    let _ = std::fs::remove_file(&temp_path);
    result
}

async fn render_pdf_and_choose_path(
    app: &AppHandle,
    label: &str,
    ready_marker: &str,
    temp_path: &Path,
    title: &str,
) -> Result<Option<PathBuf>, String> {
    let url = tauri::Url::from_file_path(temp_path)
        .map_err(|_| "Could not create the PDF export document URL.".to_string())?;
    let (load_sender, load_receiver) = tokio::sync::oneshot::channel();
    let load_sender = Arc::new(Mutex::new(Some(load_sender)));
    let callback_sender = load_sender.clone();
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("Pebble PDF Export")
        .visible(false)
        .skip_taskbar(true)
        .decorations(false)
        .inner_size(794.0, 1123.0)
        .on_page_load(move |_window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                if let Some(sender) = callback_sender
                    .lock()
                    .ok()
                    .and_then(|mut value| value.take())
                {
                    let _ = sender.send(());
                }
            }
        })
        .build()
        .map_err(|error| error.to_string())?;

    let rendered = async {
        tokio::time::timeout(EXPORT_LOAD_TIMEOUT, load_receiver)
            .await
            .map_err(|_| "Export document load timed out".to_string())?
            .map_err(|_| "Export document load callback was dropped".to_string())?;
        window
            .eval(&image_ready_script(ready_marker))
            .map_err(|error| error.to_string())?;
        wait_for_ready_title(&window, ready_marker).await?;
        super::browser_child_webview::capture_webview_pdf_bytes(window.as_ref()).await
    }
    .await;
    let _ = window.close();
    let bytes = rendered?;
    let Some(path) = choose_pdf_path(title) else {
        return Ok(None);
    };
    write_pdf_without_overwrite_race(&path, &bytes)?;
    Ok(Some(path))
}

async fn wait_for_ready_title(window: &tauri::WebviewWindow, marker: &str) -> Result<(), String> {
    tokio::time::timeout(EXPORT_RENDER_TIMEOUT, async {
        loop {
            if window.title().ok().as_deref() == Some(marker) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| "Export document image rendering timed out".to_string())?;
    Ok(())
}

fn image_ready_script(marker: &str) -> String {
    let marker =
        serde_json::to_string(marker).unwrap_or_else(|_| "\"pebble-pdf-ready\"".to_string());
    format!(
        "(() => {{ const done = () => {{ document.title = {marker}; }}; const images = Array.from(document.images || []); Promise.all(images.map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => {{ image.addEventListener('load', resolve, {{ once: true }}); image.addEventListener('error', resolve, {{ once: true }}); }}))).then(done); }})()"
    )
}

fn validate_export_html(html: String) -> Result<String, String> {
    if html.trim().is_empty() {
        return Err("No content to export".to_string());
    }
    if html.len() > MAX_EXPORT_HTML_BYTES {
        return Err("Export document exceeds the 16 MiB limit".to_string());
    }
    Ok(html)
}

fn choose_pdf_path(title: &str) -> Option<PathBuf> {
    rfd::FileDialog::new()
        .set_file_name(format!("{}.pdf", sanitized_title(title)))
        .add_filter("PDF", &["pdf"])
        .save_file()
}

fn sanitized_title(title: &str) -> String {
    let title: String = title
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .take(100)
        .collect();
    let title = title.trim();
    if title.is_empty() {
        "export".to_string()
    } else {
        title.to_string()
    }
}

fn write_pdf_without_overwrite_race(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("Export renderer returned invalid PDF data".to_string());
    }
    std::fs::write(path, bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_bounded_export_html() {
        assert!(validate_export_html(" ".to_string()).is_err());
        assert_eq!(
            validate_export_html("<p>ok</p>".to_string()).unwrap(),
            "<p>ok</p>"
        );
    }

    #[test]
    fn sanitizes_cross_platform_pdf_filenames() {
        assert_eq!(sanitized_title("a/b:c*?\"<>|"), "a_b_c______");
        assert_eq!(sanitized_title("   "), "export");
    }

    #[test]
    fn image_ready_script_escapes_the_marker() {
        let script = image_ready_script("ready\"marker");
        assert!(script.contains("ready\\\"marker"));
        assert!(script.contains("document.images"));
    }
}
