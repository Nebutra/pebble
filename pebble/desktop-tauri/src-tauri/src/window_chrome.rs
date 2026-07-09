//! Window-chrome parity with the Electron shell (createMainWindow.ts): a
//! theme-aware window background color and macOS traffic-light placement.

use tauri::window::Color;
use tauri::{Theme, WebviewWindow};

// Electron paints the window backing before webview paint so a dark theme never
// flashes white at launch (createMainWindow.ts:260). Match those two values.
const DARK_BACKGROUND: Color = Color(0x0a, 0x0a, 0x0a, 0xff);
const LIGHT_BACKGROUND: Color = Color(0xff, 0xff, 0xff, 0xff);

/// Applies the launch background color and (on macOS) the traffic-light inset.
/// Called from the Tauri setup hook so it runs before the webview first paints.
pub fn apply_window_chrome(window: &WebviewWindow) {
    let is_dark = matches!(window.theme(), Ok(Theme::Dark));
    let background = if is_dark {
        DARK_BACKGROUND
    } else {
        LIGHT_BACKGROUND
    };
    // Best-effort: a failure here only costs the anti-flash color, not startup.
    let _ = window.set_background_color(Some(background));

    #[cfg(target_os = "macos")]
    macos::apply_traffic_light_inset(window);
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2_app_kit::{NSWindow, NSWindowButton};
    use objc2_foundation::NSRect;
    use tauri::{WebviewWindow, WindowEvent};

    // Electron places the traffic lights at x=TRAFFIC_LIGHT_X (16) and
    // y=TITLEBAR_CSS_CENTER-TRAFFIC_LIGHT_RADIUS (18-6=12) so they sit centered
    // in the 36px custom titlebar (createMainWindow.ts:85-87,280-287).
    const TRAFFIC_LIGHT_X: f64 = 16.0;
    const TRAFFIC_LIGHT_Y: f64 = 12.0;

    pub fn apply_traffic_light_inset(window: &WebviewWindow) {
        inset_now(window);
        // Overlay/hiddenInset restores the native button frames on every resize,
        // so re-apply — Electron re-syncs dynamically too (syncTrafficLightPosition).
        let handle = window.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Resized(_)) {
                inset_now(&handle);
            }
        });
    }

    fn inset_now(window: &WebviewWindow) {
        let Ok(ptr) = window.ns_window() else {
            return;
        };
        if ptr.is_null() {
            return;
        }
        // Safety: Tauri returns a live NSWindow* for this webview window, and
        // window events + setup run on the AppKit main thread.
        let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        unsafe { inset_traffic_lights(ns_window, TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y) };
    }

    // Ported from tao's inset_traffic_lights (view.rs): resize the title-bar
    // container to (button height + y) and lay the three buttons out from x.
    unsafe fn inset_traffic_lights(window: &NSWindow, x: f64, y: f64) {
        let (Some(close), Some(miniaturize), Some(zoom)) = (
            window.standardWindowButton(NSWindowButton::CloseButton),
            window.standardWindowButton(NSWindowButton::MiniaturizeButton),
            window.standardWindowButton(NSWindowButton::ZoomButton),
        ) else {
            return;
        };

        let Some(container) = close.superview().and_then(|parent| parent.superview()) else {
            return;
        };

        let close_rect: NSRect = close.frame();
        let title_bar_height = close_rect.size.height + y;
        let mut container_rect: NSRect = container.frame();
        container_rect.size.height = title_bar_height;
        container_rect.origin.y = window.frame().size.height - title_bar_height;
        container.setFrame(container_rect);

        let space_between = miniaturize.frame().origin.x - close_rect.origin.x;
        for (i, button) in [close, miniaturize, zoom].into_iter().enumerate() {
            let mut rect = button.frame();
            rect.origin.x = x + (i as f64) * space_between;
            button.setFrameOrigin(rect.origin);
        }
    }
}
