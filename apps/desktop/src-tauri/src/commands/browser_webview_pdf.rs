#[cfg(target_os = "macos")]
pub(super) fn capture_platform_pdf(
    platform_webview: tauri::webview::PlatformWebview,
    sender: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
) {
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex};

    use block2::RcBlock;
    use objc2_foundation::{NSData, NSError};
    use objc2_web_kit::WKWebView;

    let pointer = platform_webview.inner();
    if pointer.is_null() {
        let _ = sender.send(Err("browser WKWebView pointer is null".to_string()));
        return;
    }
    // Why: WKWebView owns and invokes a copied completion block asynchronously;
    // only copied PDF bytes cross back into Rust after the AppKit callback.
    let sender = Arc::new(Mutex::new(Some(sender)));
    let completion_sender = sender.clone();
    let completion = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
        let send = |result| {
            if let Some(sender) = completion_sender
                .lock()
                .ok()
                .and_then(|mut value| value.take())
            {
                let _ = sender.send(result);
            }
        };
        if !error.is_null() {
            send(Err("WKWebView PDF capture failed".to_string()));
            return;
        }
        let Some(data) = (unsafe { data.as_ref() }) else {
            send(Err("WKWebView returned no PDF data".to_string()));
            return;
        };
        let length = data.length();
        let mut bytes = vec![0_u8; length];
        if length > 0 {
            let Some(destination) = NonNull::new(bytes.as_mut_ptr().cast::<c_void>()) else {
                send(Err("browser PDF buffer allocation failed".to_string()));
                return;
            };
            unsafe { data.getBytes_length(destination, length) };
        }
        send(Ok(bytes));
    });
    let webview = unsafe { &*(pointer as *const WKWebView) };
    unsafe { webview.createPDFWithConfiguration_completionHandler(None, &completion) };
}

#[cfg(target_os = "windows")]
pub(super) fn capture_platform_pdf(
    platform_webview: tauri::webview::PlatformWebview,
    sender: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
) {
    use std::sync::mpsc;

    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_7;
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING, PCWSTR};

    let result = (|| {
        let controller = platform_webview.controller();
        let webview = unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
        let webview7: ICoreWebView2_7 = webview.cast().map_err(|error| error.to_string())?;
        let path =
            std::env::temp_dir().join(format!("pebble-browser-{}.pdf", uuid::Uuid::new_v4()));
        let wide_path = HSTRING::from(path.to_string_lossy().as_ref());
        let callback_path = path.clone();
        let (completion_sender, completion_receiver) = mpsc::channel();
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |completed| {
            let result = completed
                .map_err(|error| error.to_string())
                .and_then(|success| {
                    if !success.as_bool() {
                        return Err("WebView2 PDF capture was not completed".to_string());
                    }
                    let bytes = std::fs::read(&callback_path).map_err(|error| error.to_string());
                    let _ = std::fs::remove_file(&callback_path);
                    bytes
                });
            let _ = completion_sender.send(result);
            Ok(())
        }));
        // Why: WebView2 writes atomically to the requested path; a unique file
        // avoids exposing an application-controlled overwrite destination.
        unsafe { webview7.PrintToPdf(PCWSTR(wide_path.as_ptr()), None, &handler) }
            .map_err(|error| error.to_string())?;
        let captured =
            webview2_com::wait_with_pump(completion_receiver).map_err(|error| error.to_string())?;
        if captured.is_err() {
            let _ = std::fs::remove_file(path);
        }
        captured
    })();
    let _ = sender.send(result);
}

#[cfg(target_os = "linux")]
pub(super) fn capture_platform_pdf(
    platform_webview: tauri::webview::PlatformWebview,
    sender: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
) {
    use std::sync::{Arc, Mutex};

    use gio::prelude::FileExt;
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    let path = std::env::temp_dir().join(format!("pebble-browser-{}.pdf", uuid::Uuid::new_v4()));
    let file_uri = gio::File::for_path(&path).uri();
    let settings = gtk::PrintSettings::new();
    settings.set(gtk::PRINT_SETTINGS_PRINTER, Some("Print to File"));
    settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
    settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(file_uri.as_str()));
    let operation = PrintOperation::new(&platform_webview.inner());
    operation.set_print_settings(&settings);

    // Why: WebKit can report failure and completion for the same operation;
    // only the first terminal signal may consume the oneshot sender.
    let sender = Arc::new(Mutex::new(Some(sender)));
    let failed_sender = sender.clone();
    let failed_path = path.clone();
    operation.connect_failed(move |_, error| {
        let _ = std::fs::remove_file(&failed_path);
        if let Some(sender) = failed_sender.lock().ok().and_then(|mut value| value.take()) {
            let _ = sender.send(Err(error.to_string()));
        }
    });
    operation.connect_finished(move |_| {
        let result = std::fs::read(&path).map_err(|error| error.to_string());
        let _ = std::fs::remove_file(&path);
        if let Some(sender) = sender.lock().ok().and_then(|mut value| value.take()) {
            let _ = sender.send(result);
        }
    });
    operation.print();
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub(super) fn capture_platform_pdf(
    _platform_webview: tauri::webview::PlatformWebview,
    sender: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
) {
    let _ = sender.send(Err(
        "native browser PDF capture is not available on this platform yet".to_string(),
    ));
}
