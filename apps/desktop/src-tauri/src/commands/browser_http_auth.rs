use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use tauri::{AppHandle, Manager, Webview};

const MAX_AUTH_USER_CHARS: usize = 1024;
const MAX_AUTH_PASSWORD_CHARS: usize = 8 * 1024;

#[derive(Clone)]
struct BrowserCredential {
    user: String,
    password: String,
}

fn credentials() -> &'static Mutex<HashMap<String, BrowserCredential>> {
    static CREDENTIALS: OnceLock<Mutex<HashMap<String, BrowserCredential>>> = OnceLock::new();
    CREDENTIALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn read_credential(label: &str) -> Option<BrowserCredential> {
    credentials().lock().ok()?.get(label).cloned()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHttpAuthSetInput {
    label: String,
    user: String,
    password: String,
}

#[tauri::command]
pub fn browser_child_webview_set_http_auth(
    app: AppHandle,
    input: BrowserHttpAuthSetInput,
) -> Result<serde_json::Value, String> {
    super::browser_child_webview::validate_browser_webview_label(&input.label)?;
    if app.get_webview(&input.label).is_none() {
        return Err("browser WebView is not available".to_string());
    }
    validate_credential_part(&input.user, MAX_AUTH_USER_CHARS, false)?;
    validate_credential_part(&input.password, MAX_AUTH_PASSWORD_CHARS, true)?;
    credentials()
        .lock()
        .map_err(|_| "browser credential registry is unavailable")?
        .insert(
            input.label,
            BrowserCredential {
                user: input.user,
                password: input.password,
            },
        );
    Ok(serde_json::json!({
        "configured": true,
        "scope": "native-http-basic"
    }))
}

#[tauri::command]
pub fn browser_child_webview_clear_http_auth(label: String) -> Result<bool, String> {
    super::browser_child_webview::validate_browser_webview_label(&label)?;
    Ok(credentials()
        .lock()
        .map_err(|_| "browser credential registry is unavailable")?
        .remove(&label)
        .is_some())
}

fn validate_credential_part(
    value: &str,
    max_chars: usize,
    allow_empty: bool,
) -> Result<(), String> {
    let count = value.chars().count();
    if (!allow_empty && count == 0) || count > max_chars || value.contains(['\r', '\n']) {
        return Err("browser credentials are invalid".to_string());
    }
    Ok(())
}

pub(super) fn attach(webview: &Webview, label: String) -> Result<(), String> {
    platform::attach(webview, label)
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{read_credential, BrowserCredential};
    use glib::translate::ToGlibPtr;
    use tauri::Webview;
    use webkit2gtk::{AuthenticationRequestExt, Credential, CredentialPersistence, WebViewExt};

    pub(super) fn attach(webview: &Webview, label: String) -> Result<(), String> {
        webview
            .with_webview(move |platform_webview| {
                platform_webview
                    .inner()
                    .connect_authenticate(move |_webview, request| {
                        let Some(BrowserCredential { user, password }) = read_credential(&label)
                        else {
                            return false;
                        };
                        let credential =
                            Credential::new(&user, &password, CredentialPersistence::None);
                        unsafe {
                            webkit2gtk::ffi::webkit_authentication_request_authenticate(
                                request.to_glib_none().0,
                                credential.to_glib_none().0,
                            );
                        }
                        true
                    });
            })
            .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::read_credential;
    use tauri::Webview;
    use webview2_com::BasicAuthenticationRequestedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_10;
    use windows::core::{Interface, HSTRING};

    pub(super) fn attach(webview: &Webview, label: String) -> Result<(), String> {
        webview
            .with_webview(move |platform_webview| {
                let controller = platform_webview.controller();
                let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
                    return;
                };
                let Ok(core10) = core.cast::<ICoreWebView2_10>() else {
                    return;
                };
                let handler =
                    BasicAuthenticationRequestedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let Some(credential) = read_credential(&label) else {
                            return Ok(());
                        };
                        let response = unsafe { args.Response()? };
                        unsafe {
                            response.SetUserName(&HSTRING::from(credential.user))?;
                            response.SetPassword(&HSTRING::from(credential.password))?;
                        }
                        Ok(())
                    }));
                let mut token = 0;
                let _ = unsafe { core10.add_BasicAuthenticationRequested(&handler, &mut token) };
            })
            .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};

    use block2::DynBlock;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{rc::Retained, sel};
    use objc2_foundation::{
        NSString, NSURLAuthenticationChallenge, NSURLAuthenticationMethodDefault,
        NSURLAuthenticationMethodHTTPBasic, NSURLAuthenticationMethodHTTPDigest, NSURLCredential,
        NSURLCredentialPersistence, NSURLSessionAuthChallengeDisposition,
    };
    use objc2_web_kit::WKWebView;
    use tauri::Webview;

    use super::read_credential;

    thread_local! {
        static LABELS: RefCell<HashMap<usize, String>> = RefCell::new(HashMap::new());
        static HOOKED_CLASSES: RefCell<HashSet<usize>> = RefCell::new(HashSet::new());
        static ORIGINALS: RefCell<HashMap<usize, Imp>> = RefCell::new(HashMap::new());
    }

    unsafe extern "C-unwind" fn challenge_hook(
        delegate: &AnyObject,
        selector: Sel,
        webview: &WKWebView,
        challenge: &NSURLAuthenticationChallenge,
        completion: &DynBlock<dyn Fn(NSURLSessionAuthChallengeDisposition, *mut NSURLCredential)>,
    ) {
        let label = LABELS.with(|labels| {
            labels
                .borrow()
                .get(&(webview as *const _ as usize))
                .cloned()
        });
        let method = challenge.protectionSpace().authenticationMethod();
        let is_http_password = &*method == NSURLAuthenticationMethodDefault
            || &*method == NSURLAuthenticationMethodHTTPBasic
            || &*method == NSURLAuthenticationMethodHTTPDigest;
        if is_http_password {
            if let Some(credential) = label.as_deref().and_then(read_credential) {
                let user = NSString::from_str(&credential.user);
                let password = NSString::from_str(&credential.password);
                let native = NSURLCredential::credentialWithUser_password_persistence(
                    &user,
                    &password,
                    NSURLCredentialPersistence::ForSession,
                );
                completion.call((
                    NSURLSessionAuthChallengeDisposition::UseCredential,
                    Retained::as_ptr(&native).cast_mut(),
                ));
                return;
            }
        }
        let class = unsafe { objc2::ffi::object_getClass(delegate) };
        let original = ORIGINALS.with(|values| values.borrow().get(&(class as usize)).copied());
        if let Some(original) = original {
            let original: unsafe extern "C-unwind" fn(
                &AnyObject,
                Sel,
                &WKWebView,
                &NSURLAuthenticationChallenge,
                &DynBlock<dyn Fn(NSURLSessionAuthChallengeDisposition, *mut NSURLCredential)>,
            ) = unsafe { std::mem::transmute(original) };
            unsafe { original(delegate, selector, webview, challenge, completion) };
        } else {
            completion.call((
                NSURLSessionAuthChallengeDisposition::PerformDefaultHandling,
                std::ptr::null_mut(),
            ));
        }
    }

    pub(super) fn attach(webview: &Webview, label: String) -> Result<(), String> {
        webview
            .with_webview(move |platform_webview| {
                let pointer = platform_webview.inner();
                if pointer.is_null() {
                    return;
                }
                LABELS.with(|labels| labels.borrow_mut().insert(pointer as usize, label));
                let webview = unsafe { &*(pointer as *const WKWebView) };
                let Some(delegate) = (unsafe { webview.navigationDelegate() }) else {
                    return;
                };
                let class =
                    unsafe { objc2::ffi::object_getClass(Retained::as_ptr(&delegate).cast()) };
                if class.is_null()
                    || !HOOKED_CLASSES.with(|classes| classes.borrow_mut().insert(class as usize))
                {
                    return;
                }
                let selector = sel!(webView:didReceiveAuthenticationChallenge:completionHandler:);
                let method = unsafe { objc2::ffi::class_getInstanceMethod(class, selector) };
                let hook =
                    unsafe { std::mem::transmute::<*const (), Imp>(challenge_hook as *const ()) };
                if method.is_null() {
                    unsafe {
                        objc2::ffi::class_addMethod(
                            class as *mut AnyClass,
                            selector,
                            hook,
                            c"v@:@@@?".as_ptr(),
                        );
                    }
                    return;
                }
                if let Some(original) = unsafe { objc2::ffi::method_getImplementation(method) } {
                    unsafe {
                        objc2::ffi::class_replaceMethod(
                            class as *mut AnyClass,
                            selector,
                            hook,
                            c"v@:@@@?".as_ptr(),
                        );
                    }
                    ORIGINALS.with(|values| values.borrow_mut().insert(class as usize, original));
                }
            })
            .map_err(|error| error.to_string())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod platform {
    pub(super) fn attach(_webview: &tauri::Webview, _label: String) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_oversized_and_multiline_credentials() {
        assert!(validate_credential_part("", MAX_AUTH_USER_CHARS, false).is_err());
        assert!(validate_credential_part("", MAX_AUTH_PASSWORD_CHARS, true).is_ok());
        assert!(validate_credential_part("user\nname", MAX_AUTH_USER_CHARS, false).is_err());
        assert!(validate_credential_part(
            &"x".repeat(MAX_AUTH_USER_CHARS + 1),
            MAX_AUTH_USER_CHARS,
            false
        )
        .is_err());
    }
}
