use std::time::Duration;

use futures_util::SinkExt;
use serde_json::{json, Value};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::emulator_ios_simctl::ServeSimInputCommand;

const TOUCH_OPCODE: u8 = 3;
const BUTTON_OPCODE: u8 = 4;
const KEYBOARD_OPCODE: u8 = 6;
const ROTATE_OPCODE: u8 = 7;
const CORE_ANIMATION_DEBUG_OPCODE: u8 = 8;
const MEMORY_WARNING_OPCODE: u8 = 9;
const LEFT_SHIFT_USAGE: u16 = 225;

pub fn send_input(command: &ServeSimInputCommand, port: u16) -> Result<(), String> {
    let packets = packets(command)?;
    tauri::async_runtime::block_on(async move {
        let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{port}/ws"))
            .await
            .map_err(|error| {
                format!("emulator_error: cannot connect to simulator input: {error}")
            })?;
        for packet in packets {
            socket
                .send(Message::Binary(packet.bytes.into()))
                .await
                .map_err(|error| format!("emulator_error: cannot send simulator input: {error}"))?;
            if !packet.delay.is_zero() {
                tokio::time::sleep(packet.delay).await;
            }
        }
        socket
            .close(None)
            .await
            .map_err(|error| format!("emulator_error: cannot close simulator input: {error}"))
    })
}

struct InputPacket {
    bytes: Vec<u8>,
    delay: Duration,
}

fn packets(command: &ServeSimInputCommand) -> Result<Vec<InputPacket>, String> {
    match command {
        ServeSimInputCommand::Gesture { point_json, .. } => {
            let point: Value = serde_json::from_str(point_json)
                .map_err(|error| format!("invalid_target: invalid gesture point: {error}"))?;
            Ok(vec![packet(TOUCH_OPCODE, point, Duration::ZERO)])
        }
        ServeSimInputCommand::Tap { x, y, .. } => Ok(vec![
            packet(
                TOUCH_OPCODE,
                json!({"type": "begin", "x": x, "y": y}),
                Duration::from_millis(40),
            ),
            packet(
                TOUCH_OPCODE,
                json!({"type": "end", "x": x, "y": y}),
                Duration::from_millis(50),
            ),
        ]),
        ServeSimInputCommand::Button { name, .. } => Ok(vec![packet(
            BUTTON_OPCODE,
            json!({"button": name}),
            Duration::from_millis(50),
        )]),
        ServeSimInputCommand::Rotate { orientation, .. } => Ok(vec![packet(
            ROTATE_OPCODE,
            json!({"orientation": orientation}),
            Duration::from_millis(50),
        )]),
        ServeSimInputCommand::Type { text, .. } => keyboard_packets(text),
        ServeSimInputCommand::CoreAnimationDebug {
            option, enabled, ..
        } => Ok(vec![packet(
            CORE_ANIMATION_DEBUG_OPCODE,
            json!({"option": option, "enabled": enabled}),
            Duration::from_millis(50),
        )]),
        ServeSimInputCommand::MemoryWarning { .. } => Ok(vec![InputPacket {
            bytes: vec![MEMORY_WARNING_OPCODE],
            delay: Duration::from_millis(50),
        }]),
    }
}

fn keyboard_packets(text: &str) -> Result<Vec<InputPacket>, String> {
    let mut output = Vec::with_capacity(text.len() * 4);
    for character in text.chars() {
        let (usage, shift) = keyboard_usage(character).ok_or_else(|| {
            format!("invalid_target: iOS typing supports US-keyboard ASCII, not {character:?}")
        })?;
        if shift {
            output.push(key_packet("down", LEFT_SHIFT_USAGE));
        }
        output.push(key_packet("down", usage));
        output.push(key_packet("up", usage));
        if shift {
            output.push(key_packet("up", LEFT_SHIFT_USAGE));
        }
    }
    Ok(output)
}

fn key_packet(kind: &str, usage: u16) -> InputPacket {
    packet(
        KEYBOARD_OPCODE,
        json!({"type": kind, "usage": usage}),
        Duration::ZERO,
    )
}

fn packet(opcode: u8, payload: Value, delay: Duration) -> InputPacket {
    let encoded = serde_json::to_vec(&payload).expect("JSON input packet is serializable");
    let mut bytes = Vec::with_capacity(encoded.len() + 1);
    bytes.push(opcode);
    bytes.extend(encoded);
    InputPacket { bytes, delay }
}

fn keyboard_usage(character: char) -> Option<(u16, bool)> {
    if character.is_ascii_alphabetic() {
        let lower = character.to_ascii_lowercase() as u8;
        return Some(((lower - b'a' + 4).into(), character.is_ascii_uppercase()));
    }
    if let Some(index) = "1234567890".find(character) {
        return Some(((30 + index) as u16, false));
    }
    if let Some(index) = "!@#$%^&*()".find(character) {
        return Some(((30 + index) as u16, true));
    }
    let (usage, shift) = match character {
        ' ' => (44, false),
        '\n' => (40, false),
        '\t' => (43, false),
        '-' => (45, false),
        '_' => (45, true),
        '=' => (46, false),
        '+' => (46, true),
        '[' => (47, false),
        '{' => (47, true),
        ']' => (48, false),
        '}' => (48, true),
        '\\' => (49, false),
        '|' => (49, true),
        ';' => (51, false),
        ':' => (51, true),
        '\'' => (52, false),
        '"' => (52, true),
        '`' => (53, false),
        '~' => (53, true),
        ',' => (54, false),
        '<' => (54, true),
        '.' => (55, false),
        '>' => (55, true),
        '/' => (56, false),
        '?' => (56, true),
        _ => return None,
    };
    Some((usage, shift))
}

#[cfg(test)]
mod tests {
    use super::{
        keyboard_packets, packets, BUTTON_OPCODE, CORE_ANIMATION_DEBUG_OPCODE, KEYBOARD_OPCODE,
        MEMORY_WARNING_OPCODE, TOUCH_OPCODE,
    };
    use crate::commands::emulator_ios_simctl::ServeSimInputCommand;

    #[test]
    fn tap_emits_begin_and_end_touch_frames() {
        let frames = packets(&ServeSimInputCommand::Tap {
            x: 0.25,
            y: 0.75,
            udid: "U".into(),
        })
        .unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].bytes[0], TOUCH_OPCODE);
        assert!(String::from_utf8_lossy(&frames[0].bytes).contains("begin"));
    }

    #[test]
    fn keyboard_encodes_shift_and_rejects_unicode() {
        let frames = keyboard_packets("A!").unwrap();
        assert_eq!(frames.len(), 8);
        assert!(frames.iter().all(|frame| frame.bytes[0] == KEYBOARD_OPCODE));
        assert!(keyboard_packets("你").is_err());
    }

    #[test]
    fn button_uses_native_button_opcode() {
        let frames = packets(&ServeSimInputCommand::Button {
            name: "home".into(),
            udid: "U".into(),
        })
        .unwrap();
        assert_eq!(frames[0].bytes[0], BUTTON_OPCODE);
    }

    #[test]
    fn diagnostics_use_native_helper_opcodes() {
        let debug = packets(&ServeSimInputCommand::CoreAnimationDebug {
            option: "debug_color_blended".into(),
            enabled: true,
            udid: "U".into(),
        })
        .unwrap();
        assert_eq!(debug[0].bytes[0], CORE_ANIMATION_DEBUG_OPCODE);
        assert!(String::from_utf8_lossy(&debug[0].bytes).contains("debug_color_blended"));

        let warning = packets(&ServeSimInputCommand::MemoryWarning { udid: "U".into() }).unwrap();
        assert_eq!(warning[0].bytes, [MEMORY_WARNING_OPCODE]);
    }
}
