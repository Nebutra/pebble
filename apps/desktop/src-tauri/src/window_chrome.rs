//! Window-chrome parity with the Electron shell (createMainWindow.ts): a
//! theme-aware window background color and macOS traffic-light placement.

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

use tauri::window::Color;
use tauri::{Manager, State, Theme, WebviewWindow};

// Electron paints the window backing before webview paint so a dark theme never
// flashes white at launch (createMainWindow.ts:260). Match those two values.
const DARK_BACKGROUND: Color = Color(0x0a, 0x0a, 0x0a, 0xff);
const LIGHT_BACKGROUND: Color = Color(0xff, 0xff, 0xff, 0xff);

struct WindowChromeInner {
    zoom_factor_bits: AtomicU64,
    traffic_light_listener_installed: AtomicBool,
}

#[derive(Clone)]
pub struct WindowChromeState {
    inner: Arc<WindowChromeInner>,
}

impl Default for WindowChromeState {
    fn default() -> Self {
        Self {
            inner: Arc::new(WindowChromeInner {
                zoom_factor_bits: AtomicU64::new(1.0_f64.to_bits()),
                traffic_light_listener_installed: AtomicBool::new(false),
            }),
        }
    }
}

impl WindowChromeState {
    fn zoom_factor(&self) -> f64 {
        f64::from_bits(self.inner.zoom_factor_bits.load(Ordering::Relaxed))
    }

    fn set_zoom_factor(&self, zoom_factor: f64) -> Result<(), String> {
        if !zoom_factor.is_finite() || zoom_factor <= 0.0 {
            return Err("zoom factor must be finite and positive".to_owned());
        }
        self.inner
            .zoom_factor_bits
            .store(zoom_factor.to_bits(), Ordering::Relaxed);
        Ok(())
    }
}

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
    macos::apply_traffic_light_inset(window, window.state::<WindowChromeState>().inner().clone());
}

#[tauri::command]
pub fn window_set_traffic_light_zoom(
    window: WebviewWindow,
    state: State<'_, WindowChromeState>,
    zoom_factor: f64,
) -> Result<(), String> {
    state.set_zoom_factor(zoom_factor)?;
    #[cfg(target_os = "macos")]
    macos::inset_now(&window, state.zoom_factor());
    Ok(())
}

pub fn promote_launch_window<R: tauri::Runtime>(window: &WebviewWindow<R>) -> bool {
    #[cfg(target_os = "macos")]
    return macos::promote_launch_window(window);
    #[cfg(not(target_os = "macos"))]
    return window.set_focus().is_ok();
}

pub fn minimize_window<R: tauri::Runtime>(window: &WebviewWindow<R>) -> bool {
    #[cfg(target_os = "macos")]
    return macos::minimize_window(window);
    #[cfg(not(target_os = "macos"))]
    return window.minimize().is_ok();
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::atomic::Ordering;

    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApp, NSWindow, NSWindowButton};
    use objc2_foundation::NSRect;
    use tauri::{Runtime, WebviewWindow, WindowEvent};

    use super::WindowChromeState;

    const TITLEBAR_HEIGHT: f64 = 36.0;
    const TRAFFIC_LIGHT_HEIGHT: f64 = 12.0;
    const TRAFFIC_LIGHT_X: f64 = 16.0;

    pub fn apply_traffic_light_inset(window: &WebviewWindow, state: WindowChromeState) {
        inset_now(
            window,
            f64::from_bits(state.inner.zoom_factor_bits.load(Ordering::Relaxed)),
        );
        if state
            .inner
            .traffic_light_listener_installed
            .swap(true, Ordering::Relaxed)
        {
            return;
        }
        // Overlay/hiddenInset restores the native button frames on every resize,
        // so re-apply — Electron re-syncs dynamically too (syncTrafficLightPosition).
        let handle = window.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Resized(_)) {
                inset_now(
                    &handle,
                    f64::from_bits(state.inner.zoom_factor_bits.load(Ordering::Relaxed)),
                );
            }
        });
    }

    pub fn promote_launch_window<R: Runtime>(window: &WebviewWindow<R>) -> bool {
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        let Some(ns_window) = ns_window(window) else {
            return false;
        };
        let app = NSApp(mtm);
        // Required when Tauri dev launches the raw binary instead of a .app.
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);
        app.activate();
        // Why: Tauri's cross-platform unminimize is queued; AppKit cannot make
        // the window key until deminiaturization happens in this main-thread turn.
        ns_window.deminiaturize(None);
        ns_window.orderFrontRegardless();
        ns_window.makeKeyAndOrderFront(None);
        app.activate();
        // Child WebViews may own key status while their containing app window
        // remains AppKit's main interactive window.
        ns_window.isKeyWindow() || ns_window.isMainWindow()
    }

    pub fn minimize_window<R: Runtime>(window: &WebviewWindow<R>) -> bool {
        let Some(ns_window) = ns_window(window) else {
            return false;
        };
        ns_window.miniaturize(None);
        ns_window.isMiniaturized()
    }

    pub fn inset_now(window: &WebviewWindow, zoom_factor: f64) {
        let Some(ns_window) = ns_window(window) else {
            return;
        };
        unsafe {
            inset_traffic_lights(
                ns_window,
                TRAFFIC_LIGHT_X,
                traffic_light_inset_y(zoom_factor),
            )
        };
    }

    // Tao's inset is the extra height above a 12px button. Matching the zoomed
    // 36px CSS titlebar therefore requires (36 * zoom - 12) native points.
    fn traffic_light_inset_y(zoom_factor: f64) -> f64 {
        (TITLEBAR_HEIGHT * zoom_factor - TRAFFIC_LIGHT_HEIGHT).max(0.0)
    }

    fn ns_window<R: Runtime>(window: &WebviewWindow<R>) -> Option<&NSWindow> {
        let Ok(ptr) = window.ns_window() else {
            return None;
        };
        if ptr.is_null() {
            return None;
        }
        // Safety: Tauri returns a live NSWindow* for this webview window, and
        // launch/window event handling runs on the AppKit main thread.
        Some(unsafe { &*(ptr as *const NSWindow) })
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

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn traffic_light_inset_tracks_renderer_zoom() {
            assert_eq!(traffic_light_inset_y(1.0), 24.0);
            assert!((traffic_light_inset_y(1.2) - 31.2).abs() < 1e-9);
            assert_eq!(traffic_light_inset_y(0.5), 6.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_traffic_light_zoom_factors() {
        let state = WindowChromeState::default();
        assert!(state.set_zoom_factor(0.0).is_err());
        assert!(state.set_zoom_factor(f64::NAN).is_err());
        assert!(state.set_zoom_factor(1.2).is_ok());
        assert_eq!(state.zoom_factor(), 1.2);
    }
}
