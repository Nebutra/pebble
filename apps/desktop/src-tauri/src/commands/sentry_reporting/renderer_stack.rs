use regex::Regex;
use sentry::protocol::{Frame, Stacktrace};
use std::sync::OnceLock;

const MAX_STACK_FRAMES: usize = 80;

pub fn parse_renderer_stack(stack: &str) -> Option<Stacktrace> {
    let frames = stack
        .lines()
        .filter_map(parse_frame)
        .take(MAX_STACK_FRAMES)
        .collect::<Vec<_>>();
    Stacktrace::from_frames_reversed(frames)
}

fn parse_frame(line: &str) -> Option<Frame> {
    let line = line.trim();
    let line = line.strip_prefix("at ").unwrap_or(line);
    let (function, location) = if let Some(open) = line.rfind(" (") {
        let location = line.get(open + 2..)?.strip_suffix(')')?;
        (non_empty(line.get(..open)?), location)
    } else if let Some(at) = line.rfind('@') {
        (non_empty(line.get(..at)?), line.get(at + 1..)?)
    } else {
        (None, line)
    };
    let captures = location_regex().captures(location)?;
    let filename = normalized_asset_filename(captures.name("path")?.as_str())?;
    Some(Frame {
        function: function.map(str::to_string),
        abs_path: Some(format!("~/{filename}")),
        filename: Some(filename),
        lineno: captures.name("line")?.as_str().parse().ok(),
        colno: captures.name("column")?.as_str().parse().ok(),
        in_app: Some(true),
        ..Default::default()
    })
}

fn location_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"^(?<path>.+):(?<line>\d+):(?<column>\d+)$").unwrap())
}

fn normalized_asset_filename(path: &str) -> Option<String> {
    let path = path.split(['?', '#']).next()?;
    let asset_index = path.find("/assets/")?;
    let filename = path.get(asset_index + 1..)?;
    if filename.contains("..") || filename.contains('\\') {
        return None;
    }
    Some(filename.to_string())
}

fn non_empty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_v8_and_webkit_frames_for_source_map_matching() {
        let stack = "Error: failed\n    at renderApp (http://tauri.localhost/assets/renderer.js:10:22)\nupdate@tauri://localhost/assets/vendor.js:30:4";
        let trace = parse_renderer_stack(stack).unwrap();
        assert_eq!(trace.frames.len(), 2);
        assert_eq!(trace.frames[0].function.as_deref(), Some("update"));
        assert_eq!(
            trace.frames[0].filename.as_deref(),
            Some("assets/vendor.js")
        );
        assert_eq!(
            trace.frames[0].abs_path.as_deref(),
            Some("~/assets/vendor.js")
        );
        assert_eq!(trace.frames[1].function.as_deref(), Some("renderApp"));
        assert_eq!(trace.frames[1].lineno, Some(10));
        assert_eq!(trace.frames[1].colno, Some(22));
    }

    #[test]
    fn ignores_messages_without_locations() {
        assert!(parse_renderer_stack("Error: failed\nunknown frame").is_none());
    }

    #[test]
    fn drops_local_paths_and_query_values() {
        let stack = "at local (/Users/alice/repo/src/main.tsx:4:2)\nat render (http://tauri.localhost/assets/renderer.js?token=secret:10:3)";
        let trace = parse_renderer_stack(stack).unwrap();
        assert_eq!(trace.frames.len(), 1);
        assert_eq!(
            trace.frames[0].abs_path.as_deref(),
            Some("~/assets/renderer.js")
        );
    }
}
