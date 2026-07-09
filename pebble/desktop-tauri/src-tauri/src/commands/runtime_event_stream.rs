use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State};

/// Renderer-facing event name for pushed runtime events.
const RUNTIME_EVENT: &str = "pebble://runtime-event";
/// Renderer-facing event carrying push connection state so TS can toggle its polling fallback.
const RUNTIME_EVENT_STATUS: &str = "pebble://runtime-event-status";
const RUNTIME_EVENTS_PATH: &str = "/v1/events";
/// Backoff bounds for reconnecting to the runtime SSE stream.
const RECONNECT_MIN: Duration = Duration::from_millis(500);
const RECONNECT_MAX: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventStreamStartCommand {
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventStreamStartResult {
    /// True when this platform can run the push pipeline at all; false forces polling.
    /// It does NOT assert a live connection — connection state flows over the status event
    /// so the renderer keeps polling until a `connected: true` status arrives.
    pub supported: bool,
    pub event_name: &'static str,
    pub status_event_name: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventStreamStatus {
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventPush {
    pub id: Option<String>,
    pub topic: Option<String>,
    pub data: String,
}

#[derive(Default)]
pub struct RuntimeEventStreamState {
    started: AtomicBool,
    task: Mutex<Option<JoinHandle<()>>>,
}

/// Starts a single background task that connects to the runtime SSE stream and re-emits
/// each event to the renderer. Idempotent: repeated calls are a no-op while a task is live.
#[tauri::command]
pub async fn start_runtime_event_stream(
    app: AppHandle,
    state: State<'_, RuntimeEventStreamState>,
    input: RuntimeEventStreamStartCommand,
) -> Result<RuntimeEventStreamStartResult, String> {
    // Build the client before claiming support so a platform that can't stream falls back
    // to polling instead of silently going dark.
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?;

    if state.started.swap(true, Ordering::SeqCst) {
        return Ok(supported());
    }

    // Why: `supported` only means the pipeline can run, not that it is connected. The task
    // emits a `connected` status on each connect/disconnect transition; until the first
    // `connected: true` arrives the renderer must keep polling, which closes the dead-state
    // gap under every up/down ordering (unreachable-at-invoke, dies-later, up-later).
    let runtime_url = input.runtime_url;
    let bearer_token = input.bearer_token;
    let app_for_task = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        run_event_stream(app_for_task, client, runtime_url, bearer_token).await;
    });
    if let Ok(mut slot) = state.task.lock() {
        *slot = Some(handle);
    }

    Ok(supported())
}

/// Stops the background stream task, letting the renderer fall back to polling.
#[tauri::command]
pub fn stop_runtime_event_stream(app: AppHandle) {
    let state = app.state::<RuntimeEventStreamState>();
    state.started.store(false, Ordering::SeqCst);
    let handle = state.task.lock().ok().and_then(|mut slot| slot.take());
    if let Some(handle) = handle {
        handle.abort();
    }
    // Aborting the task skips its own disconnect emit, so signal it here to re-arm polling.
    emit_status(&app, false);
}

fn supported() -> RuntimeEventStreamStartResult {
    RuntimeEventStreamStartResult {
        supported: true,
        event_name: RUNTIME_EVENT,
        status_event_name: RUNTIME_EVENT_STATUS,
    }
}

fn emit_status(app: &AppHandle, connected: bool) {
    let _ = app.emit(RUNTIME_EVENT_STATUS, RuntimeEventStreamStatus { connected });
}

async fn run_event_stream(
    app: AppHandle,
    client: reqwest::Client,
    runtime_url: String,
    bearer_token: Option<String>,
) {
    let url = format!(
        "{}{}",
        runtime_url.trim_end_matches('/'),
        RUNTIME_EVENTS_PATH
    );
    let mut backoff = RECONNECT_MIN;
    loop {
        if app.get_webview_window("main").is_none() && app.webview_windows().is_empty() {
            return;
        }
        let outcome = connect_and_stream(&app, &client, &url, bearer_token.as_deref()).await;
        match outcome {
            // A connected stream (with or without bytes yet) resets backoff; failure keeps it.
            StreamOutcome::Emitted | StreamOutcome::Idle => backoff = RECONNECT_MIN,
            StreamOutcome::Failed => {}
        }
        sleep(backoff).await;
        backoff = (backoff * 2).min(RECONNECT_MAX);
    }
}

enum StreamOutcome {
    Emitted,
    Idle,
    Failed,
}

async fn connect_and_stream(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    bearer_token: Option<&str>,
) -> StreamOutcome {
    let mut request = client.get(url).header("Accept", "text/event-stream");
    if let Some(token) = bearer_token {
        request = request.bearer_auth(token);
    }
    let mut response = match request.send().await {
        Ok(response) if response.status().is_success() => response,
        // No `connected` was emitted, so polling stays armed on the renderer.
        _ => return StreamOutcome::Failed,
    };

    // The HTTP stream is live; tell the renderer to stop polling before any bytes arrive.
    emit_status(app, true);
    let outcome = drain_stream(app, &mut response).await;
    // Any exit from the drain means the stream dropped; re-arm the renderer's polling.
    emit_status(app, false);
    outcome
}

async fn drain_stream(app: &AppHandle, response: &mut reqwest::Response) -> StreamOutcome {
    let mut parser = SseParser::default();
    let mut emitted = false;
    loop {
        match response.chunk().await {
            Ok(Some(bytes)) => {
                for event in parser.push(&bytes) {
                    let _ = app.emit(RUNTIME_EVENT, event);
                    emitted = true;
                }
            }
            Ok(None) => break,
            Err(_) => {
                return if emitted {
                    StreamOutcome::Emitted
                } else {
                    StreamOutcome::Failed
                };
            }
        }
    }
    if emitted {
        StreamOutcome::Emitted
    } else {
        StreamOutcome::Idle
    }
}

/// Incremental SSE parser: accumulates bytes and yields one push per complete event block.
#[derive(Default)]
struct SseParser {
    buffer: String,
    id: Option<String>,
    topic: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    fn push(&mut self, bytes: &[u8]) -> Vec<RuntimeEventPush> {
        self.buffer.push_str(&String::from_utf8_lossy(bytes));
        let mut events = Vec::new();
        while let Some(newline) = self.buffer.find('\n') {
            let line = self.buffer[..newline].trim_end_matches('\r').to_string();
            self.buffer.drain(..=newline);
            if line.is_empty() {
                if let Some(event) = self.take_event() {
                    events.push(event);
                }
                continue;
            }
            // Comment lines (heartbeats) start with ':' and carry no event data.
            if line.starts_with(':') {
                continue;
            }
            self.apply_field(&line);
        }
        events
    }

    fn apply_field(&mut self, line: &str) {
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "id" => self.id = Some(value.to_string()),
            "event" => self.topic = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            _ => {}
        }
    }

    fn take_event(&mut self) -> Option<RuntimeEventPush> {
        if self.data.is_empty() && self.id.is_none() && self.topic.is_none() {
            return None;
        }
        let event = RuntimeEventPush {
            id: self.id.take(),
            topic: self.topic.take(),
            data: self.data.join("\n"),
        };
        self.data.clear();
        Some(event)
    }
}

// Sleep without a direct tokio dependency: the blocking wait runs on the runtime's blocking pool.
async fn sleep(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

fn default_runtime_url() -> String {
    pebble_rust_host::DEFAULT_RUNTIME_URL.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_event_block() {
        let mut parser = SseParser::default();
        let events = parser.push(b"id: evt_1\nevent: project.changed\ndata: {\"a\":1}\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id.as_deref(), Some("evt_1"));
        assert_eq!(events[0].topic.as_deref(), Some("project.changed"));
        assert_eq!(events[0].data, "{\"a\":1}");
    }

    #[test]
    fn ignores_heartbeat_comments() {
        let mut parser = SseParser::default();
        assert!(parser.push(b": heartbeat\n\n").is_empty());
    }

    #[test]
    fn handles_event_split_across_chunks() {
        let mut parser = SseParser::default();
        assert!(parser.push(b"event: session.output\nda").is_empty());
        let events = parser.push(b"ta: hello\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].topic.as_deref(), Some("session.output"));
        assert_eq!(events[0].data, "hello");
    }

    #[test]
    fn joins_multiline_data() {
        let mut parser = SseParser::default();
        let events = parser.push(b"data: line1\ndata: line2\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "line1\nline2");
    }

    #[test]
    fn start_result_advertises_status_event() {
        // The renderer gates its polling fallback on this event name, so it must always ship.
        let result = supported();
        assert!(result.supported);
        assert_eq!(result.event_name, RUNTIME_EVENT);
        assert_eq!(result.status_event_name, RUNTIME_EVENT_STATUS);
    }

    #[test]
    fn parses_multiple_events_including_heartbeat() {
        // A heartbeat between two blocks must not swallow or merge either event.
        let mut parser = SseParser::default();
        let events = parser.push(b"event: a\ndata: 1\n\n: heartbeat\nevent: b\ndata: 2\n\n");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].topic.as_deref(), Some("a"));
        assert_eq!(events[0].data, "1");
        assert_eq!(events[1].topic.as_deref(), Some("b"));
        assert_eq!(events[1].data, "2");
    }
}
