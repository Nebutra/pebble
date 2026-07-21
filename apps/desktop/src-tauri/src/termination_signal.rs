#[cfg(unix)]
mod unix {
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        thread,
        time::Duration,
    };

    static TERMINATION_REQUESTED: AtomicBool = AtomicBool::new(false);

    extern "C" fn request_termination(_signal: libc::c_int) {
        // Why: signal handlers may not lock or write files; the monitor exits
        // through Tauri so normal runtime cleanup and session marking still run.
        TERMINATION_REQUESTED.store(true, Ordering::Release);
    }

    pub fn install(app: tauri::AppHandle) {
        unsafe {
            let handler = request_termination as *const () as libc::sighandler_t;
            libc::signal(libc::SIGTERM, handler);
            libc::signal(libc::SIGINT, handler);
        }
        thread::Builder::new()
            .name("pebble-termination-signal".to_string())
            .spawn(move || loop {
                if TERMINATION_REQUESTED.swap(false, Ordering::AcqRel) {
                    let _ = crate::commands::native_session_recovery::mark_exit_requested(&app);
                    app.exit(0);
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            })
            .expect("failed to start termination signal monitor");
    }
}

#[cfg(unix)]
pub use unix::install;

#[cfg(not(unix))]
pub fn install(_app: tauri::AppHandle) {}
