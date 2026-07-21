use tauri::{AppHandle, Webview};

#[cfg(target_os = "linux")]
pub(super) fn attach(
    webview: &Webview,
    app: AppHandle,
    label: String,
    url: String,
) -> Result<(), String> {
    use webkit2gtk::{WebProcessTerminationReason, WebViewExt};

    webview
        .with_webview(move |platform_webview| {
            platform_webview
                .inner()
                .connect_web_process_terminated(move |_webview, reason| {
                    let reason = match reason {
                        WebProcessTerminationReason::Crashed => "web-process-crashed",
                        WebProcessTerminationReason::ExceededMemoryLimit => {
                            "web-process-memory-limit"
                        }
                        // Why: removing a child WebView intentionally terminates its
                        // process and must not create a startup crash prompt.
                        WebProcessTerminationReason::TerminatedByApi => return,
                        _ => "web-process-unknown",
                    };
                    super::crash_reports::record_native_webview_process_failure(
                        app.clone(),
                        label.clone(),
                        Some(url.clone()),
                        reason.to_string(),
                    );
                });
        })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
pub(super) fn attach(
    webview: &Webview,
    app: AppHandle,
    label: String,
    url: String,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::ProcessFailedEventHandler;

    webview
        .with_webview(move |platform_webview| {
            let controller = platform_webview.controller();
            let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
                return;
            };
            let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED;
                unsafe { args.ProcessFailedKind(&mut kind)? };
                let reason = webview2_failure_reason(kind);
                super::crash_reports::record_native_webview_process_failure(
                    app.clone(),
                    label.clone(),
                    Some(url.clone()),
                    reason.to_string(),
                );
                Ok(())
            }));
            let mut token = 0_i64;
            let _ = unsafe { core.add_ProcessFailed(&handler, &mut token) };
        })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn webview2_failure_reason(
    kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
) -> &'static str {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "browser-process-exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
            "render-process-unresponsive"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => "gpu-process-exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => {
            "frame-render-process-exited"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "render-process-exited",
        _ => "webview2-process-failed",
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub(super) fn attach(
    _webview: &Webview,
    _app: AppHandle,
    _label: String,
    _url: String,
) -> Result<(), String> {
    Ok(())
}
