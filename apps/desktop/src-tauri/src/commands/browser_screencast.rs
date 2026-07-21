use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Notify;

use super::browser_child_webview::browser_webview_screenshot::capture_platform_webview;
use super::browser_child_webview::{BrowserScreenshotFormat, BROWSER_WEBVIEW_LABEL_PREFIX};

const FRAME_HEADER_BYTES: usize = 16;
const FRAME_KIND: u8 = 0x62;
const FRAME_VERSION: u8 = 1;
const FRAME_OPCODE: u8 = 1;
const DIRTY_POLL_INTERVAL: Duration = Duration::from_millis(250);
const SAFETY_CAPTURE_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct BrowserScreencastState {
    streams: Mutex<HashMap<String, Arc<BrowserScreencastControl>>>,
}

struct BrowserScreencastControl {
    label: String,
    cancelled: AtomicBool,
    dirty: AtomicBool,
    acknowledged_seq: AtomicU32,
    changed: Notify,
}

impl BrowserScreencastControl {
    fn new(label: String) -> Self {
        Self {
            label,
            cancelled: AtomicBool::new(false),
            dirty: AtomicBool::new(true),
            acknowledged_seq: AtomicU32::new(0),
            changed: Notify::new(),
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.changed.notify_waiters();
    }

    fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Release);
        self.changed.notify_waiters();
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreencastStartInput {
    label: String,
    format: BrowserScreenshotFormat,
    min_frame_interval_ms: Option<u64>,
    device_scale_factor: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreencastStreamInput {
    stream_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreencastAckInput {
    stream_id: String,
    seq: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreencastStartResult {
    stream_id: String,
}

#[tauri::command]
pub async fn browser_screencast_start(
    app: AppHandle,
    state: State<'_, BrowserScreencastState>,
    input: BrowserScreencastStartInput,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<BrowserScreencastStartResult, String> {
    validate_label(&input.label)?;
    if app.get_webview(&input.label).is_none() {
        return Err("browser webview is not available".to_string());
    }
    let interval =
        Duration::from_millis(input.min_frame_interval_ms.unwrap_or(50).clamp(16, 10_000));
    let device_scale_factor = input.device_scale_factor.unwrap_or(1.0).clamp(0.25, 8.0);
    let stream_id = format!("browser-screencast:{}", uuid::Uuid::new_v4());
    let control = Arc::new(BrowserScreencastControl::new(input.label.clone()));
    state
        .streams
        .lock()
        .map_err(|_| "browser screencast state is unavailable".to_string())?
        .insert(stream_id.clone(), control.clone());

    let task_app = app.clone();
    let task_stream_id = stream_id.clone();
    tauri::async_runtime::spawn(async move {
        run_screencast(
            task_app.clone(),
            task_stream_id.clone(),
            input.label,
            input.format,
            device_scale_factor,
            interval,
            control,
            on_frame,
        )
        .await;
        if let Ok(mut streams) = task_app.state::<BrowserScreencastState>().streams.lock() {
            streams.remove(&task_stream_id);
        }
    });

    Ok(BrowserScreencastStartResult { stream_id })
}

#[tauri::command]
pub fn browser_screencast_mark_dirty(
    webview: tauri::Webview,
    state: State<'_, BrowserScreencastState>,
) -> Result<(), String> {
    let label = webview.label();
    validate_label(label)?;
    let streams = state
        .streams
        .lock()
        .map_err(|_| "browser screencast state is unavailable".to_string())?;
    for control in streams.values().filter(|control| control.label == label) {
        control.mark_dirty();
    }
    Ok(())
}

#[tauri::command]
pub fn browser_screencast_ack(
    state: State<'_, BrowserScreencastState>,
    input: BrowserScreencastAckInput,
) -> Result<(), String> {
    let streams = state
        .streams
        .lock()
        .map_err(|_| "browser screencast state is unavailable".to_string())?;
    let Some(control) = streams.get(&input.stream_id) else {
        return Ok(());
    };
    control
        .acknowledged_seq
        .fetch_max(input.seq, Ordering::AcqRel);
    control.changed.notify_waiters();
    Ok(())
}

#[tauri::command]
pub fn browser_screencast_stop(
    state: State<'_, BrowserScreencastState>,
    input: BrowserScreencastStreamInput,
) -> Result<(), String> {
    let control = state
        .streams
        .lock()
        .map_err(|_| "browser screencast state is unavailable".to_string())?
        .remove(&input.stream_id);
    if let Some(control) = control {
        control.cancel();
    }
    Ok(())
}

async fn run_screencast(
    app: AppHandle,
    stream_id: String,
    label: String,
    format: BrowserScreenshotFormat,
    device_scale_factor: f64,
    interval: Duration,
    control: Arc<BrowserScreencastControl>,
    on_frame: Channel<InvokeResponseBody>,
) {
    let mut seq = 1_u32;
    let mut last_image: Option<Vec<u8>> = None;
    let mut last_capture = tokio::time::Instant::now() - SAFETY_CAPTURE_INTERVAL;
    while !control.cancelled.load(Ordering::Acquire) {
        let dirty = control.dirty.swap(false, Ordering::AcqRel);
        if !dirty && last_capture.elapsed() < SAFETY_CAPTURE_INTERVAL {
            tokio::select! {
                _ = tokio::time::sleep(DIRTY_POLL_INTERVAL) => {},
                _ = control.changed.notified() => {},
            }
            continue;
        }
        let remaining_interval = interval.saturating_sub(last_capture.elapsed());
        if !remaining_interval.is_zero() {
            tokio::time::sleep(remaining_interval).await;
        }
        let started_at = tokio::time::Instant::now();
        let bytes = match capture_frame(&app, &label, format, device_scale_factor).await {
            Ok(bytes) if !bytes.is_empty() => bytes,
            _ => break,
        };
        last_capture = tokio::time::Instant::now();
        let duplicate = last_image.as_deref() == Some(bytes.as_slice());
        if !duplicate {
            last_image = Some(bytes.clone());
            let frame = encode_frame(seq, format, &bytes, capture_timestamp());
            if on_frame.send(InvokeResponseBody::Raw(frame)).is_err() {
                break;
            }
            // Why: a raw IPC frame is retained until the renderer confirms it;
            // this bounds capture and transport memory for slow remote clients.
            while control.acknowledged_seq.load(Ordering::Acquire) < seq
                && !control.cancelled.load(Ordering::Acquire)
            {
                control.changed.notified().await;
            }
            seq = seq.wrapping_add(1).max(1);
        }
        let remaining = interval.saturating_sub(started_at.elapsed());
        if !remaining.is_zero() {
            tokio::select! {
                _ = tokio::time::sleep(remaining) => {},
                _ = control.changed.notified() => {},
            }
        }
    }
    control.cancel();
    let _ = stream_id;
}

async fn capture_frame(
    app: &AppHandle,
    label: &str,
    format: BrowserScreenshotFormat,
    device_scale_factor: f64,
) -> Result<Vec<u8>, String> {
    let webview = app
        .get_webview(label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let _ = sender.send(capture_platform_webview(
                platform_webview,
                format,
                None,
                device_scale_factor,
            ));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "browser screencast callback was dropped".to_string())?
}

fn encode_frame(
    seq: u32,
    format: BrowserScreenshotFormat,
    image: &[u8],
    timestamp: f64,
) -> Vec<u8> {
    let metadata = format!("{{\"timestamp\":{timestamp}}}");
    let metadata_bytes = metadata.as_bytes();
    let mut frame = vec![0_u8; FRAME_HEADER_BYTES + metadata_bytes.len() + image.len()];
    frame[0] = FRAME_KIND;
    frame[1] = FRAME_VERSION;
    frame[2] = FRAME_OPCODE;
    frame[3] = match format {
        BrowserScreenshotFormat::Jpeg => 1,
        BrowserScreenshotFormat::Png => 2,
    };
    frame[4..8].copy_from_slice(&seq.to_le_bytes());
    frame[8..12].copy_from_slice(&(metadata_bytes.len() as u32).to_le_bytes());
    frame[FRAME_HEADER_BYTES..FRAME_HEADER_BYTES + metadata_bytes.len()]
        .copy_from_slice(metadata_bytes);
    frame[FRAME_HEADER_BYTES + metadata_bytes.len()..].copy_from_slice(image);
    frame
}

fn capture_timestamp() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

fn validate_label(label: &str) -> Result<(), String> {
    if label.starts_with(BROWSER_WEBVIEW_LABEL_PREFIX)
        && label.len() <= 256
        && label
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_:/.".contains(character))
    {
        Ok(())
    } else {
        Err("invalid browser webview label".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_shared_browser_screencast_protocol() {
        let frame = encode_frame(7, BrowserScreenshotFormat::Jpeg, &[1, 2, 3], 42.5);
        assert_eq!(&frame[0..4], &[0x62, 1, 1, 1]);
        assert_eq!(u32::from_le_bytes(frame[4..8].try_into().unwrap()), 7);
        let metadata_length = u32::from_le_bytes(frame[8..12].try_into().unwrap()) as usize;
        assert_eq!(&frame[16..16 + metadata_length], br#"{"timestamp":42.5}"#);
        assert_eq!(&frame[16 + metadata_length..], &[1, 2, 3]);
    }

    #[test]
    fn rejects_non_browser_labels() {
        assert!(validate_label("main").is_err());
        assert!(validate_label("browser-page-1").is_ok());
    }

    #[test]
    fn dirty_control_starts_dirty_and_coalesces_notifications() {
        let control = BrowserScreencastControl::new("browser-page-1".to_string());
        assert!(control.dirty.swap(false, Ordering::AcqRel));
        control.mark_dirty();
        control.mark_dirty();
        assert!(control.dirty.swap(false, Ordering::AcqRel));
        assert!(!control.dirty.load(Ordering::Acquire));
    }
}
