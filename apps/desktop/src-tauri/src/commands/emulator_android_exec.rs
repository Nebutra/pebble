use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::emulator_android_adb::AdbCommand;

const MAX_EXEC_ARG_COUNT: usize = 64;
const MAX_EXEC_ARG_BYTES: usize = 4 * 1024;
const MAX_EXEC_ARGV_BYTES: usize = 16 * 1024;
const MAX_EXEC_OUTPUT_BYTES: usize = 256 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS: u64 = 10_000;
const MIN_EXEC_TIMEOUT_MS: u64 = 100;
const MAX_EXEC_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AndroidExecRequest {
    pub argv: Vec<String>,
    pub timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AndroidExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub truncated: bool,
}

pub fn parse_android_exec_request(payload: &Value) -> Result<AndroidExecRequest, String> {
    let argv_values = payload
        .get("argv")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "exec requires an argv array; command strings are not accepted".to_string()
        })?;
    if argv_values.is_empty() || argv_values.len() > MAX_EXEC_ARG_COUNT {
        return Err(format!(
            "exec argv must contain 1 to {MAX_EXEC_ARG_COUNT} arguments"
        ));
    }

    let mut argv = Vec::with_capacity(argv_values.len());
    let mut total_bytes = 0usize;
    for value in argv_values {
        let argument = value
            .as_str()
            .ok_or_else(|| "exec argv entries must be strings".to_string())?;
        if argument.as_bytes().contains(&0) {
            return Err("exec argv entries must not contain NUL bytes".to_string());
        }
        if argument.len() > MAX_EXEC_ARG_BYTES {
            return Err(format!(
                "exec argv entries must not exceed {MAX_EXEC_ARG_BYTES} bytes"
            ));
        }
        total_bytes = total_bytes.saturating_add(argument.len());
        if total_bytes > MAX_EXEC_ARGV_BYTES {
            return Err(format!(
                "exec argv must not exceed {MAX_EXEC_ARGV_BYTES} bytes"
            ));
        }
        argv.push(argument.to_string());
    }
    if argv[0].is_empty() {
        return Err("exec argv[0] must name a device command".to_string());
    }

    let timeout_ms = match payload.get("timeoutMs") {
        None => DEFAULT_EXEC_TIMEOUT_MS,
        Some(value) => value
            .as_u64()
            .filter(|value| (MIN_EXEC_TIMEOUT_MS..=MAX_EXEC_TIMEOUT_MS).contains(value))
            .ok_or_else(|| {
                format!(
                    "exec timeoutMs must be an integer from {MIN_EXEC_TIMEOUT_MS} to {MAX_EXEC_TIMEOUT_MS}"
                )
            })?,
    };
    Ok(AndroidExecRequest {
        argv,
        timeout: Duration::from_millis(timeout_ms),
    })
}

pub fn run_android_exec<F>(
    serial: &str,
    request: &AndroidExecRequest,
    stop: &AtomicBool,
    action_cancelled: F,
) -> Result<AndroidExecResult, String>
where
    F: FnMut() -> bool,
{
    let command = AdbCommand::Exec {
        serial: serial.to_string(),
        argv: request.argv.clone(),
    };
    run_bounded_adb_command(&command, request.timeout, stop, action_cancelled)
}

pub(crate) fn run_bounded_adb_command<F>(
    command: &AdbCommand,
    timeout: Duration,
    stop: &AtomicBool,
    action_cancelled: F,
) -> Result<AndroidExecResult, String>
where
    F: FnMut() -> bool,
{
    let mut process = Command::new(command.binary_name());
    process.args(command.to_argv());
    run_bounded_process(process, timeout, stop, action_cancelled)
}

fn run_bounded_process<F>(
    command: Command,
    timeout: Duration,
    stop: &AtomicBool,
    action_cancelled: F,
) -> Result<AndroidExecResult, String>
where
    F: FnMut() -> bool,
{
    run_bounded_native_command(command, "adb", timeout, stop, action_cancelled)
}

#[derive(Default)]
struct CapturedOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    total_bytes: usize,
    truncated: bool,
}

#[derive(Clone, Copy)]
enum OutputStream {
    Stdout,
    Stderr,
}

pub(crate) fn run_bounded_native_command<F>(
    mut command: Command,
    process_name: &str,
    timeout: Duration,
    stop: &AtomicBool,
    mut action_cancelled: F,
) -> Result<AndroidExecResult, String>
where
    F: FnMut() -> bool,
{
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to spawn {process_name}: {error}"))?;
    let captured = Arc::new(Mutex::new(CapturedOutput::default()));
    let stdout_reader = spawn_pipe_reader(
        child
            .stdout
            .take()
            .ok_or_else(|| format!("failed to capture {process_name} stdout"))?,
        captured.clone(),
        OutputStream::Stdout,
    );
    let stderr_reader = spawn_pipe_reader(
        child
            .stderr
            .take()
            .ok_or_else(|| format!("failed to capture {process_name} stderr"))?,
        captured.clone(),
        OutputStream::Stderr,
    );

    let deadline = Instant::now() + timeout;
    let status = loop {
        if stop.load(Ordering::SeqCst) || action_cancelled() {
            terminate_child(&mut child);
            join_pipe_readers(stdout_reader, stderr_reader)?;
            return Err("exec was canceled".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                terminate_child(&mut child);
                join_pipe_readers(stdout_reader, stderr_reader)?;
                return Err(format!("exec timed out after {} ms", timeout.as_millis()));
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                terminate_child(&mut child);
                join_pipe_readers(stdout_reader, stderr_reader)?;
                return Err(format!("failed to wait on {process_name}: {error}"));
            }
        }
    };
    join_pipe_readers(stdout_reader, stderr_reader)?;
    let output = Arc::try_unwrap(captured)
        .map_err(|_| format!("failed to finalize {process_name} output capture"))?
        .into_inner()
        .map_err(|_| format!("{process_name} output capture was poisoned"))?;
    let (stdout, stderr, text_truncated) = bounded_lossy_output(output.stdout, output.stderr);
    Ok(AndroidExecResult {
        stdout,
        stderr,
        exit_code: status.code(),
        truncated: output.truncated || text_truncated,
    })
}

fn bounded_lossy_output(stdout: Vec<u8>, stderr: Vec<u8>) -> (String, String, bool) {
    let mut stdout = String::from_utf8_lossy(&stdout).to_string();
    let mut stderr = String::from_utf8_lossy(&stderr).to_string();
    let expanded = stdout.len().saturating_add(stderr.len()) > MAX_EXEC_OUTPUT_BYTES;
    if expanded {
        truncate_utf8_bytes(&mut stdout, MAX_EXEC_OUTPUT_BYTES);
        truncate_utf8_bytes(
            &mut stderr,
            MAX_EXEC_OUTPUT_BYTES.saturating_sub(stdout.len()),
        );
    }
    (stdout, stderr, expanded)
}

fn truncate_utf8_bytes(value: &mut String, max_bytes: usize) {
    if value.len() <= max_bytes {
        return;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
}

fn spawn_pipe_reader<R>(
    mut pipe: R,
    captured: Arc<Mutex<CapturedOutput>>,
    stream: OutputStream,
) -> thread::JoinHandle<Result<(), String>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut chunk = [0u8; 8 * 1024];
        loop {
            let count = pipe
                .read(&mut chunk)
                .map_err(|error| format!("failed to read adb output: {error}"))?;
            if count == 0 {
                return Ok(());
            }
            let mut output = captured
                .lock()
                .map_err(|_| "adb output capture was poisoned".to_string())?;
            let remaining = MAX_EXEC_OUTPUT_BYTES.saturating_sub(output.total_bytes);
            let retained = count.min(remaining);
            match stream {
                OutputStream::Stdout => output.stdout.extend_from_slice(&chunk[..retained]),
                OutputStream::Stderr => output.stderr.extend_from_slice(&chunk[..retained]),
            }
            output.total_bytes += retained;
            output.truncated |= retained < count;
        }
    })
}

fn terminate_child(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn join_pipe_readers(
    stdout: thread::JoinHandle<Result<(), String>>,
    stderr: thread::JoinHandle<Result<(), String>>,
) -> Result<(), String> {
    stdout
        .join()
        .map_err(|_| "adb stdout reader panicked".to_string())??;
    stderr
        .join()
        .map_err(|_| "adb stderr reader panicked".to_string())??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_bounded_argv_and_timeout() {
        let request = parse_android_exec_request(&serde_json::json!({
            "argv": ["getprop", "ro.build.version.sdk"],
            "timeoutMs": 2500
        }))
        .unwrap();
        assert_eq!(request.argv, ["getprop", "ro.build.version.sdk"]);
        assert_eq!(request.timeout, Duration::from_millis(2_500));
    }

    #[test]
    fn rejects_command_strings_and_oversized_argv() {
        assert!(parse_android_exec_request(&serde_json::json!({
            "command": "getprop ro.build.version.sdk"
        }))
        .unwrap_err()
        .contains("argv array"));
        assert!(parse_android_exec_request(&serde_json::json!({
            "argv": ["x".repeat(MAX_EXEC_ARG_BYTES + 1)]
        }))
        .unwrap_err()
        .contains("must not exceed"));
        let too_many = vec!["x"; MAX_EXEC_ARG_COUNT + 1];
        assert!(
            parse_android_exec_request(&serde_json::json!({ "argv": too_many }))
                .unwrap_err()
                .contains("1 to 64")
        );
        assert!(parse_android_exec_request(&serde_json::json!({
            "argv": ["id"],
            "timeoutMs": MAX_EXEC_TIMEOUT_MS + 1
        }))
        .unwrap_err()
        .contains("timeoutMs"));
    }

    #[test]
    fn bounded_process_honors_cancellation() {
        let stop = AtomicBool::new(false);
        let error = run_bounded_process(
            fixture_command("sleep"),
            Duration::from_secs(5),
            &stop,
            || true,
        )
        .unwrap_err();
        assert_eq!(error, "exec was canceled");
    }

    #[test]
    fn bounded_process_honors_timeout() {
        let stop = AtomicBool::new(false);
        let error = run_bounded_process(
            fixture_command("sleep"),
            Duration::from_millis(100),
            &stop,
            || false,
        )
        .unwrap_err();
        assert!(error.contains("timed out"));
    }

    #[test]
    fn bounded_process_caps_combined_output() {
        let stop = AtomicBool::new(false);
        let result = run_bounded_process(
            fixture_command("output"),
            Duration::from_secs(5),
            &stop,
            || false,
        )
        .unwrap();
        assert!(result.truncated);
        assert!(result.stdout.len() + result.stderr.len() <= MAX_EXEC_OUTPUT_BYTES);
    }

    #[test]
    fn bounded_process_caps_lossy_utf8_expansion() {
        let stop = AtomicBool::new(false);
        let result = run_bounded_process(
            fixture_command("invalid-output"),
            Duration::from_secs(5),
            &stop,
            || false,
        )
        .unwrap();
        assert!(result.truncated);
        assert!(result.stdout.len() + result.stderr.len() <= MAX_EXEC_OUTPUT_BYTES);
    }

    #[test]
    fn bounded_process_fixture() {
        let Ok(mode) = std::env::var("PEBBLE_ANDROID_EXEC_FIXTURE") else {
            return;
        };
        match mode.as_str() {
            "sleep" => thread::sleep(Duration::from_secs(5)),
            "output" => {
                let bytes = vec![b'x'; MAX_EXEC_OUTPUT_BYTES];
                std::io::stdout().write_all(&bytes).unwrap();
                std::io::stderr().write_all(&bytes).unwrap();
            }
            "invalid-output" => {
                let bytes = vec![0xff; MAX_EXEC_OUTPUT_BYTES];
                std::io::stdout().write_all(&bytes).unwrap();
            }
            _ => panic!("unknown fixture mode"),
        }
    }

    fn fixture_command(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["bounded_process_fixture", "--nocapture"])
            .env("PEBBLE_ANDROID_EXEC_FIXTURE", mode);
        command
    }
}
