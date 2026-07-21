use std::time::Duration;

use tauri::ipc::{InvokeBody, Request};

const STREAM_ID_HEADER: &str = "x-pebble-screencast-id";
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[tauri::command]
pub async fn browser_screencast_forward_frame(request: Request<'_>) -> Result<(), String> {
    let stream_id = request
        .headers()
        .get(STREAM_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(|| "browser screencast stream id is required".to_string())?
        .to_string();
    let frame = match request.body() {
        InvokeBody::Raw(bytes) if !bytes.is_empty() && bytes.len() <= MAX_FRAME_BYTES => {
            bytes.clone()
        }
        InvokeBody::Raw(_) => return Err("browser screencast frame size is invalid".to_string()),
        InvokeBody::Json(_) => return Err("browser screencast frame must use raw IPC".to_string()),
    };
    let response = reqwest::Client::new()
        .post(format!(
            "http://127.0.0.1:17777/v1/browser/screencasts/{}/frames",
            urlencoding::encode(&stream_id)
        ))
        .timeout(Duration::from_secs(5))
        .header("content-type", "application/octet-stream")
        .body(frame)
        .send()
        .await
        .map_err(|error| format!("browser screencast runtime forward failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "browser screencast runtime rejected frame with HTTP {}",
            response.status()
        ));
    }
    Ok(())
}
