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
    request_timeout: Duration,
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
        let capabilities = &self.ensure_connection()?.capabilities;
        ensure_method_supported(capabilities, method)?;
        self.request(method, params)
    }
}

fn ensure_method_supported(capabilities: &Value, method: &str) -> Result<(), ExecutorFailure> {
    let capability = match method {
        "listWindows" => capabilities.pointer("/supports/windows/list"),
        "click" => capabilities.pointer("/supports/actions/click"),
        "performSecondaryAction" => capabilities.pointer("/supports/actions/performAction"),
        "scroll" => capabilities.pointer("/supports/actions/scroll"),
        "drag" => capabilities.pointer("/supports/actions/drag"),
        "typeText" => capabilities.pointer("/supports/actions/typeText"),
        "pressKey" => capabilities.pointer("/supports/actions/pressKey"),
        "hotkey" => capabilities.pointer("/supports/actions/hotkey"),
        "pasteText" => capabilities.pointer("/supports/actions/pasteText"),
        "setValue" => capabilities.pointer("/supports/actions/setValue"),
        // Legacy behavior does not capability-gate listApps or getAppState.
        "listApps" | "getAppState" => return Ok(()),
        _ => None,
    };
    if capability.and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    Err(ExecutorFailure::new(
        "unsupported_capability",
        format!("native macOS provider does not support {method}"),
    ))
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
        let deadline = Instant::now() + self.request_timeout;
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
    fs::set_permissions(&socket_directory, fs::Permissions::from_mode(0o700)).map_err(|error| {
        let failure = ExecutorFailure::new(
            "accessibility_error",
            format!("could not secure helper socket directory: {error}"),
        );
        let _ = fs::remove_dir_all(&socket_directory);
        failure
    })?;
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
    fs::set_permissions(&token_path, fs::Permissions::from_mode(0o600)).map_err(|error| {
        cleanup_and_fail(ExecutorFailure::new(
            "accessibility_error",
            format!("could not secure helper token file: {error}"),
        ))
    })?;

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
        request_timeout: HELPER_REQUEST_TIMEOUT,
    };
    let handshake = match connection.request("handshake", &serde_json::json!({})) {
        Ok(handshake) => handshake,
        Err(failure) => {
            connection.shutdown();
            return Err(failure);
        }
    };
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::Duration;

    use serde_json::Value;
    use uuid::Uuid;

    use super::{ensure_method_supported, HelperConnection, HelperSocketExecutor};
    use crate::commands::computer_use_action_translation::ComputerActionExecutor;

    fn test_connection(request_timeout: Duration) -> (HelperConnection, UnixStream) {
        let (client, server) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(request_timeout)).unwrap();
        let reader = BufReader::new(client.try_clone().unwrap());
        let socket_directory = std::env::temp_dir().join(format!(
            "pebble-computer-use-socket-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&socket_directory).unwrap();
        let helper_process = Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        (
            HelperConnection {
                reader,
                writer: client,
                token: "test-token".to_string(),
                next_id: 1,
                socket_directory,
                capabilities: serde_json::json!({
                    "supports": { "actions": { "click": true } }
                }),
                helper_process,
                request_timeout,
            },
            server,
        )
    }

    #[test]
    fn rejects_actions_not_advertised_by_the_helper() {
        let capabilities = serde_json::json!({
            "supports": {
                "windows": { "list": true },
                "actions": { "click": true, "performAction": false }
            }
        });
        assert!(ensure_method_supported(&capabilities, "click").is_ok());
        assert!(ensure_method_supported(&capabilities, "listWindows").is_ok());
        let failure = ensure_method_supported(&capabilities, "performSecondaryAction").unwrap_err();
        assert_eq!(failure.code, "unsupported_capability");
        assert!(ensure_method_supported(&capabilities, "pasteText").is_err());
    }

    #[test]
    fn preserves_legacy_ungated_queries() {
        let capabilities = serde_json::json!({});
        assert!(ensure_method_supported(&capabilities, "listApps").is_ok());
        assert!(ensure_method_supported(&capabilities, "getAppState").is_ok());
    }

    #[test]
    fn skips_malformed_and_stale_responses_before_matching_id() {
        let (mut connection, server) = test_connection(Duration::from_secs(1));
        let responder = thread::spawn(move || {
            let mut reader = BufReader::new(server.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            let request: Value = serde_json::from_str(request.trim()).unwrap();
            assert_eq!(request["token"], "test-token");
            let mut writer = server;
            writer.write_all(b"not-json\n").unwrap();
            writer
                .write_all(b"{\"id\":99,\"ok\":true,\"result\":{}}\n")
                .unwrap();
            writer
                .write_all(b"{\"id\":1,\"ok\":true,\"result\":{\"ready\":true}}\n")
                .unwrap();
        });

        let result = connection
            .request("click", &serde_json::json!({ "x": 1, "y": 2 }))
            .unwrap();

        assert_eq!(result, serde_json::json!({ "ready": true }));
        responder.join().unwrap();
        connection.shutdown();
    }

    #[test]
    fn preserves_typed_helper_errors() {
        let (mut connection, server) = test_connection(Duration::from_secs(1));
        let responder = thread::spawn(move || {
            let mut reader = BufReader::new(server.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            let mut writer = server;
            writer
                .write_all(
                    b"{\"id\":1,\"ok\":false,\"error\":{\"code\":\"window_not_focused\",\"message\":\"focus changed\"}}\n",
                )
                .unwrap();
        });

        let failure = connection
            .request("click", &serde_json::json!({}))
            .unwrap_err();

        assert_eq!(failure.code, "window_not_focused");
        assert_eq!(failure.message, "focus changed");
        responder.join().unwrap();
        connection.shutdown();
    }

    #[test]
    fn transport_failure_drops_connection_before_next_action() {
        let (connection, server) = test_connection(Duration::from_millis(20));
        drop(server);
        let mut executor = HelperSocketExecutor {
            helper_executable: "/missing-helper".into(),
            connection: Some(connection),
        };

        let failure = executor.call("click", &serde_json::json!({})).unwrap_err();

        assert_eq!(failure.code, "accessibility_error");
        assert!(executor.connection.is_none());
    }

    #[test]
    fn request_timeout_drops_connection_before_next_action() {
        let (connection, server) = test_connection(Duration::from_millis(20));
        let responder = thread::spawn(move || {
            let mut reader = BufReader::new(server);
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            thread::sleep(Duration::from_millis(100));
        });
        let mut executor = HelperSocketExecutor {
            helper_executable: "/missing-helper".into(),
            connection: Some(connection),
        };

        let failure = executor.call("click", &serde_json::json!({})).unwrap_err();

        assert_eq!(failure.code, "action_timeout");
        assert!(executor.connection.is_none());
        responder.join().unwrap();
    }
}
