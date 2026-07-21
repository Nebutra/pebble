use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime, WebviewWindow, Window};

#[derive(Default)]
pub struct LaunchWindowReveal {
    revealed: AtomicBool,
}

impl LaunchWindowReveal {
    pub fn reveal_once<R: Runtime>(&self, window: &WebviewWindow<R>) -> bool {
        if self.revealed.load(Ordering::Acquire) {
            return false;
        }
        restore_and_focus(window);
        self.revealed.store(true, Ordering::Release);
        true
    }
}

pub fn schedule_launch_reveal_fallback(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1_500));
        let main_thread_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(window) = webview_window(&main_thread_app) else {
                return;
            };
            let is_visible = window.is_visible().unwrap_or(false);
            if !is_visible {
                // Why: a failed page-load reveal otherwise leaves a healthy host running
                // without any visible window or a way for the user to recover it.
                restore_and_focus(&window);
                crate::window_chrome::promote_launch_window(&window);
            }
        });
    });
}

pub fn is_evidence_shell() -> bool {
    std::env::var_os("PEBBLE_PARITY_CAPTURE_PATH").is_some()
        || std::env::var_os("PEBBLE_FUNCTIONAL_GATE_REPO_PATH").is_some()
        || std::env::var_os("PEBBLE_REAL_RUNTIME_GATE").is_some()
}

pub fn window<R: Runtime>(app: &AppHandle<R>) -> Option<Window<R>> {
    // Why: optimized/dev configurations intentionally use descriptive labels;
    // native features must attach to the configured shell, not a literal name.
    app.get_window("main")
        .or_else(|| app.windows().into_values().next())
}

pub fn webview_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next())
}

pub fn restore_and_focus<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    // A minimized window still counts as visible on macOS, so every activation
    // path must unminimize before show/focus instead of branching on visibility.
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    // Why: AppKit can leave a successfully unminimized window in the Dock layer
    // until the process is activated and its NSWindow becomes key.
    crate::window_chrome::promote_launch_window(window)
}
