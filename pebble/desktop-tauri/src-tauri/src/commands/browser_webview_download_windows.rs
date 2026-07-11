use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Webview};

use super::NativeDownloadState;

#[cfg(target_os = "windows")]
thread_local! {
    static DOWNLOAD_OPERATIONS: std::cell::RefCell<std::collections::HashMap<
        String,
        webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadOperation,
    >> = std::cell::RefCell::new(std::collections::HashMap::new());
}

#[cfg(target_os = "windows")]
pub(super) fn attach_download_tracking(
    webview: &Webview,
    webview_label: String,
    app: AppHandle,
    state: Arc<Mutex<NativeDownloadState>>,
) -> Result<(), String> {
    use std::sync::mpsc;

    let (sender, receiver) = mpsc::channel();
    webview
        .with_webview(move |platform_webview| {
            let _ = sender.send(attach_platform_download_tracking(
                platform_webview,
                webview_label,
                app,
                state,
            ));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .map_err(|_| "browser download tracking callback was dropped".to_string())?
}

#[cfg(not(target_os = "windows"))]
pub(super) fn attach_download_tracking(
    _webview: &Webview,
    _webview_label: String,
    _app: AppHandle,
    _state: Arc<Mutex<NativeDownloadState>>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn attach_platform_download_tracking(
    platform_webview: tauri::webview::PlatformWebview,
    webview_label: String,
    app: AppHandle,
    state: Arc<Mutex<NativeDownloadState>>,
) -> Result<(), String> {
    use webview2_com::DownloadStartingEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_4;
    use windows::core::Interface;

    let controller = platform_webview.controller();
    let webview = unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
    let webview4: ICoreWebView2_4 = webview.cast().map_err(|error| error.to_string())?;
    let handler = DownloadStartingEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let operation = unsafe { args.DownloadOperation()? };
        let url = read_operation_url(&operation)?;
        let pending = state.lock().ok().and_then(|downloads| {
            downloads
                .by_url
                .get(&url)
                .and_then(|queue| queue.back())
                .cloned()
        });
        let Some(pending) = pending else {
            return Ok(());
        };
        if let Ok(mut downloads) = state.lock() {
            downloads
                .active_webviews
                .insert(pending.id.clone(), webview_label.clone());
        }
        DOWNLOAD_OPERATIONS.with(|operations| {
            operations
                .borrow_mut()
                .insert(pending.id.clone(), operation.clone());
        });
        attach_progress_handler(operation, app.clone(), pending)?;
        Ok(())
    }));
    let mut token = 0_i64;
    unsafe { webview4.add_DownloadStarting(&handler, &mut token) }
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn attach_progress_handler(
    operation: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadOperation,
    app: AppHandle,
    pending: super::PendingNativeDownload,
) -> windows::core::Result<()> {
    use tauri::Emitter;
    use webview2_com::BytesReceivedChangedEventHandler;

    let handler = BytesReceivedChangedEventHandler::create(Box::new(move |operation, _| {
        let Some(operation) = operation else {
            return Ok(());
        };
        let mut received_bytes = 0_i64;
        let mut total_bytes = 0_i64;
        unsafe {
            operation.BytesReceived(&mut received_bytes)?;
            operation.TotalBytesToReceive(&mut total_bytes)?;
        }
        let payload = super::NativeBrowserDownloadEvent::Progress {
            native_download_id: pending.id.clone(),
            browser_tab_id: pending.browser_tab_id.clone(),
            received_bytes: received_bytes.max(0) as u64,
            total_bytes: (total_bytes > 0).then_some(total_bytes as u64),
        };
        let _ = app.emit(super::BROWSER_DOWNLOAD_EVENT, payload);
        Ok(())
    }));
    let mut token = 0_i64;
    unsafe { operation.add_BytesReceivedChanged(&handler, &mut token) }
}

#[cfg(target_os = "windows")]
fn read_operation_url(
    operation: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadOperation,
) -> windows::core::Result<String> {
    let mut value = windows::core::PWSTR::null();
    unsafe { operation.Uri(&mut value)? };
    Ok(webview2_com::take_pwstr(value))
}

#[cfg(target_os = "windows")]
pub(super) async fn cancel_download(
    app: &AppHandle,
    state: &Arc<Mutex<NativeDownloadState>>,
    native_download_id: &str,
) -> Result<bool, String> {
    use tauri::Manager;

    let webview_label = state
        .lock()
        .map_err(|_| "native browser download state is unavailable".to_string())?
        .active_webviews
        .get(native_download_id)
        .cloned();
    let Some(webview_label) = webview_label else {
        return Ok(false);
    };
    let webview = app
        .get_webview(&webview_label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    let native_download_id = native_download_id.to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |_| {
            let result = DOWNLOAD_OPERATIONS.with(|operations| {
                let operations = operations.borrow();
                let Some(operation) = operations.get(&native_download_id) else {
                    return Ok(false);
                };
                unsafe { operation.Cancel() }.map_err(|error| error.to_string())?;
                Ok(true)
            });
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "browser download cancel callback was dropped".to_string())?
}

#[cfg(not(target_os = "windows"))]
pub(super) async fn cancel_download(
    _app: &AppHandle,
    _state: &Arc<Mutex<NativeDownloadState>>,
    _native_download_id: &str,
) -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "windows")]
pub(super) fn forget_download(native_download_id: &str) {
    DOWNLOAD_OPERATIONS.with(|operations| {
        operations.borrow_mut().remove(native_download_id);
    });
}
