use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use reqwest::{Client, StatusCode, Url};
use serde::Deserialize;
use tauri::State;
use tokio::sync::mpsc;

use super::runtime_process::RuntimeProcessState;

const DEFAULT_RUNTIME_URL: &str = "http://127.0.0.1:17777";
const INPUT_QUEUE_CAPACITY: usize = 256;
const INPUT_WORKER_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

static CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_nodelay(true)
        .build()
        .expect("runtime PTY HTTP client must build")
});

static INPUT_WORKERS: LazyLock<Mutex<HashMap<String, mpsc::Sender<QueuedRuntimePtyInput>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
struct QueuedRuntimePtyInput {
    input: RuntimePtyInputCommand,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePtyInputCommand {
    pub session_id: String,
    pub text: String,
    #[serde(default = "default_runtime_url")]
    pub runtime_url: String,
    #[serde(default)]
    pub bearer_token: Option<String>,
}

#[tauri::command]
pub async fn write_runtime_pty_input(
    mut input: RuntimePtyInputCommand,
    state: State<'_, RuntimeProcessState>,
) -> Result<bool, String> {
    if let Some((runtime_url, bearer_token)) = state.local_connection()? {
        // Why: renderer reloads can rotate sessionStorage credentials while the
        // managed runtime stays alive. Native process state remains authoritative.
        input.runtime_url = runtime_url;
        input.bearer_token = bearer_token;
    }
    let worker_key = input_worker_key(&input);
    let queued = QueuedRuntimePtyInput { input };
    let sender = input_worker(&worker_key)?;
    match sender.try_send(queued) {
        Ok(()) => Ok(true),
        Err(mpsc::error::TrySendError::Full(_)) => Ok(false),
        Err(mpsc::error::TrySendError::Closed(queued)) => {
            remove_input_worker(&worker_key);
            input_worker(&worker_key)?
                .try_send(queued)
                .map(|()| true)
                .map_err(|error| format!("runtime PTY input queue unavailable: {error}"))
        }
    }
}

fn input_worker(worker_key: &str) -> Result<mpsc::Sender<QueuedRuntimePtyInput>, String> {
    let mut workers = INPUT_WORKERS
        .lock()
        .map_err(|_| "runtime PTY input worker registry is poisoned".to_string())?;
    if let Some(sender) = workers.get(worker_key) {
        if !sender.is_closed() {
            return Ok(sender.clone());
        }
    }
    let (sender, receiver) = mpsc::channel(INPUT_QUEUE_CAPACITY);
    workers.insert(worker_key.to_string(), sender.clone());
    tauri::async_runtime::spawn(run_input_worker(receiver));
    Ok(sender)
}

async fn run_input_worker(mut receiver: mpsc::Receiver<QueuedRuntimePtyInput>) {
    loop {
        let mut queued =
            match tokio::time::timeout(INPUT_WORKER_IDLE_TIMEOUT, receiver.recv()).await {
                Ok(Some(queued)) => queued,
                _ => break,
            };
        // Why: Tauri invokes can arrive faster than the HTTP runtime round trip.
        // Collapse already queued bytes before posting while preserving PTY order.
        while let Ok(next) = receiver.try_recv() {
            queued.input.text.push_str(&next.input.text);
        }
        // Why: renderer input must never wait for the runtime HTTP acknowledgement.
        // This worker preserves byte order while keeping network jitter off the UI path.
        let _ = post_runtime_pty_input(queued.input).await;
    }
    if let Ok(mut workers) = INPUT_WORKERS.lock() {
        workers.retain(|_, sender| !sender.is_closed());
    }
}

fn remove_input_worker(worker_key: &str) {
    if let Ok(mut workers) = INPUT_WORKERS.lock() {
        workers.remove(worker_key);
    }
}

fn input_worker_key(input: &RuntimePtyInputCommand) -> String {
    format!("{}\n{}", input.runtime_url, input.session_id)
}

async fn post_runtime_pty_input(input: RuntimePtyInputCommand) -> Result<bool, String> {
    let url = runtime_input_url(&input.runtime_url, &input.session_id)?;
    let mut request = CLIENT
        .post(url)
        .timeout(Duration::from_millis(1500))
        .json(&serde_json::json!({ "text": input.text, "source": "desktop" }));
    if let Some(token) = input.bearer_token {
        request = request.bearer_auth(token);
    }

    let response = request.send().await.map_err(|error| error.to_string())?;
    if response.status().is_success() {
        return Ok(true);
    }
    if response.status() == StatusCode::LOCKED {
        return Ok(false);
    }
    Err(format!(
        "runtime PTY input failed with HTTP {}",
        response.status()
    ))
}

fn runtime_input_url(runtime_url: &str, session_id: &str) -> Result<Url, String> {
    let mut base = Url::parse(runtime_url).map_err(|error| error.to_string())?;
    if !matches!(base.scheme(), "http" | "https") {
        return Err("runtime PTY input requires an HTTP(S) runtime URL".to_string());
    }
    base.set_path("");
    base.set_query(None);
    base.set_fragment(None);
    base.path_segments_mut()
        .map_err(|_| "runtime URL cannot be a base URL".to_string())?
        .extend(["v1", "sessions", session_id, "input"]);
    Ok(base)
}

fn default_runtime_url() -> String {
    DEFAULT_RUNTIME_URL.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_session_ids_as_one_path_segment() {
        let url = runtime_input_url(DEFAULT_RUNTIME_URL, "session/with spaces").unwrap();
        assert_eq!(
            url.as_str(),
            "http://127.0.0.1:17777/v1/sessions/session%2Fwith%20spaces/input"
        );
    }

    #[test]
    fn rejects_non_http_runtime_urls() {
        assert!(runtime_input_url("file:///tmp/runtime", "session-1").is_err());
    }
}
