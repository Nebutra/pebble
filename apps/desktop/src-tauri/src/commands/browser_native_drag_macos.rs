use super::super::BrowserInputModifier;
use super::local_point;
use crate::commands::computer_permissions::computer_use_helper_executable;
use crate::commands::computer_use_action_translation::ComputerActionExecutor;
use crate::commands::computer_use_helper_socket::HelperSocketExecutor;
use objc2_app_kit::NSView;
use serde_json::json;
use tauri::{AppHandle, Manager};

pub(super) async fn dispatch_drag_input(
    app: AppHandle,
    label: &str,
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
    _steps: u8,
    _modifiers: &[BrowserInputModifier],
) -> Result<(), String> {
    let helper = computer_use_helper_executable(&app).ok_or_else(|| {
        "Pebble Computer Use.app is unavailable for trusted browser drag".to_string()
    })?;
    let webview = app
        .get_webview(label)
        .ok_or_else(|| "browser WebView is not available".to_string())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let pointer = platform_webview.inner();
            let result = if pointer.is_null() {
                Err("browser WKWebView pointer is null".to_string())
            } else {
                let view = unsafe { &*(pointer as *const NSView) };
                resolve_window_points(view, from_x, from_y, to_x, to_y)
            };
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    let (from_x, from_y, to_x, to_y) = receiver
        .await
        .map_err(|_| "browser drag coordinate callback was dropped".to_string())??;
    let params = json!({
        "app": std::process::id().to_string(),
        "fromX": from_x,
        "fromY": from_y,
        "toX": to_x,
        "toY": to_y,
    });
    // Why: the signed helper owns macOS input permission; socket I/O and AX
    // snapshot validation must never block Tauri's main AppKit thread.
    tauri::async_runtime::spawn_blocking(move || {
        let mut executor = HelperSocketExecutor::new(helper);
        executor
            .call("drag", &params)
            .map(|_| ())
            .map_err(|failure| failure.typed_message())
    })
    .await
    .map_err(|error| format!("trusted browser drag worker failed: {error}"))?
}

fn resolve_window_points(
    view: &NSView,
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
) -> Result<(f64, f64, f64, f64), String> {
    let bounds = view.bounds();
    for (x, y) in [(from_x, from_y), (to_x, to_y)] {
        if x > bounds.size.width || y > bounds.size.height {
            return Err("browser native drag point is outside the WebView".to_string());
        }
    }
    let window = view
        .window()
        .ok_or_else(|| "browser WebView is not attached to a window".to_string())?;
    let frame = window.frame();
    let relative = |x, y| {
        let point = view.convertPoint_toView(local_point(view, x, y), None);
        let screen = window.convertPointToScreen(point);
        (
            screen.x - frame.origin.x,
            frame.origin.y + frame.size.height - screen.y,
        )
    };
    let from = relative(from_x, from_y);
    let to = relative(to_x, to_y);
    Ok((from.0, from.1, to.0, to.1))
}
