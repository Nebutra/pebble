#![cfg(target_os = "macos")]

use std::{
    ffi::c_void,
    sync::atomic::{AtomicPtr, Ordering},
    sync::OnceLock,
};

use objc2::{
    rc::Retained,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel, MainThreadMarker,
};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
static ORIGINAL_TERMINATION_HANDLER: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

type TerminationHandler =
    unsafe extern "C-unwind" fn(&AnyObject, Sel, &NSApplication) -> NSApplicationTerminateReply;

unsafe extern "C-unwind" fn application_should_terminate(
    delegate: &AnyObject,
    selector: Sel,
    sender: &NSApplication,
) -> NSApplicationTerminateReply {
    let Some(app) = APP_HANDLE.get() else {
        return NSApplicationTerminateReply::TerminateCancel;
    };
    if crate::native_quit::consume_native_termination_permit(app) {
        let original = ORIGINAL_TERMINATION_HANDLER.load(Ordering::Acquire);
        if !original.is_null() {
            let original: TerminationHandler = unsafe { std::mem::transmute(original) };
            return unsafe { original(delegate, selector, sender) };
        }
        return NSApplicationTerminateReply::TerminateNow;
    }
    crate::native_quit::request_from_macos_termination(app);
    NSApplicationTerminateReply::TerminateCancel
}

pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
    APP_HANDLE
        .set(app.clone())
        .map_err(|_| "macOS native quit guard was installed twice".to_string())?;
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "macOS native quit guard must install on the main thread".to_string())?;
    let application = NSApplication::sharedApplication(mtm);
    let delegate = application
        .delegate()
        .ok_or_else(|| "macOS application delegate is unavailable".to_string())?;
    let class = unsafe { objc2::ffi::object_getClass(Retained::as_ptr(&delegate).cast()) };
    if class.is_null() {
        return Err("macOS application delegate class is unavailable".to_string());
    }
    let selector = sel!(applicationShouldTerminate:);
    let method = unsafe { objc2::ffi::class_getInstanceMethod(class, selector) };
    let hook =
        unsafe { std::mem::transmute::<*const (), Imp>(application_should_terminate as *const ()) };
    if method.is_null() {
        let added = unsafe {
            objc2::ffi::class_addMethod(class as *mut AnyClass, selector, hook, c"Q@:@".as_ptr())
        };
        return added.as_bool().then_some(()).ok_or_else(|| {
            "macOS application termination guard could not be installed".to_string()
        });
    }
    let original = (unsafe { objc2::ffi::method_getImplementation(method) })
        .ok_or_else(|| "macOS application termination handler is unavailable".to_string())?;
    ORIGINAL_TERMINATION_HANDLER.store(original as *mut c_void, Ordering::Release);
    unsafe {
        objc2::ffi::class_replaceMethod(class as *mut AnyClass, selector, hook, c"Q@:@".as_ptr());
    }
    Ok(())
}
