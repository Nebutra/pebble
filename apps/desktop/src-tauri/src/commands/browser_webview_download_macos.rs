#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::sync::{Arc, Mutex, Weak};
    use std::time::{Duration, Instant};

    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{rc::Retained, sel, Message};
    use objc2_web_kit::{WKDownload, WKWebView};
    use tauri::{AppHandle, Webview};

    use super::super::{NativeDownloadState, PendingNativeDownload};

    struct RetainedDownload {
        url: String,
        native_download_id: Option<String>,
        download: Retained<WKDownload>,
        created_at: Instant,
    }

    thread_local! {
        static DOWNLOADS: RefCell<VecDeque<RetainedDownload>> = const { RefCell::new(VecDeque::new()) };
        static HOOKED_CLASSES: RefCell<HashSet<usize>> = RefCell::new(HashSet::new());
        static ORIGINAL_ACTIONS: RefCell<HashMap<usize, Imp>> = RefCell::new(HashMap::new());
        static ORIGINAL_RESPONSES: RefCell<HashMap<usize, Imp>> = RefCell::new(HashMap::new());
        static MANAGED_WEBVIEWS: RefCell<HashMap<usize, Weak<Mutex<NativeDownloadState>>>> = RefCell::new(HashMap::new());
    }

    unsafe extern "C-unwind" fn action_hook(
        delegate: &AnyObject,
        selector: Sel,
        webview: &WKWebView,
        action: &AnyObject,
        download: &WKDownload,
    ) {
        retain_download(webview, download);
        forward(
            delegate,
            selector,
            webview,
            action,
            download,
            &ORIGINAL_ACTIONS,
        );
    }

    unsafe extern "C-unwind" fn response_hook(
        delegate: &AnyObject,
        selector: Sel,
        webview: &WKWebView,
        response: &AnyObject,
        download: &WKDownload,
    ) {
        retain_download(webview, download);
        forward(
            delegate,
            selector,
            webview,
            response,
            download,
            &ORIGINAL_RESPONSES,
        );
    }

    unsafe fn forward(
        delegate: &AnyObject,
        selector: Sel,
        webview: &WKWebView,
        source: &AnyObject,
        download: &WKDownload,
        originals: &'static std::thread::LocalKey<RefCell<HashMap<usize, Imp>>>,
    ) {
        let class = unsafe { objc2::ffi::object_getClass(delegate) };
        let original = originals.with(|values| values.borrow().get(&(class as usize)).copied());
        if let Some(original) = original {
            let original: unsafe extern "C-unwind" fn(
                &AnyObject,
                Sel,
                &WKWebView,
                &AnyObject,
                &WKDownload,
            ) = unsafe { std::mem::transmute(original) };
            unsafe { original(delegate, selector, webview, source, download) };
        }
    }

    fn retain_download(webview: &WKWebView, download: &WKDownload) {
        let url = unsafe {
            download
                .originalRequest()
                .and_then(|request| request.URL())
                .and_then(|url| url.absoluteString())
                .map(|value| value.to_string())
        };
        let Some(url) = url else { return };
        let native_download_id = MANAGED_WEBVIEWS
            .with(|webviews| {
                webviews
                    .borrow()
                    .get(&(webview as *const _ as usize))
                    .and_then(Weak::upgrade)
            })
            .and_then(|state| {
                state.lock().ok().and_then(|mut downloads| {
                    super::super::claim_pending_download_for_url(&mut downloads, &url)
                        .map(|pending| pending.id)
                })
            });
        DOWNLOADS.with(|downloads| {
            let mut downloads = downloads.borrow_mut();
            prune(&mut downloads);
            downloads.push_back(RetainedDownload {
                url,
                native_download_id,
                download: download.retain(),
                created_at: Instant::now(),
            });
            while downloads.len() > 128 {
                downloads.pop_front();
            }
        });
    }

    fn prune(downloads: &mut VecDeque<RetainedDownload>) {
        let cutoff = Instant::now() - Duration::from_secs(600);
        downloads.retain(|entry| entry.created_at >= cutoff);
    }

    unsafe fn method_implementation(class: *mut AnyClass, selector: Sel) -> Result<Imp, String> {
        let method = unsafe { objc2::ffi::class_getInstanceMethod(class, selector) };
        if method.is_null() {
            return Err(format!(
                "browser download selector {selector} is unavailable"
            ));
        }
        unsafe { objc2::ffi::method_getImplementation(method) }
            .ok_or_else(|| format!("browser download selector {selector} has no implementation"))
    }

    pub(crate) fn attach(
        webview: &Webview,
        state: Arc<Mutex<NativeDownloadState>>,
    ) -> Result<(), String> {
        let result = Arc::new(Mutex::new(Ok(())));
        let callback_result = Arc::clone(&result);
        webview
            .with_webview(move |platform_webview| {
                let pointer = platform_webview.inner();
                if pointer.is_null() {
                    *callback_result.lock().expect("download hook result") =
                        Err("browser download WebView is unavailable".to_string());
                    return;
                }
                let webview = unsafe { &*(pointer as *const WKWebView) };
                MANAGED_WEBVIEWS.with(|webviews| {
                    webviews
                        .borrow_mut()
                        .insert(webview as *const _ as usize, Arc::downgrade(&state));
                });
                let Some(delegate) = (unsafe { webview.navigationDelegate() }) else {
                    *callback_result.lock().expect("download hook result") =
                        Err("browser download navigation delegate is unavailable".to_string());
                    return;
                };
                let class =
                    unsafe { objc2::ffi::object_getClass(Retained::as_ptr(&delegate).cast()) };
                if class.is_null() {
                    *callback_result.lock().expect("download hook result") = Err(
                        "browser download navigation delegate class is unavailable".to_string(),
                    );
                    return;
                }
                let class = class as *mut AnyClass;
                if HOOKED_CLASSES.with(|classes| classes.borrow().contains(&(class as usize))) {
                    return;
                }
                unsafe {
                    let action_selector = sel!(webView:navigationAction:didBecomeDownload:);
                    let response_selector = sel!(webView:navigationResponse:didBecomeDownload:);
                    let originals =
                        method_implementation(class, action_selector).and_then(|action| {
                            method_implementation(class, response_selector)
                                .map(|response| (action, response))
                        });
                    let (original_action, original_response) = match originals {
                        Ok(originals) => originals,
                        Err(error) => {
                            *callback_result.lock().expect("download hook result") = Err(error);
                            return;
                        }
                    };
                    objc2::ffi::class_replaceMethod(
                        class,
                        action_selector,
                        std::mem::transmute::<*const (), Imp>(action_hook as *const ()),
                        c"v@:@@@".as_ptr(),
                    );
                    objc2::ffi::class_replaceMethod(
                        class,
                        response_selector,
                        std::mem::transmute::<*const (), Imp>(response_hook as *const ()),
                        c"v@:@@@".as_ptr(),
                    );
                    ORIGINAL_ACTIONS
                        .with(|values| values.borrow_mut().insert(class as usize, original_action));
                    ORIGINAL_RESPONSES.with(|values| {
                        values
                            .borrow_mut()
                            .insert(class as usize, original_response)
                    });
                    HOOKED_CLASSES.with(|classes| classes.borrow_mut().insert(class as usize));
                }
            })
            .map_err(|error| error.to_string())?;
        Arc::try_unwrap(result)
            .map_err(|_| "browser download hook callback did not finish".to_string())?
            .into_inner()
            .map_err(|_| "browser download hook result is unavailable".to_string())?
    }

    pub(crate) fn bind_pending_download(
        state: &Arc<Mutex<NativeDownloadState>>,
        pending: &PendingNativeDownload,
    ) {
        let already_bound = DOWNLOADS.with(|downloads| {
            downloads
                .borrow()
                .iter()
                .any(|entry| entry.native_download_id.as_deref() == Some(&pending.id))
        });
        if already_bound {
            return;
        }
        let has_unbound_handle = DOWNLOADS.with(|downloads| {
            downloads
                .borrow()
                .iter()
                .any(|entry| entry.url == pending.url && entry.native_download_id.is_none())
        });
        if !has_unbound_handle {
            return;
        }
        let claimed = state.lock().ok().and_then(|mut downloads| {
            super::super::claim_pending_download_for_url(&mut downloads, &pending.url)
        });
        let Some(claimed) = claimed else { return };
        DOWNLOADS.with(|downloads| {
            let mut downloads = downloads.borrow_mut();
            prune(&mut downloads);
            if let Some(entry) = downloads
                .iter_mut()
                .find(|entry| entry.url == pending.url && entry.native_download_id.is_none())
            {
                entry.native_download_id = Some(claimed.id);
            }
        });
    }

    pub(crate) fn forget(native_download_id: &str) {
        DOWNLOADS.with(|downloads| {
            downloads
                .borrow_mut()
                .retain(|entry| entry.native_download_id.as_deref() != Some(native_download_id));
        });
    }

    pub(crate) async fn cancel(
        app: &AppHandle,
        _state: &Arc<Mutex<NativeDownloadState>>,
        native_download_id: &str,
    ) -> Result<bool, String> {
        let native_download_id = native_download_id.to_string();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let canceled = DOWNLOADS.with(|downloads| {
                let mut downloads = downloads.borrow_mut();
                prune(&mut downloads);
                let index = downloads.iter().position(|entry| {
                    entry.native_download_id.as_deref() == Some(&native_download_id)
                });
                index
                    .and_then(|index| downloads.remove(index))
                    .map(|entry| {
                        unsafe { entry.download.cancel(None) };
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
}

#[cfg(target_os = "macos")]
pub(super) use platform::{attach, bind_pending_download, cancel, forget};

#[cfg(not(target_os = "macos"))]
pub(super) fn attach(
    _webview: &tauri::Webview,
    _state: std::sync::Arc<std::sync::Mutex<super::NativeDownloadState>>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn bind_pending_download(
    _state: &std::sync::Arc<std::sync::Mutex<super::NativeDownloadState>>,
    _pending: &super::PendingNativeDownload,
) {
}

#[cfg(not(target_os = "macos"))]
pub(super) fn forget(_native_download_id: &str) {}

#[cfg(not(target_os = "macos"))]
pub(super) async fn cancel(
    _app: &tauri::AppHandle,
    _state: &std::sync::Arc<std::sync::Mutex<super::NativeDownloadState>>,
    _native_download_id: &str,
) -> Result<bool, String> {
    Ok(false)
}
