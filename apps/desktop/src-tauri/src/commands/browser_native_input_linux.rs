use std::{ffi::CString, ptr};

use glib::translate::{IntoGlib, ToGlibPtr, ToGlibPtrMut};
use gtk::{gdk, prelude::*};

use super::{
    linux_button_number, linux_drag_points, linux_keyval, linux_modifier_mask,
    BrowserInputModifier, BrowserKeyPhase, BrowserMouseButtonPhase, BrowserNativeInputAction,
    LINUX_BUTTON1_MASK, LINUX_CONTROL_MASK,
};

pub(super) fn dispatch_platform_input(
    platform_webview: tauri::webview::PlatformWebview,
    action: &BrowserNativeInputAction,
) -> Result<(), String> {
    let webview = platform_webview.inner();
    let window = webview
        .window()
        .ok_or_else(|| "browser WebKitGTK widget is not realized".to_string())?;
    webview.grab_focus();
    match action {
        BrowserNativeInputAction::MouseMove { x, y, modifiers } => {
            dispatch_motion(&webview, &window, *x, *y, linux_modifier_mask(modifiers))
        }
        BrowserNativeInputAction::MouseButton {
            phase,
            button,
            x: Some(x),
            y: Some(y),
            click_count,
            modifiers,
        } => dispatch_button(
            &webview,
            &window,
            *phase,
            linux_button_number(*button),
            *x,
            *y,
            *click_count,
            linux_modifier_mask(modifiers),
        ),
        BrowserNativeInputAction::MouseButton { .. } => {
            Err("browser mouse coordinates were not resolved".to_string())
        }
        BrowserNativeInputAction::MouseWheel {
            delta_x,
            delta_y,
            x: Some(x),
            y: Some(y),
            modifiers,
        } => dispatch_scroll(
            &webview,
            &window,
            *x,
            *y,
            *delta_x,
            *delta_y,
            linux_modifier_mask(modifiers),
        ),
        BrowserNativeInputAction::MouseWheel { .. } => {
            Err("browser wheel coordinates were not resolved".to_string())
        }
        BrowserNativeInputAction::MouseDrag {
            from_x,
            from_y,
            to_x,
            to_y,
            steps,
            modifiers,
        } => dispatch_drag(
            &webview,
            &window,
            (*from_x, *from_y),
            (*to_x, *to_y),
            *steps,
            modifiers,
        ),
        BrowserNativeInputAction::TextInput { text, replace } => {
            dispatch_text(&webview, &window, text, *replace)
        }
        BrowserNativeInputAction::Key {
            phase,
            key,
            modifiers,
        } => dispatch_key(
            &webview,
            &window,
            *phase,
            key,
            linux_modifier_mask(modifiers),
        ),
    }
}

fn dispatch_drag(
    webview: &webkit2gtk::WebView,
    window: &gdk::Window,
    from: (f64, f64),
    to: (f64, f64),
    steps: u8,
    modifiers: &[BrowserInputModifier],
) -> Result<(), String> {
    let modifier_mask = linux_modifier_mask(modifiers);
    dispatch_button(
        webview,
        window,
        BrowserMouseButtonPhase::Down,
        1,
        from.0,
        from.1,
        1,
        modifier_mask,
    )?;
    for (x, y) in linux_drag_points(from, to, steps) {
        dispatch_motion(webview, window, x, y, modifier_mask | LINUX_BUTTON1_MASK)?;
    }
    dispatch_button(
        webview,
        window,
        BrowserMouseButtonPhase::Up,
        1,
        to.0,
        to.1,
        1,
        modifier_mask | LINUX_BUTTON1_MASK,
    )
}

fn dispatch_text(
    webview: &webkit2gtk::WebView,
    window: &gdk::Window,
    text: &str,
    replace: bool,
) -> Result<(), String> {
    if replace {
        dispatch_key(
            webview,
            window,
            BrowserKeyPhase::Press,
            "a",
            LINUX_CONTROL_MASK,
        )?;
    }
    for character in text.chars() {
        dispatch_key(
            webview,
            window,
            BrowserKeyPhase::Press,
            &character.to_string(),
            0,
        )?;
    }
    Ok(())
}

fn dispatch_key(
    webview: &webkit2gtk::WebView,
    window: &gdk::Window,
    phase: BrowserKeyPhase,
    key: &str,
    modifiers: u32,
) -> Result<(), String> {
    let keyval = linux_keyval(key)
        .ok_or_else(|| format!("browser native key is unsupported on Linux: {key}"))?;
    match phase {
        BrowserKeyPhase::Down => dispatch_key_event(webview, window, true, keyval, modifiers),
        BrowserKeyPhase::Up => dispatch_key_event(webview, window, false, keyval, modifiers),
        BrowserKeyPhase::Press => {
            dispatch_key_event(webview, window, true, keyval, modifiers)?;
            dispatch_key_event(webview, window, false, keyval, modifiers)
        }
    }
}

fn dispatch_motion(
    webview: &webkit2gtk::WebView,
    window: &gdk::Window,
    x: f64,
    y: f64,
    modifiers: u32,
) -> Result<(), String> {
    ensure_point_in_webview(webview, x, y)?;
    let mut event = gdk::Event::new(gdk::EventType::MotionNotify);
    let (root_x, root_y) = root_point(window, x, y);
    unsafe {
        let raw = event.to_glib_none_mut().0 as *mut gdk::ffi::GdkEventMotion;
        (*raw).window = window.to_glib_full();
        (*raw).send_event = 1;
        (*raw).x = x;
        (*raw).y = y;
        (*raw).state = modifiers;
        (*raw).x_root = root_x;
        (*raw).y_root = root_y;
    }
    deliver(webview, &event)
}

#[allow(clippy::too_many_arguments)]
fn dispatch_button(
    webview: &webkit2gtk::WebView,
    window: &gdk::Window,
    phase: BrowserMouseButtonPhase,
    button: u32,
    x: f64,
    y: f64,
    click_count: u8,
    modifiers: u32,
) -> Result<(), String> {
    ensure_point_in_webview(webview, x, y)?;
    let event_type = match (phase, click_count) {
        (BrowserMouseButtonPhase::Down, 2) => gdk::EventType::DoubleButtonPress,
        (BrowserMouseButtonPhase::Down, 3) => gdk::EventType::TripleButtonPress,
        (BrowserMouseButtonPhase::Down, _) => gdk::EventType::ButtonPress,
        (BrowserMouseButtonPhase::Up, _) => gdk::EventType::ButtonRelease,
    };
    let mut event = gdk::Event::new(event_type);
    let (root_x, root_y) = root_point(window, x, y);
    unsafe {
        let raw = event.to_glib_none_mut().0 as *mut gdk::ffi::GdkEventButton;
        (*raw).window = window.to_glib_full();
        (*raw).send_event = 1;
        (*raw).x = x;
        (*raw).y = y;
        (*raw).state = modifiers;
        (*raw).button = button;
        (*raw).x_root = root_x;
        (*raw).y_root = root_y;
    }
    deliver(webview, &event)
}

#[allow(clippy::too_many_arguments)]
fn dispatch_scroll(
    webview: &webkit2gtk::WebView,
    window: &gdk::Window,
    x: f64,
    y: f64,
    delta_x: f64,
    delta_y: f64,
    modifiers: u32,
) -> Result<(), String> {
    ensure_point_in_webview(webview, x, y)?;
    let mut event = gdk::Event::new(gdk::EventType::Scroll);
    let (root_x, root_y) = root_point(window, x, y);
    unsafe {
        let raw = event.to_glib_none_mut().0 as *mut gdk::ffi::GdkEventScroll;
        (*raw).window = window.to_glib_full();
        (*raw).send_event = 1;
        (*raw).x = x;
        (*raw).y = y;
        (*raw).state = modifiers;
        (*raw).direction = gdk::ScrollDirection::Smooth.into_glib();
        (*raw).x_root = root_x;
        (*raw).y_root = root_y;
        (*raw).delta_x = delta_x;
        (*raw).delta_y = delta_y;
    }
    deliver(webview, &event)
}

fn dispatch_key_event(
    webview: &webkit2gtk::WebView,
    window: &gdk::Window,
    pressed: bool,
    keyval: u32,
    modifiers: u32,
) -> Result<(), String> {
    let event_type = if pressed {
        gdk::EventType::KeyPress
    } else {
        gdk::EventType::KeyRelease
    };
    let mut event = gdk::Event::new(event_type);
    let text = gdk::keys::Key::from(keyval)
        .to_unicode()
        .filter(|character| !character.is_control())
        .and_then(|character| CString::new(character.to_string()).ok());
    unsafe {
        let raw = event.to_glib_none_mut().0 as *mut gdk::ffi::GdkEventKey;
        (*raw).window = window.to_glib_full();
        (*raw).send_event = 1;
        (*raw).state = modifiers;
        (*raw).keyval = keyval;
        if let Some(text) = text {
            (*raw).length = text.as_bytes().len() as i32;
            (*raw).string = glib::ffi::g_strdup(text.as_ptr());
        } else {
            (*raw).length = 0;
            (*raw).string = ptr::null_mut();
        }
    }
    deliver(webview, &event)
}

fn ensure_point_in_webview(webview: &webkit2gtk::WebView, x: f64, y: f64) -> Result<(), String> {
    if x > f64::from(webview.allocated_width()) || y > f64::from(webview.allocated_height()) {
        return Err("browser native input point is outside the WebView".to_string());
    }
    Ok(())
}

fn root_point(window: &gdk::Window, x: f64, y: f64) -> (f64, f64) {
    let (_, origin_x, origin_y) = window.origin();
    (f64::from(origin_x) + x, f64::from(origin_y) + y)
}

fn deliver(webview: &webkit2gtk::WebView, event: &gdk::Event) -> Result<(), String> {
    // Why: gtk_widget_event routes the trusted GDK event through WebKitGTK's
    // normal widget, IM, gesture, and editing handlers without DOM synthesis.
    let _ = webview.event(event);
    Ok(())
}
