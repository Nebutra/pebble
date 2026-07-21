use std::sync::mpsc;

use serde_json::{json, Value};
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows::core::{HSTRING, PCWSTR};

use super::{
    BrowserInputModifier, BrowserKeyPhase, BrowserMouseButton, BrowserMouseButtonPhase,
    BrowserNativeInputAction,
};

pub(super) fn dispatch_platform_input(
    platform_webview: tauri::webview::PlatformWebview,
    action: &BrowserNativeInputAction,
) -> Result<(), String> {
    let controller = platform_webview.controller();
    let webview = unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
    match action {
        BrowserNativeInputAction::MouseMove { x, y, modifiers } => call_cdp(
            &webview,
            "Input.dispatchMouseEvent",
            json!({"type":"mouseMoved","x":x,"y":y,"modifiers":modifier_mask(modifiers)}),
        ),
        BrowserNativeInputAction::MouseButton {
            phase,
            button,
            x: Some(x),
            y: Some(y),
            click_count,
            modifiers,
        } => call_cdp(
            &webview,
            "Input.dispatchMouseEvent",
            json!({
                "type": match phase {
                    BrowserMouseButtonPhase::Down => "mousePressed",
                    BrowserMouseButtonPhase::Up => "mouseReleased",
                },
                "x":x,
                "y":y,
                "button":button_name(*button),
                "clickCount":click_count,
                "modifiers":modifier_mask(modifiers),
            }),
        ),
        BrowserNativeInputAction::MouseButton { .. } => {
            Err("browser mouse coordinates were not resolved".to_string())
        }
        BrowserNativeInputAction::TextInput { text, replace } => {
            if *replace {
                dispatch_key(&webview, BrowserKeyPhase::Press, "a", 2)?;
            }
            call_cdp(&webview, "Input.insertText", json!({"text":text}))
        }
        BrowserNativeInputAction::Key {
            phase,
            key,
            modifiers,
        } => dispatch_key(&webview, *phase, key, modifier_mask(modifiers)),
        BrowserNativeInputAction::MouseWheel {
            delta_x,
            delta_y,
            x: Some(x),
            y: Some(y),
            modifiers,
        } => call_cdp(
            &webview,
            "Input.dispatchMouseEvent",
            json!({
                "type":"mouseWheel",
                "x":x,
                "y":y,
                "deltaX":delta_x,
                "deltaY":delta_y,
                "modifiers":modifier_mask(modifiers),
            }),
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
            (*from_x, *from_y),
            (*to_x, *to_y),
            *steps,
            modifier_mask(modifiers),
        ),
    }
}

fn dispatch_key(
    webview: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    phase: BrowserKeyPhase,
    key: &str,
    modifiers: u8,
) -> Result<(), String> {
    let dispatch = |event_type: &str| {
        call_cdp(
            webview,
            "Input.dispatchKeyEvent",
            json!({
                "type":event_type,
                "key":key,
                "modifiers":modifiers,
                "text":if event_type == "keyDown" && key.chars().count() == 1 { key } else { "" },
            }),
        )
    };
    match phase {
        BrowserKeyPhase::Down => dispatch("keyDown"),
        BrowserKeyPhase::Up => dispatch("keyUp"),
        BrowserKeyPhase::Press => {
            dispatch("keyDown")?;
            dispatch("keyUp")
        }
    }
}

fn dispatch_drag(
    webview: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    from: (f64, f64),
    to: (f64, f64),
    steps: u8,
    modifiers: u8,
) -> Result<(), String> {
    call_cdp(
        webview,
        "Input.dispatchMouseEvent",
        json!({"type":"mousePressed","x":from.0,"y":from.1,"button":"left","buttons":1,"clickCount":1,"modifiers":modifiers}),
    )?;
    for step in 1..=steps {
        let progress = f64::from(step) / f64::from(steps);
        call_cdp(
            webview,
            "Input.dispatchMouseEvent",
            json!({
                "type":"mouseMoved",
                "x":from.0+(to.0-from.0)*progress,
                "y":from.1+(to.1-from.1)*progress,
                "button":"left",
                "buttons":1,
                "modifiers":modifiers,
            }),
        )?;
    }
    call_cdp(
        webview,
        "Input.dispatchMouseEvent",
        json!({"type":"mouseReleased","x":to.0,"y":to.1,"button":"left","buttons":0,"clickCount":1,"modifiers":modifiers}),
    )
}

fn call_cdp(
    webview: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    method: &str,
    parameters: Value,
) -> Result<(), String> {
    let method = HSTRING::from(method);
    let parameters = HSTRING::from(parameters.to_string());
    let (sender, receiver) = mpsc::channel();
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |completed| {
        let _ = sender.send(completed.map(|_| ()).map_err(|error| error.to_string()));
        Ok(())
    }));
    unsafe {
        webview.CallDevToolsProtocolMethod(
            PCWSTR(method.as_ptr()),
            PCWSTR(parameters.as_ptr()),
            &handler,
        )
    }
    .map_err(|error| error.to_string())?;
    webview2_com::wait_with_pump(receiver).map_err(|error| error.to_string())?
}

fn modifier_mask(modifiers: &[BrowserInputModifier]) -> u8 {
    modifiers.iter().fold(0, |mask, modifier| {
        mask | match modifier {
            BrowserInputModifier::Alt => 1,
            BrowserInputModifier::Control => 2,
            BrowserInputModifier::Meta => 4,
            BrowserInputModifier::Shift => 8,
        }
    })
}

fn button_name(button: BrowserMouseButton) -> &'static str {
    match button {
        BrowserMouseButton::Left => "left",
        BrowserMouseButton::Middle => "middle",
        BrowserMouseButton::Right => "right",
    }
}
