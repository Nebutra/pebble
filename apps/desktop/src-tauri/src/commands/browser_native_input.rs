use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use super::browser_child_webview::validate_browser_webview_label;

const MAX_BROWSER_COORDINATE: f64 = 100_000.0;
const MAX_BROWSER_INPUT_TEXT_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub struct BrowserNativeInputState {
    pointers: Mutex<HashMap<String, (f64, f64)>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum BrowserNativeInputAction {
    MouseMove {
        x: f64,
        y: f64,
        #[serde(default)]
        modifiers: Vec<BrowserInputModifier>,
    },
    MouseButton {
        phase: BrowserMouseButtonPhase,
        button: BrowserMouseButton,
        x: Option<f64>,
        y: Option<f64>,
        #[serde(default = "default_click_count")]
        click_count: u8,
        #[serde(default)]
        modifiers: Vec<BrowserInputModifier>,
    },
    TextInput {
        text: String,
        #[serde(default)]
        replace: bool,
    },
    Key {
        phase: BrowserKeyPhase,
        key: String,
        #[serde(default)]
        modifiers: Vec<BrowserInputModifier>,
    },
    MouseWheel {
        delta_x: f64,
        delta_y: f64,
        x: Option<f64>,
        y: Option<f64>,
        #[serde(default)]
        modifiers: Vec<BrowserInputModifier>,
    },
    MouseDrag {
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
        #[serde(default = "default_drag_steps")]
        steps: u8,
        #[serde(default)]
        modifiers: Vec<BrowserInputModifier>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserKeyPhase {
    Down,
    Up,
    Press,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserMouseButtonPhase {
    Down,
    Up,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserMouseButton {
    Left,
    Middle,
    Right,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserInputModifier {
    Alt,
    Control,
    Meta,
    Shift,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNativeInputCommand {
    label: String,
    action: BrowserNativeInputAction,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNativeInputResult {
    accepted: bool,
    backend: &'static str,
}

#[tauri::command]
pub async fn browser_child_webview_input(
    app: AppHandle,
    state: State<'_, BrowserNativeInputState>,
    input: BrowserNativeInputCommand,
) -> Result<BrowserNativeInputResult, String> {
    let label = validate_browser_webview_label(&input.label)?;
    let action = resolve_action_coordinates(&state, &label, input.action)?;
    #[cfg(target_os = "macos")]
    {
        if app.get_webview(&label).is_none() {
            return Err("browser WebView is not available".to_string());
        }
        platform::dispatch_platform_input_after_yield(app, label, action).await?;
        return Ok(BrowserNativeInputResult {
            accepted: true,
            backend: platform_backend(),
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
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
            .map_err(|_| "browser native input callback was dropped".to_string())??;
        Ok(BrowserNativeInputResult {
            accepted: true,
            backend: platform_backend(),
        })
    }
}

fn resolve_action_coordinates(
    state: &BrowserNativeInputState,
    label: &str,
    action: BrowserNativeInputAction,
) -> Result<BrowserNativeInputAction, String> {
    match action {
        BrowserNativeInputAction::MouseMove { x, y, modifiers } => {
            validate_point(x, y)?;
            state
                .pointers
                .lock()
                .map_err(|_| "browser native input state was poisoned".to_string())?
                .insert(label.to_string(), (x, y));
            Ok(BrowserNativeInputAction::MouseMove { x, y, modifiers })
        }
        BrowserNativeInputAction::MouseButton {
            phase,
            button,
            x,
            y,
            click_count,
            modifiers,
        } => {
            if !(1..=3).contains(&click_count) {
                return Err("browser click count must be from 1 to 3".to_string());
            }
            let point = match (x, y) {
                (Some(x), Some(y)) => {
                    validate_point(x, y)?;
                    (x, y)
                }
                (None, None) => *state
                    .pointers
                    .lock()
                    .map_err(|_| "browser native input state was poisoned".to_string())?
                    .get(label)
                    .ok_or_else(|| "browser pointer position is not initialized".to_string())?,
                _ => return Err("browser mouse coordinates must include both x and y".to_string()),
            };
            Ok(BrowserNativeInputAction::MouseButton {
                phase,
                button,
                x: Some(point.0),
                y: Some(point.1),
                click_count,
                modifiers,
            })
        }
        BrowserNativeInputAction::TextInput { text, replace } => {
            if text.len() > MAX_BROWSER_INPUT_TEXT_BYTES {
                return Err("browser native input text exceeds 1 MiB".to_string());
            }
            Ok(BrowserNativeInputAction::TextInput { text, replace })
        }
        BrowserNativeInputAction::Key {
            phase,
            key,
            modifiers,
        } => {
            if key.is_empty() || key.len() > 64 {
                return Err("browser native key must contain 1 to 64 bytes".to_string());
            }
            if modifiers.len() > 4 {
                return Err("browser native key accepts at most 4 modifiers".to_string());
            }
            Ok(BrowserNativeInputAction::Key {
                phase,
                key,
                modifiers,
            })
        }
        BrowserNativeInputAction::MouseWheel {
            delta_x,
            delta_y,
            x,
            y,
            modifiers,
        } => {
            if !delta_x.is_finite()
                || !delta_y.is_finite()
                || delta_x.abs() > 10_000.0
                || delta_y.abs() > 10_000.0
            {
                return Err("browser native wheel delta is invalid".to_string());
            }
            let point = match (x, y) {
                (Some(x), Some(y)) => {
                    validate_point(x, y)?;
                    (x, y)
                }
                (None, None) => *state
                    .pointers
                    .lock()
                    .map_err(|_| "browser native input state was poisoned".to_string())?
                    .get(label)
                    .ok_or_else(|| "browser pointer position is not initialized".to_string())?,
                _ => return Err("browser wheel coordinates must include both x and y".to_string()),
            };
            Ok(BrowserNativeInputAction::MouseWheel {
                delta_x,
                delta_y,
                x: Some(point.0),
                y: Some(point.1),
                modifiers,
            })
        }
        BrowserNativeInputAction::MouseDrag {
            from_x,
            from_y,
            to_x,
            to_y,
            steps,
            modifiers,
        } => {
            validate_point(from_x, from_y)?;
            validate_point(to_x, to_y)?;
            if !(2..=64).contains(&steps) {
                return Err("browser native drag steps must be from 2 to 64".to_string());
            }
            Ok(BrowserNativeInputAction::MouseDrag {
                from_x,
                from_y,
                to_x,
                to_y,
                steps,
                modifiers,
            })
        }
    }
}

fn validate_point(x: f64, y: f64) -> Result<(), String> {
    if !x.is_finite()
        || !y.is_finite()
        || x < 0.0
        || y < 0.0
        || x > MAX_BROWSER_COORDINATE
        || y > MAX_BROWSER_COORDINATE
    {
        return Err("browser native input coordinates are invalid".to_string());
    }
    Ok(())
}

fn default_click_count() -> u8 {
    1
}

fn default_drag_steps() -> u8 {
    8
}

#[cfg(target_os = "macos")]
#[path = "browser_native_input_macos.rs"]
mod platform;

#[cfg(target_os = "macos")]
fn platform_backend() -> &'static str {
    "appkit-async-responder"
}

#[cfg(target_os = "windows")]
#[path = "browser_native_input_windows.rs"]
mod windows_platform;

#[cfg(target_os = "windows")]
fn dispatch_platform_input(
    platform_webview: tauri::webview::PlatformWebview,
    action: &BrowserNativeInputAction,
) -> Result<(), String> {
    windows_platform::dispatch_platform_input(platform_webview, action)
}

#[cfg(target_os = "windows")]
fn platform_backend() -> &'static str {
    "webview2-cdp"
}

#[cfg(target_os = "linux")]
#[path = "browser_native_input_linux.rs"]
mod linux_platform;

#[cfg(target_os = "linux")]
fn dispatch_platform_input(
    platform_webview: tauri::webview::PlatformWebview,
    action: &BrowserNativeInputAction,
) -> Result<(), String> {
    linux_platform::dispatch_platform_input(platform_webview, action)
}

#[cfg(target_os = "linux")]
fn platform_backend() -> &'static str {
    "webkitgtk-gdk"
}

#[cfg(any(target_os = "linux", test))]
const LINUX_SHIFT_MASK: u32 = 1 << 0;
#[cfg(any(target_os = "linux", test))]
const LINUX_CONTROL_MASK: u32 = 1 << 2;
#[cfg(any(target_os = "linux", test))]
const LINUX_ALT_MASK: u32 = 1 << 3;
#[cfg(any(target_os = "linux", test))]
const LINUX_SUPER_MASK: u32 = 1 << 26;
#[cfg(target_os = "linux")]
const LINUX_BUTTON1_MASK: u32 = 1 << 8;

#[cfg(any(target_os = "linux", test))]
fn linux_modifier_mask(modifiers: &[BrowserInputModifier]) -> u32 {
    modifiers.iter().fold(0, |mask, modifier| {
        mask | match modifier {
            BrowserInputModifier::Alt => LINUX_ALT_MASK,
            BrowserInputModifier::Control => LINUX_CONTROL_MASK,
            BrowserInputModifier::Meta => LINUX_SUPER_MASK,
            BrowserInputModifier::Shift => LINUX_SHIFT_MASK,
        }
    })
}

#[cfg(any(target_os = "linux", test))]
fn linux_button_number(button: BrowserMouseButton) -> u32 {
    match button {
        BrowserMouseButton::Left => 1,
        BrowserMouseButton::Middle => 2,
        BrowserMouseButton::Right => 3,
    }
}

#[cfg(any(target_os = "linux", test))]
fn linux_keyval(key: &str) -> Option<u32> {
    let named = match key {
        "Alt" => 0xffe9,
        "ArrowDown" => 0xff54,
        "ArrowLeft" => 0xff51,
        "ArrowRight" => 0xff53,
        "ArrowUp" => 0xff52,
        "Backspace" => 0xff08,
        "Control" => 0xffe3,
        "Delete" => 0xffff,
        "End" => 0xff57,
        "Enter" => 0xff0d,
        "Escape" => 0xff1b,
        "Home" => 0xff50,
        "Meta" => 0xffeb,
        "PageDown" => 0xff56,
        "PageUp" => 0xff55,
        "Shift" => 0xffe1,
        "Tab" => 0xff09,
        " " | "Space" => 0x20,
        _ => {
            let mut chars = key.chars();
            let value = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            let codepoint = u32::from(value);
            return Some(if codepoint <= 0xff {
                codepoint
            } else {
                0x0100_0000 | codepoint
            });
        }
    };
    Some(named)
}

#[cfg(any(target_os = "linux", test))]
fn linux_drag_points(from: (f64, f64), to: (f64, f64), steps: u8) -> Vec<(f64, f64)> {
    (1..=steps)
        .map(|step| {
            let progress = f64::from(step) / f64::from(steps);
            (
                from.0 + (to.0 - from.0) * progress,
                from.1 + (to.1 - from.1) * progress,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_camel_case_wheel_and_drag_fields() {
        let wheel: BrowserNativeInputAction =
            serde_json::from_str(r#"{"kind":"mouseWheel","deltaX":1,"deltaY":2,"x":3,"y":4}"#)
                .expect("wheel action");
        assert!(matches!(
            wheel,
            BrowserNativeInputAction::MouseWheel {
                delta_x: 1.0,
                delta_y: 2.0,
                ..
            }
        ));
        let drag: BrowserNativeInputAction = serde_json::from_str(
            r#"{"kind":"mouseDrag","fromX":1,"fromY":2,"toX":3,"toY":4,"steps":8}"#,
        )
        .expect("drag action");
        assert!(matches!(
            drag,
            BrowserNativeInputAction::MouseDrag {
                from_x: 1.0,
                to_y: 4.0,
                ..
            }
        ));
    }

    #[test]
    fn rejects_non_finite_and_out_of_range_coordinates() {
        assert!(validate_point(f64::NAN, 1.0).is_err());
        assert!(validate_point(1.0, -1.0).is_err());
        assert!(validate_point(MAX_BROWSER_COORDINATE + 1.0, 1.0).is_err());
    }

    #[test]
    fn mouse_buttons_reuse_the_last_valid_pointer_position() {
        let state = BrowserNativeInputState::default();
        resolve_action_coordinates(
            &state,
            "browser-page",
            BrowserNativeInputAction::MouseMove {
                x: 12.0,
                y: 34.0,
                modifiers: Vec::new(),
            },
        )
        .unwrap();
        let action = resolve_action_coordinates(
            &state,
            "browser-page",
            BrowserNativeInputAction::MouseButton {
                phase: BrowserMouseButtonPhase::Down,
                button: BrowserMouseButton::Left,
                x: None,
                y: None,
                click_count: 1,
                modifiers: Vec::new(),
            },
        )
        .unwrap();
        match action {
            BrowserNativeInputAction::MouseButton { x, y, .. } => {
                assert_eq!(x, Some(12.0));
                assert_eq!(y, Some(34.0));
            }
            _ => panic!("expected mouse button action"),
        }
    }

    #[test]
    fn rejects_oversized_native_text_input() {
        let state = BrowserNativeInputState::default();
        let action = BrowserNativeInputAction::TextInput {
            text: "a".repeat(MAX_BROWSER_INPUT_TEXT_BYTES + 1),
            replace: false,
        };
        assert!(resolve_action_coordinates(&state, "browser-page", action).is_err());
    }

    #[test]
    fn validates_native_key_input_bounds() {
        let state = BrowserNativeInputState::default();
        let valid = BrowserNativeInputAction::Key {
            phase: BrowserKeyPhase::Press,
            key: "Enter".to_string(),
            modifiers: vec![BrowserInputModifier::Shift],
        };
        assert!(resolve_action_coordinates(&state, "browser-page", valid).is_ok());
        let invalid = BrowserNativeInputAction::Key {
            phase: BrowserKeyPhase::Down,
            key: String::new(),
            modifiers: Vec::new(),
        };
        assert!(resolve_action_coordinates(&state, "browser-page", invalid).is_err());
    }

    #[test]
    fn wheel_reuses_pointer_and_rejects_unbounded_delta() {
        let state = BrowserNativeInputState::default();
        resolve_action_coordinates(
            &state,
            "browser-page",
            BrowserNativeInputAction::MouseMove {
                x: 10.0,
                y: 20.0,
                modifiers: Vec::new(),
            },
        )
        .unwrap();
        let wheel = BrowserNativeInputAction::MouseWheel {
            delta_x: 0.0,
            delta_y: 120.0,
            x: None,
            y: None,
            modifiers: Vec::new(),
        };
        assert!(resolve_action_coordinates(&state, "browser-page", wheel).is_ok());
        let invalid = BrowserNativeInputAction::MouseWheel {
            delta_x: 0.0,
            delta_y: 10_001.0,
            x: Some(0.0),
            y: Some(0.0),
            modifiers: Vec::new(),
        };
        assert!(resolve_action_coordinates(&state, "browser-page", invalid).is_err());
    }

    #[test]
    fn validates_native_drag_steps_and_points() {
        let state = BrowserNativeInputState::default();
        let valid = BrowserNativeInputAction::MouseDrag {
            from_x: 1.0,
            from_y: 2.0,
            to_x: 30.0,
            to_y: 40.0,
            steps: 8,
            modifiers: Vec::new(),
        };
        assert!(resolve_action_coordinates(&state, "browser-page", valid).is_ok());
        let invalid = BrowserNativeInputAction::MouseDrag {
            from_x: 1.0,
            from_y: 2.0,
            to_x: 30.0,
            to_y: 40.0,
            steps: 1,
            modifiers: Vec::new(),
        };
        assert!(resolve_action_coordinates(&state, "browser-page", invalid).is_err());
    }

    #[test]
    fn maps_linux_modifiers_buttons_and_named_keys() {
        assert_eq!(
            linux_modifier_mask(&[
                BrowserInputModifier::Control,
                BrowserInputModifier::Shift,
                BrowserInputModifier::Meta,
            ]),
            LINUX_CONTROL_MASK | LINUX_SHIFT_MASK | LINUX_SUPER_MASK
        );
        assert_eq!(linux_button_number(BrowserMouseButton::Middle), 2);
        assert_eq!(linux_keyval("Enter"), Some(0xff0d));
        assert_eq!(linux_keyval("ArrowDown"), Some(0xff54));
        assert_eq!(linux_keyval("a"), Some(u32::from('a')));
        assert_eq!(linux_keyval("你"), Some(0x0100_0000 | u32::from('你')));
        assert_eq!(linux_keyval("invalid-key"), None);
    }

    #[test]
    fn maps_linux_drag_to_ordered_intermediate_points() {
        assert_eq!(
            linux_drag_points((10.0, 20.0), (30.0, 60.0), 2),
            vec![(20.0, 40.0), (30.0, 60.0)]
        );
    }
}
