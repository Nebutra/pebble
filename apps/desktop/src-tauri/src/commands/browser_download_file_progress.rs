use std::sync::{Arc, Mutex};

use tauri::AppHandle;

use super::{NativeDownloadState, PendingNativeDownload};

#[cfg(not(target_os = "windows"))]
const FILE_PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(400);

#[cfg(not(target_os = "windows"))]
pub(super) fn start_file_progress_tracking(
    app: AppHandle,
    state: Arc<Mutex<NativeDownloadState>>,
    pending: PendingNativeDownload,
) {
    use tauri::Emitter;

    tauri::async_runtime::spawn(async move {
        let mut last_emitted_bytes = None;
        loop {
            tokio::time::sleep(FILE_PROGRESS_INTERVAL).await;
            if !is_download_active(&state, &pending.id) {
                return;
            }
            let Ok(metadata) = std::fs::metadata(&pending.path) else {
                continue;
            };
            let received_bytes = metadata.len();
            if last_emitted_bytes == Some(received_bytes) {
                continue;
            }
            last_emitted_bytes = Some(received_bytes);
            let payload = super::NativeBrowserDownloadEvent::Progress {
                native_download_id: pending.id.clone(),
                browser_tab_id: pending.browser_tab_id.clone(),
                received_bytes,
                total_bytes: None,
            };
            let _ = app.emit(super::BROWSER_DOWNLOAD_EVENT, payload);
        }
    });
}

#[cfg(target_os = "windows")]
pub(super) fn start_file_progress_tracking(
    _app: AppHandle,
    _state: Arc<Mutex<NativeDownloadState>>,
    _pending: PendingNativeDownload,
) {
}

#[cfg(any(not(target_os = "windows"), test))]
pub(super) fn is_download_active(
    state: &Arc<Mutex<NativeDownloadState>>,
    native_download_id: &str,
) -> bool {
    state.lock().is_ok_and(|downloads| {
        downloads
            .by_url
            .values()
            .flatten()
            .any(|pending| pending.id == native_download_id)
    })
}
