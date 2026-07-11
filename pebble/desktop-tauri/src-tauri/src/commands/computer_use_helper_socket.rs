//! Blocking bridge to the bundled "Pebble Computer Use.app" helper. Speaks the
//! same newline-delimited JSON protocol as Electron's MacOSNativeProviderClient
//! ({id, method, params, token} -> {id, ok, result|error}) over a unix socket,
//! so screenshots, accessibility reads, and input synthesis stay inside the
//! signed helper that owns the TCC grants.
#![cfg(target_os = "macos")]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use uuid::Uuid;

use super::computer_use_action_translation::{
    accept_handshake_capabilities, ComputerActionExecutor, ExecutorFailure,
};

const HELPER_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HELPER_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const HELPER_CONNECT_RETRY_DELAY: Duration = Duration::from_millis(100);

pub struct HelperSocketExecutor {
    helper_executable: PathBuf,
    connection: Option<HelperConnection>,
}

struct HelperConnection {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    token: String,
    next_id: u64,
    socket_directory: PathBuf,
    capabilities: Value,
    helper_process: Child,
}

impl HelperSocketExecutor {
    pub fn new(helper_executable: PathBuf) -> Self {
        Self {
            helper_executable,
            connection: None,
        }
    }

    fn ensure_connection(&mut self) -> Result<&mut HelperConnection, ExecutorFailure> {
        if self.connection.is_none() {
            self.connection = Some(start_helper_connection(&self.helper_executable)?);
        }
        Ok(self.connection.as_mut().expect("connection was just set"))
    }

    fn request(&mut self, method: &str, params: &Value) -> Result<Value, ExecutorFailure> {
        let connection = self.ensure_connection()?;
        match connection.request(method, params) {
            Ok(result) => Ok(result),
            Err(failure) => {
                // A failed transport leaves the line protocol unsynchronized;
                // drop the helper so the next action starts a fresh one.
                self.teardown();
                Err(failure)
            }
        }
    }

    fn teardown(&mut self) {
        if let Some(connection) = self.connection.take() {
            connection.shutdown();
        }
    }
}

impl ComputerActionExecutor for HelperSocketExecutor {
    fn capabilities(&mut self) -> Result<Value, ExecutorFailure> {
        Ok(self.ensure_connection()?.capabilities.clone())
    }

    fn call(&mut self, method: &'static str, params: &Value) -> Result<Value, ExecutorFailure> {
        self.request(method, params)
    }
}

impl Drop for HelperSocketExecutor {
    fn drop(&mut self) {
        self.teardown();
    }
}

impl HelperConnection {
    fn request(&mut self, method: &str, params: &Value) -> Result<Value, ExecutorFailure> {
        let id = self.next_id;
        self.next_id += 1;
        let line = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
            "token": self.token,
        })
        .to_string();
        self.writer
            .write_all(format!("{line}\n").as_bytes())
            .map_err(|error| {
                ExecutorFailure::new(
                    "accessibility_error",
                    format!("could not write to native macOS helper: {error}"),
                )
            })?;
        let deadline = Instant::now() + HELPER_REQUEST_TIMEOUT;
        loop {
            if Instant::now() >= deadline {
                return Err(ExecutorFailure::new(
                    "action_timeout",
                    format!("native macOS provider {method} timed out"),
                ));
            }
            let mut response_line = String::new();
            let read = self.reader.read_line(&mut response_line).map_err(|error| {
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) {
                    ExecutorFailure::new(
                        "action_timeout",
                        format!("native macOS provider {method} timed out"),
                    )
                } else {
                    ExecutorFailure::new(
                        "accessibility_error",
                        format!("native macOS helper read failed: {error}"),
                    )
                }
            })?;
            if read == 0 {
                return Err(ExecutorFailure::new(
                    "accessibility_error",
                    "native macOS helper app connection closed",
                ));
            }
            let trimmed = response_line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let response: Value = match serde_json::from_str(trimmed) {
                Ok(response) => response,
                Err(_) => continue,
            };
            // Requests are strictly sequential; skip stale ids from a prior
            // timed-out request instead of mispairing them with this one.
            if response.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if response.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(response.get("result").cloned().unwrap_or(Value::Null));
            }
            let code = response
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("accessibility_error")
                .to_string();
            let message = response
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("native macOS helper reported an error")
                .to_string();
            return Err(ExecutorFailure { code, message });
        }
    }

    fn shutdown(mut self) {
        // Parity with Electron shutdown: best-effort terminate then close.
        let id = self.next_id;
        let line = serde_json::json!({
            "id": id,
            "method": "terminate",
            "params": {},
            "token": self.token,
        })
        .to_string();
        let _ = self.writer.write_all(format!("{line}\n").as_bytes());
        let _ = self.writer.shutdown(std::net::Shutdown::Both);
        let _ = self.helper_process.kill();
        let _ = self.helper_process.wait();
        let _ = fs::remove_dir_all(&self.socket_directory);
    }
}

fn start_helper_connection(helper_executable: &Path) -> Result<HelperConnection, ExecutorFailure> {
    let socket_directory =
        std::env::temp_dir().join(format!("pebble-computer-use-{}", Uuid::new_v4()));
    fs::create_dir_all(&socket_directory).map_err(|error| {
        ExecutorFailure::new(
            "accessibility_error",
            format!("could not create helper socket directory: {error}"),
        )
    })?;
    let _ = fs::set_permissions(&socket_directory, fs::Permissions::from_mode(0o700));
    let socket_path = socket_directory.join("provider.sock");
    let token = Uuid::new_v4().to_string();
    let token_path = socket_directory.join("provider.token");
    let cleanup_and_fail = |failure: ExecutorFailure| {
        let _ = fs::remove_dir_all(&socket_directory);
        failure
    };
    fs::write(&token_path, &token).map_err(|error| {
        cleanup_and_fail(ExecutorFailure::new(
            "accessibility_error",
            format!("could not write helper token file: {error}"),
        ))
    })?;
    let _ = fs::set_permissions(&token_path, fs::Permissions::from_mode(0o600));

    // Why: spawning the helper executable directly (not via LaunchServices)
    // keeps TCC attributing the grant to the signed helper, matching Electron.
    let mut helper_process = Command::new(helper_executable)
        .arg("--agent")
        .arg(&socket_path)
        .arg("--token-file")
        .arg(&token_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            cleanup_and_fail(ExecutorFailure::new(
                "accessibility_error",
                format!("native macOS helper app failed to start: {error}"),
            ))
        })?;

    let stream = match connect_with_retry(&socket_path, &mut helper_process) {
        Ok(stream) => stream,
        Err(failure) => {
            let _ = helper_process.kill();
            let _ = helper_process.wait();
            return Err(cleanup_and_fail(failure));
        }
    };
    let _ = fs::remove_file(&token_path);
    let _ = stream.set_read_timeout(Some(HELPER_REQUEST_TIMEOUT));
    let reader_stream = stream.try_clone().map_err(|error| {
        let _ = helper_process.kill();
        let _ = helper_process.wait();
        cleanup_and_fail(ExecutorFailure::new(
            "accessibility_error",
            format!("could not clone helper socket: {error}"),
        ))
    })?;
    let mut connection = HelperConnection {
        reader: BufReader::new(reader_stream),
        writer: stream,
        token,
        next_id: 1,
        socket_directory,
        capabilities: Value::Null,
        helper_process,
    };
    let handshake = connection.request("handshake", &serde_json::json!({}))?;
    match accept_handshake_capabilities(handshake) {
        Ok(capabilities) => {
            connection.capabilities = capabilities;
            Ok(connection)
        }
        Err(failure) => {
            connection.shutdown();
            Err(failure)
        }
    }
}

fn connect_with_retry(
    socket_path: &Path,
    helper_process: &mut Child,
) -> Result<UnixStream, ExecutorFailure> {
    let deadline = Instant::now() + HELPER_CONNECT_TIMEOUT;
    loop {
        if let Ok(Some(status)) = helper_process.try_wait() {
            return Err(ExecutorFailure::new(
                "accessibility_error",
                format!(
                    "native macOS helper app exited before connecting: code {}",
                    status.code().unwrap_or(-1)
                ),
            ));
        }
        match UnixStream::connect(socket_path) {
            Ok(stream) => return Ok(stream),
            Err(_) if Instant::now() < deadline => thread::sleep(HELPER_CONNECT_RETRY_DELAY),
            Err(error) => {
                return Err(ExecutorFailure::new(
                    "accessibility_error",
                    format!("timed out connecting to native macOS helper: {error}"),
                ));
            }
        }
    }
}
