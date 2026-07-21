use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct NativeQuitState {
    pending: AtomicBool,
    permit_next_exit: AtomicBool,
}

pub fn handle_exit_requested(app: &tauri::AppHandle, api: &tauri::ExitRequestApi) {
    if consume_native_termination_permit(app) {
        return;
    }
    api.prevent_exit();
    request_from_native_source(app);
}

pub fn request_from_native_source(app: &tauri::AppHandle) {
    record_native_source_request(app);
    let _ = app.emit("pebble://native-quit-requested", ());
}

#[cfg(target_os = "macos")]
pub fn request_from_macos_termination(app: &tauri::AppHandle) {
    record_native_source_request(app);
    let app = app.clone();
    std::thread::spawn(move || {
        // Why: AppKit does not deliver a WebView event while its termination
        // delegate is still deciding whether the process may exit.
        std::thread::sleep(std::time::Duration::from_millis(10));
        let _ = app.emit("pebble://native-quit-requested", ());
        let dispatch_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = crate::primary_window::webview_window(&dispatch_app) {
                if window
                    .eval("window.__PEBBLE_REQUEST_APP_QUIT__?.()")
                    .is_ok()
                {
                    let _ = crate::commands::native_session_recovery::record_stage(
                        &dispatch_app,
                        "native-quit-dispatched",
                    );
                }
            }
        });
    });
}

fn record_native_source_request(app: &tauri::AppHandle) {
    let state = app.state::<NativeQuitState>();
    let _ = crate::commands::native_session_recovery::mark_native_quit_requested(app);
    state.pending.store(true, Ordering::Release);
}

pub fn consume_native_termination_permit(app: &tauri::AppHandle) -> bool {
    app.state::<NativeQuitState>()
        .permit_next_exit
        .swap(false, Ordering::AcqRel)
}

pub fn permit_next_exit(app: &tauri::AppHandle) {
    let state = app.state::<NativeQuitState>();
    state.pending.store(false, Ordering::Release);
    state.permit_next_exit.store(true, Ordering::Release);
}

#[tauri::command]
pub fn native_quit_take_pending(state: tauri::State<'_, NativeQuitState>) -> bool {
    state.pending.swap(false, Ordering::AcqRel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_quit_is_consumed_once() {
        let state = NativeQuitState::default();
        state.pending.store(true, Ordering::Release);
        assert!(state.pending.swap(false, Ordering::AcqRel));
        assert!(!state.pending.swap(false, Ordering::AcqRel));
    }
}
