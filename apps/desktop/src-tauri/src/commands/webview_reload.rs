use tauri::WebviewWindow;

#[tauri::command]
pub fn webview_reload(window: WebviewWindow, ignore_cache: bool) -> Result<(), String> {
    if ignore_cache {
        // Why: Electron's force reload invalidates cached renderer resources;
        // Tauri otherwise exposes only a normal location reload to JavaScript.
        window
            .clear_all_browsing_data()
            .map_err(|error| format!("Could not clear Pebble webview data: {error}"))?;
    }
    window
        .eval("window.location.reload()")
        .map_err(|error| format!("Could not reload Pebble: {error}"))
}

#[tauri::command]
#[cfg(debug_assertions)]
pub fn webview_toggle_devtools(window: WebviewWindow) -> bool {
    if window.is_devtools_open() {
        window.close_devtools();
        false
    } else {
        window.open_devtools();
        true
    }
}

#[tauri::command]
#[cfg(not(debug_assertions))]
pub fn webview_toggle_devtools(_window: WebviewWindow) -> bool {
    // Why: Tauri intentionally removes DevTools methods from release builds;
    // keep the menu contract callable without making production uncompilable.
    false
}
