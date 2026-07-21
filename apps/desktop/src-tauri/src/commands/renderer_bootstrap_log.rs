use std::io::{self, Write};

use serde::Deserialize;

const MAX_STAGE_BYTES: usize = 128;
const MAX_MESSAGE_BYTES: usize = 16 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererBootstrapLogInput {
    stage: String,
    message: String,
}

#[tauri::command]
pub fn renderer_bootstrap_log(input: RendererBootstrapLogInput) {
    let stage = bounded(&input.stage, MAX_STAGE_BYTES);
    let message = bounded(&input.message, MAX_MESSAGE_BYTES);
    let mut stderr = io::stderr().lock();
    write_renderer_bootstrap_log(&mut stderr, &stage, &message);
}

fn write_renderer_bootstrap_log(writer: &mut impl Write, stage: &str, message: &str) {
    // Diagnostic output is best effort because detached app launches may not
    // have a writable stderr, and losing a breadcrumb must never abort Pebble.
    let _ = writeln!(writer, "[renderer-bootstrap:{stage}] {message}");
}

fn bounded(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(limit)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("stderr unavailable"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::other("stderr unavailable"))
        }
    }

    #[test]
    fn bounds_and_strips_untrusted_renderer_log_text() {
        assert_eq!(bounded("load\nfailed", 8), "loadfail");
    }

    #[test]
    fn writes_the_existing_renderer_bootstrap_log_format() {
        let mut output = Vec::new();

        write_renderer_bootstrap_log(&mut output, "load", "failed");

        assert_eq!(output, b"[renderer-bootstrap:load] failed\n");
    }

    #[test]
    fn ignores_diagnostic_write_failures() {
        write_renderer_bootstrap_log(&mut FailingWriter, "load", "failed");
    }
}
