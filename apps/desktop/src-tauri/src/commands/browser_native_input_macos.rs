use std::time::Duration;

use objc2::{msg_send, runtime::AnyObject, sel, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSScreen,
    NSStandardKeyBindingResponding, NSView,
};
use objc2_core_graphics::{CGEvent, CGEventField, CGEventFlags, CGScrollEventUnit};
use objc2_foundation::{NSObjectProtocol, NSPoint, NSString};
use tauri::{AppHandle, Manager};

use super::{
    BrowserInputModifier, BrowserMouseButton, BrowserMouseButtonPhase, BrowserNativeInputAction,
};

#[path = "browser_native_drag_macos.rs"]
mod drag_input;
#[path = "browser_native_key_macos.rs"]
mod key_input;

pub(super) async fn dispatch_platform_input_after_yield(
    app: AppHandle,
    label: String,
    action: BrowserNativeInputAction,
) -> Result<(), String> {
    // Why: yielding lets the originating WebView finish its invoke turn before
    // AppKit posts input, without relying on throttled renderer timers.
    tokio::time::sleep(Duration::from_millis(16)).await;
    if let BrowserNativeInputAction::MouseDrag {
        from_x,
        from_y,
        to_x,
        to_y,
        steps,
        modifiers,
    } = &action
    {
        return drag_input::dispatch_drag_input(
            app, &label, *from_x, *from_y, *to_x, *to_y, *steps, modifiers,
        )
        .await;
    }
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser WebView is not available".to_string())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let _ = sender.send(dispatch_platform_input(platform_webview, &action));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "browser native input callback was dropped".to_string())?
}

pub(super) fn dispatch_platform_input(
    platform_webview: tauri::webview::PlatformWebview,
    action: &BrowserNativeInputAction,
) -> Result<(), String> {
    let pointer = platform_webview.inner();
    if pointer.is_null() {
        return Err("browser WKWebView pointer is null".to_string());
    }
    // Why: this callback runs on AppKit's thread while Tauri owns the WKWebView;
    // retaining native responder objects beyond it would make input racy.
    let view = unsafe { &*(pointer as *const NSView) };
    if let BrowserNativeInputAction::TextInput { text, replace } = action {
        let window = view
            .window()
            .ok_or_else(|| "browser WebView is not attached to a window".to_string())?;
        let responder = window
            .firstResponder()
            .ok_or_else(|| "browser WebView has no focused responder".to_string())?;
        let text = NSString::from_str(text);
        // Why: using the focused AppKit responder preserves WebKit's editing,
        // composition, and framework input handlers instead of mutating the DOM.
        unsafe {
            if *replace {
                responder.selectAll(None);
            }
            responder.insertText(&text);
        }
        return Ok(());
    }
    if let BrowserNativeInputAction::Key {
        phase,
        key,
        modifiers,
    } = action
    {
        return key_input::dispatch_key_input(view, *phase, key, modifiers);
    }
    if let BrowserNativeInputAction::MouseWheel {
        delta_x,
        delta_y,
        x: Some(x),
        y: Some(y),
        modifiers,
    } = action
    {
        let bounds = view.bounds();
        if *x > bounds.size.width || *y > bounds.size.height {
            return Err("browser native input point is outside the WebView".to_string());
        }
        let local = local_point(view, *x, *y);
        let location = view.convertPoint_toView(local, None);
        let window = view
            .window()
            .ok_or_else(|| "browser WebView is not attached to a window".to_string())?;
        // Why: CoreGraphics is the only local API that preserves pixel-level,
        // two-axis wheel deltas before AppKit hands the event to WebKit.
        let cg_event = CGEvent::new_scroll_wheel_event2(
            None,
            CGScrollEventUnit::Pixel,
            2,
            (-delta_y.round()) as i32,
            delta_x.round() as i32,
            0,
        )
        .ok_or_else(|| "AppKit could not create a browser wheel event".to_string())?;
        CGEvent::set_flags(Some(&cg_event), cg_modifier_flags(modifiers));
        let window_number = window.windowNumber() as i64;
        CGEvent::set_integer_value_field(
            Some(&cg_event),
            CGEventField::MouseEventWindowUnderMousePointer,
            window_number,
        );
        CGEvent::set_integer_value_field(
            Some(&cg_event),
            CGEventField::MouseEventWindowUnderMousePointerThatCanHandleThisEvent,
            window_number,
        );
        let location_on_screen = window.convertPointToScreen(location);
        let mtm = MainThreadMarker::new().expect("AppKit callback");
        let primary_screen = NSScreen::screens(mtm)
            .firstObject()
            .ok_or_else(|| "AppKit could not resolve the primary screen".to_string())?;
        CGEvent::set_location(
            Some(&cg_event),
            NSPoint::new(
                location_on_screen.x,
                primary_screen.frame().size.height - location_on_screen.y,
            ),
        );
        NSApplication::sharedApplication(mtm).activate();
        window.makeKeyAndOrderFront(None);
        if !window.makeFirstResponder(Some(view)) {
            return Err("browser WebView could not become first responder".to_string());
        }
        let event = NSEvent::eventWithCGEvent(&cg_event)
            .ok_or_else(|| "AppKit could not create a browser wheel event".to_string())?;
        let relative_selector = sel!(_eventRelativeToWindow:);
        if !event.respondsToSelector(relative_selector) {
            return Err("AppKit cannot bind browser wheel events to a window".to_string());
        }
        // Why: performSelector mirrors AppKit's object-return ABI for this
        // bridge; declaring the private selector directly can abort objc2.
        let relative_event: *mut AnyObject =
            unsafe { msg_send![&*event, performSelector: relative_selector, withObject: &*window] };
        let relative_event = unsafe { (relative_event as *mut NSEvent).as_ref() }
            .ok_or_else(|| "AppKit could not bind the browser wheel event".to_string())?;
        if relative_event.windowNumber() != window.windowNumber() {
            return Err(format!(
                "AppKit browser wheel event window mismatch: expected {}, received {}",
                window.windowNumber(),
                relative_event.windowNumber()
            ));
        }
        // Why: the public CG window fields let NSWindow route the event to the
        // focused WKWebView without the abort-prone private AppKit conversion.
        window.sendEvent(relative_event);
        return Ok(());
    }
    let (x, y, event_type, button, click_count, modifiers) = match action {
        BrowserNativeInputAction::MouseMove { x, y, modifiers } => {
            (*x, *y, NSEventType::MouseMoved, false, 0, modifiers)
        }
        BrowserNativeInputAction::MouseButton {
            phase,
            button,
            x: Some(x),
            y: Some(y),
            click_count,
            modifiers,
        } => (
            *x,
            *y,
            event_type_for_button(*button, *phase),
            true,
            *click_count as isize,
            modifiers,
        ),
        BrowserNativeInputAction::MouseButton { .. } => {
            return Err("browser mouse coordinates were not resolved".to_string())
        }
        BrowserNativeInputAction::TextInput { .. } => unreachable!(),
        BrowserNativeInputAction::Key { .. } => unreachable!(),
        BrowserNativeInputAction::MouseWheel { .. } => unreachable!(),
        BrowserNativeInputAction::MouseDrag { .. } => unreachable!(),
    };
    let bounds = view.bounds();
    if x > bounds.size.width || y > bounds.size.height {
        return Err("browser native input point is outside the WebView".to_string());
    }
    let local = local_point(view, x, y);
    let location = view.convertPoint_toView(local, None);
    let window = view
        .window()
        .ok_or_else(|| "browser WebView is not attached to a window".to_string())?;
    window.setAcceptsMouseMovedEvents(true);
    let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        event_type,
        location,
        modifier_flags(modifiers),
        0.0,
        window.windowNumber(),
        None,
        0,
        click_count,
        if button { 1.0 } else { 0.0 },
    )
    .ok_or_else(|| "AppKit could not create a browser input event".to_string())?;
    // Why: WebKit's automation path makes WKWebView first responder before
    // routing synthetic events through its NSWindow; direct responder calls
    // bypass WebPageProxy and never reach the web process.
    window.makeKeyAndOrderFront(None);
    let responder = view;
    if !window.makeFirstResponder(Some(responder)) {
        return Err("browser WebView could not become first responder".to_string());
    }
    match event_type {
        NSEventType::MouseMoved => responder.mouseMoved(&event),
        NSEventType::LeftMouseDown => responder.mouseDown(&event),
        NSEventType::LeftMouseUp => responder.mouseUp(&event),
        NSEventType::RightMouseDown => responder.rightMouseDown(&event),
        NSEventType::RightMouseUp => responder.rightMouseUp(&event),
        NSEventType::OtherMouseDown => responder.otherMouseDown(&event),
        NSEventType::OtherMouseUp => responder.otherMouseUp(&event),
        _ => unreachable!(),
    }
    Ok(())
}

pub(super) fn local_point(view: &NSView, x: f64, y: f64) -> NSPoint {
    // Why: WKWebView is flipped on macOS, so DOM viewport coordinates already
    // share its top-left origin; only ordinary AppKit views require inversion.
    NSPoint::new(
        x,
        if view.isFlipped() {
            y
        } else {
            view.bounds().size.height - y
        },
    )
}

fn event_type_for_button(
    button: BrowserMouseButton,
    phase: BrowserMouseButtonPhase,
) -> NSEventType {
    match (button, phase) {
        (BrowserMouseButton::Left, BrowserMouseButtonPhase::Down) => NSEventType::LeftMouseDown,
        (BrowserMouseButton::Left, BrowserMouseButtonPhase::Up) => NSEventType::LeftMouseUp,
        (BrowserMouseButton::Right, BrowserMouseButtonPhase::Down) => NSEventType::RightMouseDown,
        (BrowserMouseButton::Right, BrowserMouseButtonPhase::Up) => NSEventType::RightMouseUp,
        (BrowserMouseButton::Middle, BrowserMouseButtonPhase::Down) => NSEventType::OtherMouseDown,
        (BrowserMouseButton::Middle, BrowserMouseButtonPhase::Up) => NSEventType::OtherMouseUp,
    }
}

pub(super) fn modifier_flags(modifiers: &[BrowserInputModifier]) -> NSEventModifierFlags {
    modifiers
        .iter()
        .fold(NSEventModifierFlags::empty(), |flags, modifier| {
            flags
                | match modifier {
                    BrowserInputModifier::Alt => NSEventModifierFlags::Option,
                    BrowserInputModifier::Control => NSEventModifierFlags::Control,
                    BrowserInputModifier::Meta => NSEventModifierFlags::Command,
                    BrowserInputModifier::Shift => NSEventModifierFlags::Shift,
                }
        })
}

pub(super) fn cg_modifier_flags(modifiers: &[BrowserInputModifier]) -> CGEventFlags {
    modifiers
        .iter()
        .fold(CGEventFlags::empty(), |flags, modifier| {
            flags
                | match modifier {
                    BrowserInputModifier::Alt => CGEventFlags::MaskAlternate,
                    BrowserInputModifier::Control => CGEventFlags::MaskControl,
                    BrowserInputModifier::Meta => CGEventFlags::MaskCommand,
                    BrowserInputModifier::Shift => CGEventFlags::MaskShift,
                }
        })
}
