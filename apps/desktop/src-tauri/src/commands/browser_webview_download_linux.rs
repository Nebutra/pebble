#[cfg(target_os = "linux")]
mod platform {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex};

    use glib::prelude::ObjectExt;
    use tauri::{AppHandle, Webview};
    use webkit2gtk::{Download, DownloadExt, WebContextExt, WebViewExt};

    use super::super::NativeDownloadState;

    thread_local! {
        static DOWNLOADS: RefCell<HashMap<String, Download>> = RefCell::new(HashMap::new());
        static ATTACHED_CONTEXTS: RefCell<HashSet<usize>> = RefCell::new(HashSet::new());
    }

    pub(super) fn attach(
        webview: &Webview,
        state: Arc<Mutex<NativeDownloadState>>,
    ) -> Result<(), String> {
        webview
            .with_webview(move |platform_webview| {
                let Some(context) = platform_webview.inner().context() else {
                    return;
                };
                let context_key = context.as_ptr() as usize;
                let needs_attach =
                    ATTACHED_CONTEXTS.with(|contexts| contexts.borrow_mut().insert(context_key));
                if !needs_attach {
                    return;
                }
                context.connect_download_started(move |_context, download| {
                    let state = Arc::clone(&state);
                    download.connect_decide_destination(move |download, _filename| {
                        let Some(url) = download.request().and_then(|request| request.uri()) else {
                            return false;
                        };
                        let pending = state.lock().ok().and_then(|mut downloads| {
                            super::super::claim_pending_download_for_url(
                                &mut downloads,
                                url.as_str(),
                            )
                        });
                        if let Some(pending) = pending {
                            // Why: WebKitGTK exposes cancellation only on the native Download
                            // object, so retain it until the matching runtime download finishes.
                            DOWNLOADS.with(|downloads| {
                                downloads
                                    .borrow_mut()
                                    .insert(pending.id.clone(), download.clone());
                            });
                        }
                        false
                    });
                });
            })
            .map_err(|error| error.to_string())
    }

    pub(super) async fn cancel(app: &AppHandle, native_download_id: &str) -> Result<bool, String> {
        let native_download_id = native_download_id.to_string();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let canceled = DOWNLOADS.with(|downloads| {
                downloads.borrow().get(&native_download_id).map(|download| {
                    download.cancel();
                    true
                })
            });
            let _ = sender.send(canceled.unwrap_or(false));
        })
        .map_err(|error| error.to_string())?;
        receiver
            .await
            .map_err(|_| "browser download cancel callback was dropped".to_string())
    }

    pub(super) fn forget(native_download_id: &str) {
        DOWNLOADS.with(|downloads| {
            downloads.borrow_mut().remove(native_download_id);
        });
    }
}

#[cfg(target_os = "linux")]
pub(super) use platform::{attach, cancel, forget};

#[cfg(not(target_os = "linux"))]
pub(super) fn attach(
    _webview: &tauri::Webview,
    _state: std::sync::Arc<std::sync::Mutex<super::NativeDownloadState>>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(super) async fn cancel(
    _app: &tauri::AppHandle,
    _native_download_id: &str,
) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn forget(_native_download_id: &str) {}
