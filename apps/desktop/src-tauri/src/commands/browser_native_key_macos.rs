use objc2_app_kit::{NSEvent, NSEventType, NSView};
use objc2_foundation::{NSPoint, NSString};

use super::super::{BrowserInputModifier, BrowserKeyPhase};
use super::modifier_flags;

pub(super) fn dispatch_key_input(
    view: &NSView,
    phase: BrowserKeyPhase,
    key: &str,
    modifiers: &[BrowserInputModifier],
) -> Result<(), String> {
    let window = view
        .window()
        .ok_or_else(|| "browser WebView is not attached to a window".to_string())?;
    let responder = window
        .firstResponder()
        .ok_or_else(|| "browser WebView has no focused responder".to_string())?;
    let descriptor = key_descriptor(key, modifiers)?;
    let mut effective_modifiers = modifiers.to_vec();
    if printable_key_implies_shift(key)
        && !effective_modifiers.contains(&BrowserInputModifier::Shift)
    {
        effective_modifiers.push(BrowserInputModifier::Shift);
    }
    if !matches!(phase, BrowserKeyPhase::Up) {
        if let Some(modifier) = modifier_for_key(key) {
            if !effective_modifiers.contains(&modifier) {
                effective_modifiers.push(modifier);
            }
        }
    }
    let characters = NSString::from_str(&descriptor.characters);
    let ignoring_modifiers = NSString::from_str(&descriptor.ignoring_modifiers);
    let dispatch = |event_type| -> Result<(), String> {
        let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            event_type,
            NSPoint::ZERO,
            modifier_flags(&effective_modifiers),
            0.0,
            window.windowNumber(),
            None,
            &characters,
            &ignoring_modifiers,
            false,
            descriptor.key_code,
        )
        .ok_or_else(|| "AppKit could not create a browser key event".to_string())?;
        match event_type {
            NSEventType::KeyDown => responder.keyDown(&event),
            NSEventType::KeyUp => responder.keyUp(&event),
            _ => unreachable!(),
        }
        Ok(())
    };
    match phase {
        BrowserKeyPhase::Down => dispatch(NSEventType::KeyDown),
        BrowserKeyPhase::Up => dispatch(NSEventType::KeyUp),
        BrowserKeyPhase::Press => {
            dispatch(NSEventType::KeyDown)?;
            dispatch(NSEventType::KeyUp)
        }
    }
}

struct KeyDescriptor {
    key_code: u16,
    characters: String,
    ignoring_modifiers: String,
}

fn key_descriptor(key: &str, modifiers: &[BrowserInputModifier]) -> Result<KeyDescriptor, String> {
    let (key_code, base) = named_key(key)
        .or_else(|| printable_key(key))
        .ok_or_else(|| format!("browser native key is not supported on macOS: {key}"))?;
    let shift = printable_key_implies_shift(key)
        || modifiers
            .iter()
            .any(|modifier| matches!(modifier, BrowserInputModifier::Shift));
    let characters = if shift && base.len() == 1 {
        shifted_character(&base).unwrap_or_else(|| base.to_uppercase())
    } else {
        base.clone()
    };
    Ok(KeyDescriptor {
        key_code,
        characters,
        ignoring_modifiers: base,
    })
}

fn printable_key_implies_shift(key: &str) -> bool {
    key.chars().count() == 1 && key.chars().next().is_some_and(char::is_uppercase)
}

fn named_key(key: &str) -> Option<(u16, String)> {
    let value = match key {
        "Enter" | "Return" => (36, "\r"),
        "Tab" => (48, "\t"),
        "Backspace" => (51, "\u{7f}"),
        "Escape" | "Esc" => (53, "\u{1b}"),
        " " | "Space" | "Spacebar" => (49, " "),
        "Delete" => (117, "\u{f728}"),
        "Home" => (115, "\u{f729}"),
        "End" => (119, "\u{f72b}"),
        "PageUp" => (116, "\u{f72c}"),
        "PageDown" => (121, "\u{f72d}"),
        "ArrowUp" | "Up" => (126, "\u{f700}"),
        "ArrowDown" | "Down" => (125, "\u{f701}"),
        "ArrowLeft" | "Left" => (123, "\u{f702}"),
        "ArrowRight" | "Right" => (124, "\u{f703}"),
        "F1" => (122, "\u{f704}"),
        "F2" => (120, "\u{f705}"),
        "F3" => (99, "\u{f706}"),
        "F4" => (118, "\u{f707}"),
        "F5" => (96, "\u{f708}"),
        "F6" => (97, "\u{f709}"),
        "F7" => (98, "\u{f70a}"),
        "F8" => (100, "\u{f70b}"),
        "F9" => (101, "\u{f70c}"),
        "F10" => (109, "\u{f70d}"),
        "F11" => (103, "\u{f70e}"),
        "F12" => (111, "\u{f70f}"),
        "Meta" | "Command" | "Cmd" => (55, ""),
        "Shift" => (56, ""),
        "Alt" | "Option" => (58, ""),
        "Control" | "Ctrl" => (59, ""),
        _ => return None,
    };
    Some((value.0, value.1.to_string()))
}

fn modifier_for_key(key: &str) -> Option<BrowserInputModifier> {
    match key {
        "Meta" | "Command" | "Cmd" => Some(BrowserInputModifier::Meta),
        "Shift" => Some(BrowserInputModifier::Shift),
        "Alt" | "Option" => Some(BrowserInputModifier::Alt),
        "Control" | "Ctrl" => Some(BrowserInputModifier::Control),
        _ => None,
    }
}

fn printable_key(key: &str) -> Option<(u16, String)> {
    if key.chars().count() != 1 {
        return None;
    }
    let character = key.chars().next()?.to_ascii_lowercase();
    let key_code = match character {
        'a' => 0,
        's' => 1,
        'd' => 2,
        'f' => 3,
        'h' => 4,
        'g' => 5,
        'z' => 6,
        'x' => 7,
        'c' => 8,
        'v' => 9,
        'b' => 11,
        'q' => 12,
        'w' => 13,
        'e' => 14,
        'r' => 15,
        'y' => 16,
        't' => 17,
        '1' => 18,
        '2' => 19,
        '3' => 20,
        '4' => 21,
        '6' => 22,
        '5' => 23,
        '=' => 24,
        '9' => 25,
        '7' => 26,
        '-' => 27,
        '8' => 28,
        '0' => 29,
        ']' => 30,
        'o' => 31,
        'u' => 32,
        '[' => 33,
        'i' => 34,
        'p' => 35,
        'l' => 37,
        'j' => 38,
        '\'' => 39,
        'k' => 40,
        ';' => 41,
        '\\' => 42,
        ',' => 43,
        '/' => 44,
        'n' => 45,
        'm' => 46,
        '.' => 47,
        '`' => 50,
        _ => return None,
    };
    Some((key_code, character.to_string()))
}

fn shifted_character(base: &str) -> Option<String> {
    let shifted = match base {
        "1" => "!",
        "2" => "@",
        "3" => "#",
        "4" => "$",
        "5" => "%",
        "6" => "^",
        "7" => "&",
        "8" => "*",
        "9" => "(",
        "0" => ")",
        "-" => "_",
        "=" => "+",
        "[" => "{",
        "]" => "}",
        "\\" => "|",
        ";" => ":",
        "'" => "\"",
        "," => "<",
        "." => ">",
        "/" => "?",
        "`" => "~",
        _ => return None,
    };
    Some(shifted.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_navigation_and_shifted_printable_keys() {
        assert_eq!(key_descriptor("ArrowLeft", &[]).unwrap().key_code, 123);
        let shifted = key_descriptor("1", &[BrowserInputModifier::Shift]).unwrap();
        assert_eq!(shifted.characters, "!");
        assert_eq!(shifted.ignoring_modifiers, "1");
        let uppercase = key_descriptor("K", &[]).unwrap();
        assert_eq!(uppercase.characters, "K");
        assert_eq!(uppercase.ignoring_modifiers, "k");
        assert!(printable_key_implies_shift("K"));
    }

    #[test]
    fn rejects_unknown_named_keys() {
        assert!(key_descriptor("HyperLaunch", &[]).is_err());
    }
}
