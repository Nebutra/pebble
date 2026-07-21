#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};
    use std::ffi::CStr;

    use block2::{DynBlock, RcBlock};
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{rc::Retained, sel};
    use objc2_foundation::NSString;
    use objc2_web_kit::{WKFrameInfo, WKWebView};

    enum PendingDialog {
        Alert(RcBlock<dyn Fn()>),
        Confirm(RcBlock<dyn Fn(objc2::runtime::Bool)>),
        Prompt(RcBlock<dyn Fn(*mut NSString)>),
    }

    thread_local! {
        static MANAGED_WEBVIEWS: RefCell<HashSet<usize>> = RefCell::new(HashSet::new());
        static PENDING_DIALOGS: RefCell<HashMap<usize, PendingDialog>> = RefCell::new(HashMap::new());
        static HOOKED_CLASSES: RefCell<HashSet<usize>> = RefCell::new(HashSet::new());
    }

    fn is_managed(webview: &WKWebView) -> bool {
        MANAGED_WEBVIEWS.with(|managed| managed.borrow().contains(&(webview as *const _ as usize)))
    }

    fn replace_pending(key: usize, pending: PendingDialog) {
        PENDING_DIALOGS.with(|dialogs| {
            if let Some(previous) = dialogs.borrow_mut().insert(key, pending) {
                dismiss(previous);
            }
        });
    }

    fn dismiss(dialog: PendingDialog) {
        match dialog {
            PendingDialog::Alert(handler) => handler.call(()),
            PendingDialog::Confirm(handler) => handler.call((objc2::runtime::Bool::NO,)),
            PendingDialog::Prompt(handler) => handler.call((std::ptr::null_mut(),)),
        }
    }

    unsafe extern "C-unwind" fn alert_hook(
        _delegate: &AnyObject,
        _selector: Sel,
        webview: &WKWebView,
        _message: &NSString,
        _frame: &WKFrameInfo,
        handler: &DynBlock<dyn Fn()>,
    ) {
        if !is_managed(webview) {
            handler.call(());
            return;
        }
        replace_pending(
            webview as *const _ as usize,
            PendingDialog::Alert(handler.copy()),
        );
    }

    unsafe extern "C-unwind" fn confirm_hook(
        _delegate: &AnyObject,
        _selector: Sel,
        webview: &WKWebView,
        _message: &NSString,
        _frame: &WKFrameInfo,
        handler: &DynBlock<dyn Fn(objc2::runtime::Bool)>,
    ) {
        if !is_managed(webview) {
            handler.call((objc2::runtime::Bool::NO,));
            return;
        }
        replace_pending(
            webview as *const _ as usize,
            PendingDialog::Confirm(handler.copy()),
        );
    }

    unsafe extern "C-unwind" fn prompt_hook(
        _delegate: &AnyObject,
        _selector: Sel,
        webview: &WKWebView,
        _prompt: &NSString,
        _default_text: *mut NSString,
        _frame: &WKFrameInfo,
        handler: &DynBlock<dyn Fn(*mut NSString)>,
    ) {
        if !is_managed(webview) {
            handler.call((std::ptr::null_mut(),));
            return;
        }
        replace_pending(
            webview as *const _ as usize,
            PendingDialog::Prompt(handler.copy()),
        );
    }

    unsafe fn add_method(
        class: *mut AnyClass,
        selector: Sel,
        implementation: Imp,
        encoding: &'static CStr,
    ) -> Result<(), String> {
        if unsafe {
            objc2::ffi::class_addMethod(class, selector, implementation, encoding.as_ptr())
        }
        .as_bool()
        {
            Ok(())
        } else {
            Err(format!(
                "could not install browser dialog selector {selector}"
            ))
        }
    }

    pub fn attach(platform_webview: tauri::webview::PlatformWebview) -> Result<(), String> {
        let pointer = platform_webview.inner();
        if pointer.is_null() {
            return Err("browser WKWebView pointer is null".to_string());
        }
        let webview = unsafe { &*(pointer as *const WKWebView) };
        let delegate = unsafe { webview.UIDelegate() }
            .ok_or_else(|| "browser WKWebView UI delegate is unavailable".to_string())?;
        let delegate_pointer = Retained::as_ptr(&delegate).cast::<AnyObject>();
        let class = unsafe { objc2::ffi::object_getClass(delegate_pointer) };
        if class.is_null() {
            return Err("browser WKWebView UI delegate class is unavailable".to_string());
        }
        let class_key = class as *const _ as usize;
        let needs_hook = HOOKED_CLASSES.with(|classes| classes.borrow_mut().insert(class_key));
        if needs_hook {
            let class = class as *mut AnyClass;
            unsafe {
                add_method(
                    class,
                    sel!(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:),
                    std::mem::transmute::<*const (), Imp>(alert_hook as *const ()),
                    c"v@:@@@@?",
                )?;
                add_method(
                    class,
                    sel!(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:),
                    std::mem::transmute::<*const (), Imp>(confirm_hook as *const ()),
                    c"v@:@@@@?",
                )?;
                add_method(
                    class,
                    sel!(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:),
                    std::mem::transmute::<*const (), Imp>(prompt_hook as *const ()),
                    c"v@:@@@@@?",
                )?;
            }
        }
        MANAGED_WEBVIEWS.with(|managed| {
            managed.borrow_mut().insert(pointer as usize);
        });
        Ok(())
    }

    pub fn resolve(
        platform_webview: tauri::webview::PlatformWebview,
        accept: bool,
        text: Option<String>,
    ) -> Result<bool, String> {
        let pointer = platform_webview.inner();
        if pointer.is_null() {
            return Err("browser WKWebView pointer is null".to_string());
        }
        let pending =
            PENDING_DIALOGS.with(|dialogs| dialogs.borrow_mut().remove(&(pointer as usize)));
        let Some(pending) = pending else {
            return Ok(false);
        };
        match pending {
            PendingDialog::Alert(handler) => handler.call(()),
            PendingDialog::Confirm(handler) => handler.call((accept.into(),)),
            PendingDialog::Prompt(handler) => {
                if accept {
                    let value = NSString::from_str(text.as_deref().unwrap_or(""));
                    handler.call((Retained::as_ptr(&value).cast_mut(),));
                } else {
                    handler.call((std::ptr::null_mut(),));
                }
            }
        }
        Ok(true)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use webkit2gtk::{ScriptDialog, ScriptDialogType, WebViewExt};

    thread_local! {
        static PENDING_DIALOGS: RefCell<HashMap<usize, ScriptDialog>> = RefCell::new(HashMap::new());
    }

    pub fn attach(platform_webview: tauri::webview::PlatformWebview) -> Result<(), String> {
        let webview = platform_webview.inner();
        let key = webview.as_ptr() as usize;
        webview.connect_script_dialog(move |_, dialog| {
            PENDING_DIALOGS.with(|dialogs| {
                if let Some(previous) = dialogs.borrow_mut().insert(key, dialog.clone()) {
                    previous.close();
                }
            });
            true
        });
        Ok(())
    }

    pub fn resolve(
        platform_webview: tauri::webview::PlatformWebview,
        accept: bool,
        text: Option<String>,
    ) -> Result<bool, String> {
        let key = platform_webview.inner().as_ptr() as usize;
        let pending = PENDING_DIALOGS.with(|dialogs| dialogs.borrow_mut().remove(&key));
        let Some(dialog) = pending else {
            return Ok(false);
        };
        if accept {
            match dialog.dialog_type() {
                ScriptDialogType::Confirm => dialog.confirm_set_confirmed(true),
                ScriptDialogType::Prompt => dialog.prompt_set_text(text.as_deref().unwrap_or("")),
                _ => {}
            }
        }
        dialog.close();
        Ok(true)
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Deferral, ICoreWebView2ScriptDialogOpeningEventArgs,
    };
    use webview2_com::ScriptDialogOpeningEventHandler;
    use windows::core::{Interface, HSTRING, PCWSTR};

    struct PendingDialog {
        args: ICoreWebView2ScriptDialogOpeningEventArgs,
        deferral: ICoreWebView2Deferral,
    }

    fn pending_dialogs() -> &'static Mutex<HashMap<usize, PendingDialog>> {
        static PENDING: OnceLock<Mutex<HashMap<usize, PendingDialog>>> = OnceLock::new();
        PENDING.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub fn attach(platform_webview: tauri::webview::PlatformWebview) -> Result<(), String> {
        let controller = platform_webview.controller();
        let webview = unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
        let key = Interface::as_raw(&webview) as usize;
        let handler = ScriptDialogOpeningEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let deferral = unsafe { args.GetDeferral()? };
            if let Some(previous) = pending_dialogs()
                .lock()
                .expect("browser dialog registry poisoned")
                .insert(key, PendingDialog { args, deferral })
            {
                unsafe { previous.deferral.Complete()? };
            }
            Ok(())
        }));
        let mut token = 0_i64;
        unsafe { webview.add_ScriptDialogOpening(&handler, &mut token) }
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn resolve(
        platform_webview: tauri::webview::PlatformWebview,
        accept: bool,
        text: Option<String>,
    ) -> Result<bool, String> {
        let controller = platform_webview.controller();
        let webview = unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
        let key = Interface::as_raw(&webview) as usize;
        let pending = pending_dialogs()
            .lock()
            .map_err(|_| "browser dialog registry poisoned".to_string())?
            .remove(&key);
        let Some(pending) = pending else {
            return Ok(false);
        };
        if accept {
            if let Some(text) = text {
                let text = HSTRING::from(text);
                unsafe { pending.args.SetResultText(PCWSTR(text.as_ptr())) }
                    .map_err(|error| error.to_string())?;
            }
            unsafe { pending.args.Accept() }.map_err(|error| error.to_string())?;
        }
        unsafe { pending.deferral.Complete() }.map_err(|error| error.to_string())?;
        Ok(true)
    }
}

pub(super) use platform::{attach, resolve};
