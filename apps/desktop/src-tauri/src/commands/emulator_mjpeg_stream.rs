use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, WebviewWindow};
use tokio::sync::oneshot;
use uuid::Uuid;

const MAX_PENDING_BYTES: usize = 2 * 1024 * 1024;
const MIN_FRAME_INTERVAL: Duration = Duration::from_millis(33);
const RECONNECT_DELAY: Duration = Duration::from_secs(1);

#[derive(Default)]
pub struct EmulatorMjpegStreamState {
    sessions: std::sync::Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartFrameStreamInput {
    stream_url: String,
    stream_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopFrameStreamInput {
    stream_id: String,
}

#[derive(Serialize)]
pub struct StartFrameStreamResult {
    #[serde(rename = "streamId")]
    stream_id: String,
}

#[derive(Clone, Serialize)]
struct FramePayload {
    #[serde(rename = "streamId")]
    stream_id: String,
    #[serde(rename = "contentBase64")]
    content_base64: String,
}

#[derive(Clone, Serialize)]
struct StreamErrorPayload {
    #[serde(rename = "streamId")]
    stream_id: String,
    message: String,
}

#[tauri::command]
pub fn emulator_frame_stream_start(
    window: WebviewWindow,
    state: tauri::State<'_, EmulatorMjpegStreamState>,
    input: StartFrameStreamInput,
) -> Result<StartFrameStreamResult, String> {
    let url = normalize_stream_url(&input.stream_url, input.stream_key.as_deref())?;
    let stream_id = Uuid::new_v4().to_string();
    let (cancel, canceled) = oneshot::channel();
    state
        .sessions
        .lock()
        .map_err(|_| "emulator stream registry is unavailable".to_string())?
        .insert(stream_id.clone(), cancel);
    let task_stream_id = stream_id.clone();
    let registry_stream_id = stream_id.clone();
    let sessions = state.sessions.clone();
    tauri::async_runtime::spawn(async move {
        run_stream(window, task_stream_id, url, canceled).await;
        // Why: failed/cancelled streams must release their registry slot even
        // when the renderer never gets a chance to issue an explicit stop.
        if let Ok(mut sessions) = sessions.lock() {
            sessions.remove(&registry_stream_id);
        }
    });
    Ok(StartFrameStreamResult { stream_id })
}

#[tauri::command]
pub fn emulator_frame_stream_stop(
    state: tauri::State<'_, EmulatorMjpegStreamState>,
    input: StopFrameStreamInput,
) -> Result<(), String> {
    if let Some(cancel) = state
        .sessions
        .lock()
        .map_err(|_| "emulator stream registry is unavailable".to_string())?
        .remove(&input.stream_id)
    {
        let _ = cancel.send(());
    }
    Ok(())
}

async fn run_stream(
    window: WebviewWindow,
    stream_id: String,
    url: reqwest::Url,
    mut canceled: oneshot::Receiver<()>,
) {
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            emit_error(&window, &stream_id, error.to_string());
            return;
        }
    };
    loop {
        let request = client.get(url.clone()).header(
            reqwest::header::ACCEPT,
            "application/octet-stream, image/jpeg",
        );
        let response = tokio::select! {
            _ = &mut canceled => return,
            response = request.send() => response,
        };
        match response {
            Ok(response) if response.status().is_success() => {
                let mut bytes = response.bytes_stream();
                let mut parser = JpegFrameParser::default();
                let mut last_frame = None;
                loop {
                    let next = tokio::select! {
                        _ = &mut canceled => return,
                        chunk = bytes.next() => chunk,
                    };
                    let Some(chunk) = next else { break };
                    match chunk {
                        Ok(chunk) => {
                            for frame in parser.push(&chunk) {
                                let now = Instant::now();
                                if last_frame
                                    .is_some_and(|at| now.duration_since(at) < MIN_FRAME_INTERVAL)
                                {
                                    continue;
                                }
                                last_frame = Some(now);
                                let _ = window.emit(
                                    "pebble:emulator-frame",
                                    FramePayload {
                                        stream_id: stream_id.clone(),
                                        content_base64: BASE64_STANDARD.encode(frame),
                                    },
                                );
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
            Ok(response) => emit_error(
                &window,
                &stream_id,
                format!("Simulator stream returned HTTP {}.", response.status()),
            ),
            Err(error) => emit_error(&window, &stream_id, error.to_string()),
        }
        tokio::select! {
            _ = &mut canceled => return,
            _ = tokio::time::sleep(RECONNECT_DELAY) => {},
        }
    }
}

fn emit_error(window: &WebviewWindow, stream_id: &str, message: String) {
    let _ = window.emit(
        "pebble:emulator-frame-error",
        StreamErrorPayload {
            stream_id: stream_id.to_string(),
            message,
        },
    );
}

fn normalize_stream_url(
    stream_url: &str,
    stream_key: Option<&str>,
) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(stream_url).map_err(|_| "Simulator stream URL is invalid")?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Simulator stream must use http or https.".to_string());
    }
    if !url.path().ends_with("/stream.mjpeg") {
        return Err("Simulator stream must target stream.mjpeg.".to_string());
    }
    url.query_pairs_mut().append_pair("raw", "1");
    if let Some(key) = stream_key.filter(|value| !value.is_empty()) {
        url.query_pairs_mut().append_pair("_pebble", key);
    }
    Ok(url)
}

#[derive(Default)]
struct JpegFrameParser {
    pending: Vec<u8>,
}

impl JpegFrameParser {
    fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.pending.extend_from_slice(chunk);
        let mut frames = Vec::new();
        loop {
            let Some(start) = find_pair(&self.pending, [0xff, 0xd8], 0) else {
                self.pending = if self.pending.last() == Some(&0xff) {
                    vec![0xff]
                } else {
                    Vec::new()
                };
                break;
            };
            if start > 0 {
                self.pending.drain(..start);
            }
            let Some(end) = find_pair(&self.pending, [0xff, 0xd9], 2) else {
                if self.pending.len() > MAX_PENDING_BYTES {
                    let keep_from = self.pending.len() - MAX_PENDING_BYTES;
                    self.pending.drain(..keep_from);
                }
                break;
            };
            frames.push(self.pending.drain(..end + 2).collect());
        }
        frames
    }
}

fn find_pair(bytes: &[u8], pair: [u8; 2], from: usize) -> Option<usize> {
    bytes
        .get(from..)?
        .windows(2)
        .position(|window| window == pair)
        .map(|offset| offset + from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_handles_split_and_multiple_frames() {
        let mut parser = JpegFrameParser::default();
        assert!(parser.push(&[0xff, 0xd8, 1]).is_empty());
        assert_eq!(
            parser.push(&[2, 0xff, 0xd9, 0xff, 0xd8, 3, 0xff, 0xd9]),
            vec![
                vec![0xff, 0xd8, 1, 2, 0xff, 0xd9],
                vec![0xff, 0xd8, 3, 0xff, 0xd9]
            ]
        );
    }

    #[test]
    fn stream_url_requires_the_mjpeg_endpoint() {
        assert!(normalize_stream_url("file:///tmp/stream.mjpeg", None).is_err());
        assert!(normalize_stream_url("http://127.0.0.1/frame", None).is_err());
        let url = normalize_stream_url("http://127.0.0.1/stream.mjpeg", Some("secret")).unwrap();
        assert!(url.as_str().contains("raw=1"));
        assert!(url.as_str().contains("_pebble=secret"));
    }
}
