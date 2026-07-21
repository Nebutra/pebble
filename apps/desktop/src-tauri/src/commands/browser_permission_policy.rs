use tauri::{AppHandle, Webview};

use super::browser_permission_overrides::BrowserPermissionDecision;
use super::browser_permission_overrides::NativeBrowserPermissionOverrideRegistry;

#[cfg(any(test, target_os = "linux", target_os = "windows"))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BrowserPermissionKind {
    ClipboardRead,
    DisplayMedia,
    Geolocation,
    Media,
    Notifications,
    PersistentStorage,
    Unknown,
}

#[cfg(any(test, target_os = "linux", target_os = "windows"))]
fn default_permission_decision(kind: BrowserPermissionKind) -> BrowserPermissionDecision {
    match kind {
        BrowserPermissionKind::ClipboardRead
        | BrowserPermissionKind::Notifications
        | BrowserPermissionKind::PersistentStorage => BrowserPermissionDecision::Allow,
        BrowserPermissionKind::DisplayMedia
        | BrowserPermissionKind::Geolocation
        | BrowserPermissionKind::Media
        | BrowserPermissionKind::Unknown => BrowserPermissionDecision::Deny,
    }
}

#[cfg(any(test, target_os = "linux", target_os = "windows"))]
fn permission_name(kind: BrowserPermissionKind) -> Option<&'static str> {
    match kind {
        BrowserPermissionKind::ClipboardRead => Some("clipboard-read"),
        BrowserPermissionKind::DisplayMedia => Some("display-capture"),
        BrowserPermissionKind::Geolocation => Some("geolocation"),
        BrowserPermissionKind::Media => Some("media"),
        BrowserPermissionKind::Notifications => Some("notifications"),
        BrowserPermissionKind::PersistentStorage => Some("persistent-storage"),
        BrowserPermissionKind::Unknown => None,
    }
}

pub(super) fn attach(
    webview: &Webview,
    app: AppHandle,
    browser_tab_id: String,
    profile_id: String,
    overrides: NativeBrowserPermissionOverrideRegistry,
) -> Result<(), String> {
    platform::attach(webview, app, browser_tab_id, profile_id, overrides)
}

#[cfg(target_os = "linux")]
mod platform {
    use glib::{prelude::Cast, translate::ToGlibPtr};
    use tauri::{AppHandle, Webview};
    use webkit2gtk::{
        DeviceInfoPermissionRequest, GeolocationPermissionRequest, NotificationPermissionRequest,
        PermissionRequest, PermissionRequestExt, UserMediaPermissionRequest, WebViewExt,
        WebsiteDataAccessPermissionRequest,
    };

    use super::{
        default_permission_decision, permission_name, BrowserPermissionDecision,
        BrowserPermissionKind, NativeBrowserPermissionOverrideRegistry,
    };

    pub(super) fn attach(
        webview: &Webview,
        app: AppHandle,
        browser_tab_id: String,
        profile_id: String,
        overrides: NativeBrowserPermissionOverrideRegistry,
    ) -> Result<(), String> {
        webview
            .with_webview(move |platform_webview| {
                platform_webview
                    .inner()
                    .connect_permission_request(move |webview, request| {
                        let kind = classify_permission(request);
                        let raw_origin = webview.uri().unwrap_or_else(|| "unknown".into());
                        let decision = permission_name(kind)
                            .and_then(|name| overrides.decision(&profile_id, &raw_origin, name))
                            .unwrap_or_else(|| default_permission_decision(kind));
                        match decision {
                            BrowserPermissionDecision::Allow => request.allow(),
                            BrowserPermissionDecision::Deny => {
                                request.deny();
                                super::super::emit_browser_permission_denied(
                                    &app,
                                    &browser_tab_id,
                                    permission_name(kind).unwrap_or("unknown"),
                                    &raw_origin,
                                );
                            }
                        }
                        true
                    });
            })
            .map_err(|error| error.to_string())
    }

    fn classify_permission(request: &PermissionRequest) -> BrowserPermissionKind {
        if let Some(media) = request.dynamic_cast_ref::<UserMediaPermissionRequest>() {
            let is_display = unsafe {
                webkit2gtk::ffi::webkit_user_media_permission_is_for_display_device(
                    media.to_glib_none().0,
                ) != 0
            };
            return if is_display {
                BrowserPermissionKind::DisplayMedia
            } else {
                BrowserPermissionKind::Media
            };
        }
        if request
            .dynamic_cast_ref::<NotificationPermissionRequest>()
            .is_some()
        {
            return BrowserPermissionKind::Notifications;
        }
        if request
            .dynamic_cast_ref::<WebsiteDataAccessPermissionRequest>()
            .is_some()
        {
            return BrowserPermissionKind::PersistentStorage;
        }
        if request
            .dynamic_cast_ref::<DeviceInfoPermissionRequest>()
            .is_some()
        {
            return BrowserPermissionKind::Media;
        }
        if request
            .dynamic_cast_ref::<GeolocationPermissionRequest>()
            .is_some()
        {
            return BrowserPermissionKind::Geolocation;
        }
        BrowserPermissionKind::Unknown
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use tauri::{AppHandle, Webview};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::PermissionRequestedEventHandler;
    use windows::core::PWSTR;

    use super::{
        default_permission_decision, permission_name, BrowserPermissionDecision,
        BrowserPermissionKind, NativeBrowserPermissionOverrideRegistry,
    };

    pub(super) fn attach(
        webview: &Webview,
        app: AppHandle,
        browser_tab_id: String,
        profile_id: String,
        overrides: NativeBrowserPermissionOverrideRegistry,
    ) -> Result<(), String> {
        webview
            .with_webview(move |platform_webview| {
                let controller = platform_webview.controller();
                let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
                    return;
                };
                let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut native_kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                    unsafe { args.PermissionKind(&mut native_kind)? };
                    let kind = classify_permission(native_kind);
                    let raw_origin =
                        read_permission_uri(&args).unwrap_or_else(|| "unknown".to_string());
                    let decision = permission_name(kind)
                        .and_then(|name| overrides.decision(&profile_id, &raw_origin, name))
                        .unwrap_or_else(|| default_permission_decision(kind));
                    let state = match decision {
                        BrowserPermissionDecision::Allow => COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                        BrowserPermissionDecision::Deny => {
                            super::super::emit_browser_permission_denied(
                                &app,
                                &browser_tab_id,
                                permission_name(kind).unwrap_or("unknown"),
                                &raw_origin,
                            );
                            COREWEBVIEW2_PERMISSION_STATE_DENY
                        }
                    };
                    unsafe { args.SetState(state)? };
                    Ok(())
                }));
                let mut token = 0_i64;
                let _ = unsafe { core.add_PermissionRequested(&handler, &mut token) };
            })
            .map_err(|error| error.to_string())
    }

    fn classify_permission(kind: COREWEBVIEW2_PERMISSION_KIND) -> BrowserPermissionKind {
        match kind {
            COREWEBVIEW2_PERMISSION_KIND_CAMERA | COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => {
                BrowserPermissionKind::Media
            }
            COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ => BrowserPermissionKind::ClipboardRead,
            COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS => BrowserPermissionKind::Notifications,
            COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION => BrowserPermissionKind::Geolocation,
            _ => BrowserPermissionKind::Unknown,
        }
    }
    fn read_permission_uri(args: &ICoreWebView2PermissionRequestedEventArgs) -> Option<String> {
        let mut value = PWSTR::null();
        unsafe { args.Uri(&mut value).ok()? };
        Some(webview2_com::take_pwstr(value))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use block2::DynBlock;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{rc::Retained, sel};
    use objc2_web_kit::{
        WKFrameInfo, WKMediaCaptureType, WKPermissionDecision, WKSecurityOrigin, WKWebView,
    };
    use tauri::{AppHandle, Webview};

    use super::{BrowserPermissionDecision, NativeBrowserPermissionOverrideRegistry};

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum MediaPermissionResponse {
        Grant,
        Deny,
        Prompt,
    }

    fn resolve_media_permission_response(
        decision: Option<BrowserPermissionDecision>,
    ) -> MediaPermissionResponse {
        match decision {
            Some(BrowserPermissionDecision::Allow) => MediaPermissionResponse::Grant,
            Some(BrowserPermissionDecision::Deny) => MediaPermissionResponse::Deny,
            // Why: an absent or reset per-origin decision belongs to WebKit's
            // native prompt; denying here made first-use grants impossible.
            None => MediaPermissionResponse::Prompt,
        }
    }

    #[derive(Clone)]
    struct PermissionContext {
        app: AppHandle,
        browser_tab_id: String,
        profile_id: String,
        overrides: NativeBrowserPermissionOverrideRegistry,
    }

    thread_local! {
        static MANAGED_WEBVIEWS: RefCell<HashMap<usize, PermissionContext>> = RefCell::new(HashMap::new());
        static ORIGINAL_IMPLEMENTATIONS: RefCell<HashMap<usize, Imp>> = RefCell::new(HashMap::new());
    }

    unsafe extern "C-unwind" fn media_permission_hook(
        delegate: &AnyObject,
        selector: Sel,
        webview: &WKWebView,
        origin: &WKSecurityOrigin,
        frame: &WKFrameInfo,
        capture_type: WKMediaCaptureType,
        handler: &DynBlock<dyn Fn(WKPermissionDecision)>,
    ) {
        let context = MANAGED_WEBVIEWS.with(|webviews| {
            webviews
                .borrow()
                .get(&(webview as *const _ as usize))
                .cloned()
        });
        let Some(context) = context else {
            forward_original(
                delegate,
                selector,
                webview,
                origin,
                frame,
                capture_type,
                handler,
            );
            return;
        };
        let raw_origin = security_origin(origin);
        match resolve_media_permission_response(context.overrides.decision(
            &context.profile_id,
            &raw_origin,
            "media",
        )) {
            MediaPermissionResponse::Grant => handler.call((WKPermissionDecision::Grant,)),
            MediaPermissionResponse::Prompt => handler.call((WKPermissionDecision::Prompt,)),
            MediaPermissionResponse::Deny => {
                handler.call((WKPermissionDecision::Deny,));
                super::super::emit_browser_permission_denied(
                    &context.app,
                    &context.browser_tab_id,
                    "media",
                    &raw_origin,
                );
            }
        }
    }

    unsafe fn forward_original(
        delegate: &AnyObject,
        selector: Sel,
        webview: &WKWebView,
        origin: &WKSecurityOrigin,
        frame: &WKFrameInfo,
        capture_type: WKMediaCaptureType,
        handler: &DynBlock<dyn Fn(WKPermissionDecision)>,
    ) {
        let class = unsafe { objc2::ffi::object_getClass(delegate) };
        let implementation = ORIGINAL_IMPLEMENTATIONS
            .with(|entries| entries.borrow().get(&(class as usize)).copied());
        if let Some(implementation) = implementation {
            let original: unsafe extern "C-unwind" fn(
                &AnyObject,
                Sel,
                &WKWebView,
                &WKSecurityOrigin,
                &WKFrameInfo,
                WKMediaCaptureType,
                &DynBlock<dyn Fn(WKPermissionDecision)>,
            ) = unsafe { std::mem::transmute(implementation) };
            unsafe {
                original(
                    delegate,
                    selector,
                    webview,
                    origin,
                    frame,
                    capture_type,
                    handler,
                )
            };
        } else {
            handler.call((WKPermissionDecision::Deny,));
        }
    }

    fn security_origin(origin: &WKSecurityOrigin) -> String {
        let scheme = unsafe { origin.protocol() }.to_string();
        let host = unsafe { origin.host() }.to_string();
        let port = unsafe { origin.port() };
        if port > 0 {
            format!("{scheme}://{host}:{port}")
        } else {
            format!("{scheme}://{host}")
        }
    }

    pub(super) fn attach(
        webview: &Webview,
        app: AppHandle,
        browser_tab_id: String,
        profile_id: String,
        overrides: NativeBrowserPermissionOverrideRegistry,
    ) -> Result<(), String> {
        webview
            .with_webview(move |platform_webview| {
                let pointer = platform_webview.inner();
                if pointer.is_null() {
                    return;
                }
                let native_webview = unsafe { &*(pointer as *const WKWebView) };
                let Some(delegate) = (unsafe { native_webview.UIDelegate() }) else {
                    return;
                };
                let delegate_pointer = Retained::as_ptr(&delegate).cast::<AnyObject>();
                let class = unsafe { objc2::ffi::object_getClass(delegate_pointer) };
                if class.is_null() {
                    return;
                }
                install_hook(class);
                // Why: the Wry delegate class is shared with the app webview;
                // only registered browser children may consume persisted grants.
                MANAGED_WEBVIEWS.with(|webviews| {
                    webviews.borrow_mut().insert(
                        pointer as usize,
                        PermissionContext {
                            app,
                            browser_tab_id,
                            profile_id,
                            overrides,
                        },
                    );
                });
            })
            .map_err(|error| error.to_string())
    }

    fn install_hook(class: *const AnyClass) {
        let class_key = class as usize;
        let already_hooked =
            ORIGINAL_IMPLEMENTATIONS.with(|entries| entries.borrow().contains_key(&class_key));
        if already_hooked {
            return;
        }
        let selector = sel!(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:);
        let method = unsafe { objc2::ffi::class_getInstanceMethod(class, selector) };
        if method.is_null() {
            return;
        }
        let Some(original) = (unsafe { objc2::ffi::method_getImplementation(method) }) else {
            return;
        };
        let encoding = unsafe { objc2::ffi::method_getTypeEncoding(method) };
        unsafe {
            objc2::ffi::class_replaceMethod(
                class.cast_mut(),
                selector,
                std::mem::transmute::<*const (), Imp>(media_permission_hook as *const ()),
                encoding,
            );
        }
        ORIGINAL_IMPLEMENTATIONS.with(|entries| {
            entries.borrow_mut().insert(class_key, original);
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn preserves_explicit_origin_overrides_and_prompts_when_unset() {
            assert_eq!(
                resolve_media_permission_response(Some(BrowserPermissionDecision::Allow)),
                MediaPermissionResponse::Grant
            );
            assert_eq!(
                resolve_media_permission_response(Some(BrowserPermissionDecision::Deny)),
                MediaPermissionResponse::Deny
            );
            assert_eq!(
                resolve_media_permission_response(None),
                MediaPermissionResponse::Prompt
            );
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod platform {
    use tauri::{AppHandle, Webview};

    pub(super) fn attach(
        _webview: &Webview,
        _app: AppHandle,
        _browser_tab_id: String,
        _profile_id: String,
        _overrides: super::NativeBrowserPermissionOverrideRegistry,
    ) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_low_risk_auto_granted_browser_permissions() {
        for permission in [
            BrowserPermissionKind::ClipboardRead,
            BrowserPermissionKind::Notifications,
            BrowserPermissionKind::PersistentStorage,
        ] {
            assert_eq!(
                default_permission_decision(permission),
                BrowserPermissionDecision::Allow
            );
        }
    }

    #[test]
    fn denies_media_display_capture_geolocation_and_unknown_permissions() {
        for permission in [
            BrowserPermissionKind::Media,
            BrowserPermissionKind::DisplayMedia,
            BrowserPermissionKind::Geolocation,
            BrowserPermissionKind::Unknown,
        ] {
            assert_eq!(
                default_permission_decision(permission),
                BrowserPermissionDecision::Deny
            );
        }
    }

    #[test]
    fn permission_names_match_persisted_override_vocabulary() {
        assert_eq!(permission_name(BrowserPermissionKind::Media), Some("media"));
        assert_eq!(
            permission_name(BrowserPermissionKind::ClipboardRead),
            Some("clipboard-read")
        );
        assert_eq!(permission_name(BrowserPermissionKind::Unknown), None);
    }
}
