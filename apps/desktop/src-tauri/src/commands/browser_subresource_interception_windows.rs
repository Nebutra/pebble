#[cfg(target_os = "windows")]
use std::sync::Arc;

use tauri::Webview;

#[cfg(target_os = "windows")]
use super::super::browser_navigation_interception::NativeBrowserInterceptDecision;
use super::super::browser_navigation_interception::NativeBrowserNavigationInterceptionState;
#[cfg(target_os = "windows")]
use super::super::browser_request_control::{
    BrowserRequestDecision, NativeBrowserRequestControlState, REQUEST_DECISION_TIMEOUT,
};

#[cfg(target_os = "windows")]
pub(super) fn attach(
    webview: &Webview,
    browser_tab_id: String,
    state: NativeBrowserNavigationInterceptionState,
    request_control: NativeBrowserRequestControlState,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
    };
    use webview2_com::WebResourceRequestedEventHandler;
    use windows::core::{HSTRING, PWSTR};

    webview
        .with_webview(move |platform_webview| {
            let controller = platform_webview.controller();
            let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
                return;
            };
            let environment = platform_webview.environment();
            let state = Arc::new(state);
            let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
                unsafe { args.ResourceContext(&mut context)? };
                if context == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT {
                    return Ok(());
                }
                let request = unsafe { args.Request()? };
                let url = read_request_string(|value| unsafe { request.Uri(value) })?;
                let method = read_request_string(|value| unsafe { request.Method(value) })?;
                let Some(decision) = state.intercept_resource(
                    &browser_tab_id,
                    &url,
                    &method,
                    resource_context_name(context),
                    false,
                ) else {
                    return Ok(());
                };
                if matches!(decision, NativeBrowserInterceptDecision::Pause) {
                    let frame_id = format!("{browser_tab_id}:webview");
                    let Ok((record, receiver)) = request_control.pause(
                        &browser_tab_id,
                        frame_id,
                        url,
                        method,
                        std::collections::HashMap::new(),
                        resource_context_name(context).to_string(),
                    ) else {
                        return Ok(());
                    };
                    let deferral = unsafe { args.GetDeferral()? };
                    let args = args.clone();
                    let environment = environment.clone();
                    let timeout_state = request_control.clone();
                    std::thread::spawn(move || {
                        let decision = receiver.recv_timeout(REQUEST_DECISION_TIMEOUT);
                        match decision {
                            Ok(BrowserRequestDecision::Continue) => {}
                            Ok(decision) => {
                                if let Ok(response) =
                                    create_request_control_response(&environment, decision)
                                {
                                    let _ = unsafe { args.SetResponse(&response) };
                                }
                            }
                            Err(_) => timeout_state.finish_timeout(&record.request_id),
                        }
                        let _ = unsafe { deferral.Complete() };
                    });
                    return Ok(());
                }
                let response = create_intercept_response(&environment, decision)?;
                unsafe { args.SetResponse(&response)? };
                Ok(())
            }));
            let mut token = 0;
            let _ = unsafe {
                core.AddWebResourceRequestedFilter(
                    &HSTRING::from("*"),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                )
            };
            let _ = unsafe { core.add_WebResourceRequested(&handler, &mut token) };
        })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn create_request_control_response(
    environment: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
    decision: BrowserRequestDecision,
) -> windows::core::Result<
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebResourceResponse,
> {
    match decision {
        BrowserRequestDecision::Continue => unreachable!("continue does not create a response"),
        BrowserRequestDecision::Fulfill {
            body,
            status,
            headers,
        } => create_response(environment, body, status, "Fulfilled by Pebble", headers),
        BrowserRequestDecision::Fail { reason } => create_response(
            environment,
            Vec::new(),
            502,
            &reason,
            std::collections::HashMap::from([
                ("Cache-Control".to_string(), "no-store".to_string()),
                ("X-Pebble-Request-Failure".to_string(), "true".to_string()),
            ]),
        ),
    }
}

#[cfg(target_os = "windows")]
fn create_response(
    environment: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
    body: Vec<u8>,
    status: u16,
    reason: &str,
    mut headers: std::collections::HashMap<String, String>,
) -> windows::core::Result<
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebResourceResponse,
> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::STREAM_SEEK_SET;

    let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true)? };
    let mut written = 0;
    unsafe {
        stream
            .Write(body.as_ptr().cast(), body.len() as u32, Some(&mut written))
            .ok()?;
        stream.Seek(0, STREAM_SEEK_SET, None)?;
    }
    headers.insert("Content-Length".to_string(), body.len().to_string());
    headers
        .entry("Cache-Control".to_string())
        .or_insert_with(|| "no-store".to_string());
    let headers = headers
        .into_iter()
        .map(|(name, value)| format!("{name}: {value}"))
        .collect::<Vec<_>>()
        .join("\r\n");
    unsafe {
        environment.CreateWebResourceResponse(
            Some(&stream),
            i32::from(status),
            &HSTRING::from(reason),
            &HSTRING::from(headers),
        )
    }
}

#[cfg(target_os = "windows")]
fn create_intercept_response(
    environment: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
    decision: NativeBrowserInterceptDecision,
) -> windows::core::Result<
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebResourceResponse,
> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};

    let (stream, status, reason, headers) = match decision {
        NativeBrowserInterceptDecision::Abort => (
            None,
            403,
            "Blocked by Pebble".to_string(),
            "Content-Length: 0\r\nCache-Control: no-store".to_string(),
        ),
        NativeBrowserInterceptDecision::Fulfill {
            body,
            status,
            content_type,
        } => {
            let bytes = body.into_bytes();
            let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true)? };
            let mut written = 0;
            unsafe {
                stream
                    .Write(
                        bytes.as_ptr().cast(),
                        bytes.len() as u32,
                        Some(&mut written),
                    )
                    .ok()?;
                stream.Seek(0, STREAM_SEEK_SET, None)?;
            }
            (
                Some(stream),
                i32::from(status),
                "Fulfilled by Pebble".to_string(),
                format!(
                    "Content-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store",
                    bytes.len()
                ),
            )
        }
    };
    unsafe {
        environment.CreateWebResourceResponse(
            stream.as_ref(),
            status,
            &HSTRING::from(reason),
            &HSTRING::from(headers),
        )
    }
}

#[cfg(target_os = "windows")]
fn read_request_string(
    read: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>,
) -> windows::core::Result<String> {
    let mut value = PWSTR::null();
    read(&mut value)?;
    Ok(webview2_com::take_pwstr(value))
}

#[cfg(target_os = "windows")]
fn resource_context_name(
    context: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT,
) -> &'static str {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    match context {
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "media",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH => "fetch",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST => "xhr",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MANIFEST => "manifest",
        _ => "other",
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn attach(
    _webview: &Webview,
    _browser_tab_id: String,
    _state: NativeBrowserNavigationInterceptionState,
    _request_control: super::super::browser_request_control::NativeBrowserRequestControlState,
) -> Result<(), String> {
    Ok(())
}
