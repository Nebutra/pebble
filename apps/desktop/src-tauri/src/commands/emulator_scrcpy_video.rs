use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::watch;
use uuid::Uuid;

use super::emulator_scrcpy_deployment::{
    ensure_server_jar, forward_argv, push_argv, remove_forward_argv, server_argv,
};
use super::emulator_scrcpy_framing::{parse_codec_meta, ScrcpyFrameParser};

const DEVICE_HEADER_BYTES: usize = 65;
const CODEC_META_BYTES: usize = 12;
const CONNECT_ATTEMPTS: usize = 100;
const CONNECT_RETRY_DELAY: Duration = Duration::from_millis(100);
const SOCKET_READY_TIMEOUT: Duration = Duration::from_secs(2);
const START_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_GOP_FRAMES: usize = 120;
const MAX_GOP_BYTES: usize = 32 * 1024 * 1024;

#[derive(Default)]
pub struct EmulatorScrcpyVideoState {
    registry: Mutex<VideoRegistry>,
}

#[derive(Default)]
struct VideoRegistry {
    devices: HashMap<String, DeviceSession>,
    stream_devices: HashMap<String, String>,
}

struct DeviceSession {
    session_id: Uuid,
    cancel: watch::Sender<bool>,
    startup: watch::Sender<SessionStartup>,
    subscribers: HashMap<String, WebviewWindow>,
    replay: VideoReplayCache,
}

#[derive(Default)]
struct VideoReplayCache {
    meta: Option<VideoMeta>,
    config: Option<CachedVideoFrame>,
    gop: Vec<CachedVideoFrame>,
    gop_bytes: usize,
}

#[derive(Clone, Debug)]
enum SessionStartup {
    Starting,
    Ready,
    Failed(String),
}

#[derive(Clone)]
struct CachedVideoFrame {
    config: bool,
    key_frame: bool,
    pts: String,
    gop_index: u64,
    content_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartVideoStreamInput {
    device_id: String,
    stream_id: String,
    max_size: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopVideoStreamInput {
    stream_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartVideoStreamResult {
    stream_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoMetaPayload {
    stream_id: String,
    device_id: String,
    meta: VideoMeta,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoMeta {
    codec_id: String,
    width: u32,
    height: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoFramePayload {
    stream_id: String,
    device_id: String,
    config: bool,
    key_frame: bool,
    pts: String,
    gop_index: u64,
    content_base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoErrorPayload {
    stream_id: String,
    device_id: String,
    message: String,
}

#[tauri::command]
pub async fn emulator_video_stream_start(
    window: WebviewWindow,
    state: tauri::State<'_, EmulatorScrcpyVideoState>,
    input: StartVideoStreamInput,
) -> Result<StartVideoStreamResult, String> {
    validate_start_input(&input)?;
    let stream_id = input.stream_id.clone();
    if let Some(mut startup) = subscribe_existing(&state, &window, &input)? {
        await_startup(&mut startup, &state, &stream_id).await?;
        return Ok(StartVideoStreamResult { stream_id });
    }

    let local_jar = ensure_server_jar(window.app_handle()).await?;
    let (cancel, canceled) = watch::channel(false);
    let (startup_tx, mut startup) = watch::channel(SessionStartup::Starting);
    let session_id = Uuid::new_v4();
    if let Some(mut existing_startup) = register_new_or_join(
        &state,
        &window,
        &input,
        session_id,
        cancel,
        startup_tx.clone(),
    )? {
        await_startup(&mut existing_startup, &state, &stream_id).await?;
        return Ok(StartVideoStreamResult { stream_id });
    }

    let app = window.app_handle().clone();
    let device_id = input.device_id.clone();
    let max_size = input.max_size;
    tauri::async_runtime::spawn(async move {
        let result = run_scrcpy_session(&app, &device_id, max_size, &local_jar, canceled).await;
        match result {
            Ok(()) => finish_session(&app, &device_id, session_id),
            Err(message) if message.contains("cancelled") => {
                finish_session(&app, &device_id, session_id)
            }
            Err(message) => {
                let _ = startup_tx.send(SessionStartup::Failed(message.clone()));
                emit_session_error(&app, &device_id, session_id, message);
                finish_session(&app, &device_id, session_id);
            }
        }
    });

    await_startup(&mut startup, &state, &stream_id).await?;
    Ok(StartVideoStreamResult { stream_id })
}

#[tauri::command]
pub fn emulator_video_stream_stop(
    state: tauri::State<'_, EmulatorScrcpyVideoState>,
    input: StopVideoStreamInput,
) -> Result<(), String> {
    cancel_stream(&state, &input.stream_id)
}

fn cancel_stream(
    state: &tauri::State<'_, EmulatorScrcpyVideoState>,
    stream_id: &str,
) -> Result<(), String> {
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "emulator video stream registry is unavailable".to_string())?;
    let Some(device_id) = registry.stream_devices.remove(stream_id) else {
        return Ok(());
    };
    let should_remove = registry.devices.get_mut(&device_id).is_some_and(|session| {
        session.subscribers.remove(stream_id);
        session.subscribers.is_empty()
    });
    if should_remove {
        if let Some(session) = registry.devices.remove(&device_id) {
            // A device process is shared; only the last renderer subscriber owns shutdown.
            let _ = session.cancel.send(true);
        }
    }
    Ok(())
}

fn subscribe_existing(
    state: &tauri::State<'_, EmulatorScrcpyVideoState>,
    window: &WebviewWindow,
    input: &StartVideoStreamInput,
) -> Result<Option<watch::Receiver<SessionStartup>>, String> {
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "emulator video stream registry is unavailable".to_string())?;
    reject_duplicate_stream(&registry, &input.stream_id)?;
    let Some(session) = registry.devices.get_mut(&input.device_id) else {
        return Ok(None);
    };
    replay_cached(window, &input.stream_id, &input.device_id, session)?;
    session
        .subscribers
        .insert(input.stream_id.clone(), window.clone());
    let startup = session.startup.subscribe();
    registry
        .stream_devices
        .insert(input.stream_id.clone(), input.device_id.clone());
    Ok(Some(startup))
}

#[allow(clippy::too_many_arguments)]
fn register_new_or_join(
    state: &tauri::State<'_, EmulatorScrcpyVideoState>,
    window: &WebviewWindow,
    input: &StartVideoStreamInput,
    session_id: Uuid,
    cancel: watch::Sender<bool>,
    startup: watch::Sender<SessionStartup>,
) -> Result<Option<watch::Receiver<SessionStartup>>, String> {
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "emulator video stream registry is unavailable".to_string())?;
    reject_duplicate_stream(&registry, &input.stream_id)?;
    if let Some(session) = registry.devices.get_mut(&input.device_id) {
        replay_cached(window, &input.stream_id, &input.device_id, session)?;
        session
            .subscribers
            .insert(input.stream_id.clone(), window.clone());
        let existing_startup = session.startup.subscribe();
        registry
            .stream_devices
            .insert(input.stream_id.clone(), input.device_id.clone());
        return Ok(Some(existing_startup));
    }
    let mut subscribers = HashMap::new();
    subscribers.insert(input.stream_id.clone(), window.clone());
    registry.devices.insert(
        input.device_id.clone(),
        DeviceSession {
            session_id,
            cancel,
            startup,
            subscribers,
            replay: VideoReplayCache::default(),
        },
    );
    registry
        .stream_devices
        .insert(input.stream_id.clone(), input.device_id.clone());
    Ok(None)
}

fn reject_duplicate_stream(registry: &VideoRegistry, stream_id: &str) -> Result<(), String> {
    if registry.stream_devices.contains_key(stream_id) {
        Err("emulator video stream id is already active".to_string())
    } else {
        Ok(())
    }
}

async fn await_startup(
    startup: &mut watch::Receiver<SessionStartup>,
    state: &tauri::State<'_, EmulatorScrcpyVideoState>,
    stream_id: &str,
) -> Result<(), String> {
    let wait = async {
        loop {
            let status = startup.borrow().clone();
            match status {
                SessionStartup::Ready => return Ok(()),
                SessionStartup::Failed(message) => return Err(message),
                SessionStartup::Starting => startup
                    .changed()
                    .await
                    .map_err(|_| "scrcpy video session exited before becoming ready".to_string())?,
            }
        }
    };
    match tokio::time::timeout(START_TIMEOUT, wait).await {
        Ok(result) => result,
        Err(_) => {
            cancel_stream(state, stream_id)?;
            Err("scrcpy video stream did not become ready within 15 seconds".to_string())
        }
    }
}

fn replay_cached(
    window: &WebviewWindow,
    stream_id: &str,
    device_id: &str,
    session: &DeviceSession,
) -> Result<(), String> {
    // Registration and replay share the registry lock so live frames cannot overtake the GOP.
    if let Some(meta) = &session.replay.meta {
        emit_meta(window, stream_id, device_id, meta.clone())?;
    }
    if let Some(config) = &session.replay.config {
        emit_frame(window, stream_id, device_id, config.clone())?;
    }
    for frame in &session.replay.gop {
        emit_frame(window, stream_id, device_id, frame.clone())?;
    }
    Ok(())
}

async fn run_scrcpy_session(
    app: &AppHandle,
    device_id: &str,
    max_size: Option<u32>,
    local_jar: &Path,
    mut canceled: watch::Receiver<bool>,
) -> Result<(), String> {
    let scid = new_scid();
    run_adb_checked(push_argv(device_id, local_jar), "push scrcpy server").await?;
    let forward = run_adb_checked(
        forward_argv(device_id, &scid),
        "create scrcpy port forwarding",
    )
    .await?;
    let port = parse_forward_port(&forward)?;
    let mut server = match spawn_server(device_id, &scid, max_size) {
        Ok(server) => server,
        Err(message) => {
            let _ = run_adb(remove_forward_argv(device_id, port)).await;
            return Err(message);
        }
    };
    let result = stream_video(app, device_id, port, &mut canceled).await;
    stop_server(&mut server).await;
    let _ = run_adb(remove_forward_argv(device_id, port)).await;
    result
}

async fn stream_video(
    app: &AppHandle,
    device_id: &str,
    port: u16,
    canceled: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let mut video = connect_video_socket(port, canceled).await?;
    let _control = connect_control_socket(port, canceled).await?;
    let mut codec_bytes = [0_u8; CODEC_META_BYTES];
    read_exact_or_cancel(&mut video, &mut codec_bytes, canceled).await?;
    let meta = parse_codec_meta(&codec_bytes)?;
    publish_meta(
        app,
        device_id,
        VideoMeta {
            codec_id: meta.codec_id,
            width: meta.width,
            height: meta.height,
        },
    )?;

    let mut parser = ScrcpyFrameParser::default();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut gop_index = 0_u64;
    loop {
        let read = tokio::select! {
            changed = canceled.changed() => {
                if changed.is_err() || *canceled.borrow() {
                    return Ok(());
                }
                continue;
            }
            read = video.read(&mut buffer) => read
        }
        .map_err(|error| format!("scrcpy video socket failed: {error}"))?;
        if read == 0 {
            return Err("scrcpy video socket closed unexpectedly".to_string());
        }
        for frame in parser.push(&buffer[..read])? {
            if frame.key_frame {
                gop_index = gop_index.saturating_add(1);
            }
            publish_frame(
                app,
                device_id,
                CachedVideoFrame {
                    config: frame.config,
                    key_frame: frame.key_frame,
                    pts: frame.pts.to_string(),
                    gop_index,
                    content_base64: BASE64_STANDARD.encode(frame.bytes),
                },
            )?;
        }
    }
}

fn publish_meta(app: &AppHandle, device_id: &str, meta: VideoMeta) -> Result<(), String> {
    let state = app.state::<EmulatorScrcpyVideoState>();
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "emulator video stream registry is unavailable".to_string())?;
    let Some(session) = registry.devices.get_mut(device_id) else {
        return Err("scrcpy video stream was cancelled".to_string());
    };
    session.replay.meta = Some(meta.clone());
    let _ = session.startup.send(SessionStartup::Ready);
    for (stream_id, window) in &session.subscribers {
        emit_meta(window, stream_id, device_id, meta.clone())?;
    }
    Ok(())
}

fn publish_frame(app: &AppHandle, device_id: &str, frame: CachedVideoFrame) -> Result<(), String> {
    let state = app.state::<EmulatorScrcpyVideoState>();
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "emulator video stream registry is unavailable".to_string())?;
    let Some(session) = registry.devices.get_mut(device_id) else {
        return Err("scrcpy video stream was cancelled".to_string());
    };
    cache_frame(&mut session.replay, frame.clone());
    for (stream_id, window) in &session.subscribers {
        emit_frame(window, stream_id, device_id, frame.clone())?;
    }
    Ok(())
}

fn cache_frame(cache: &mut VideoReplayCache, frame: CachedVideoFrame) {
    cache_frame_with_limits(cache, frame, MAX_GOP_FRAMES, MAX_GOP_BYTES);
}

fn cache_frame_with_limits(
    cache: &mut VideoReplayCache,
    frame: CachedVideoFrame,
    max_frames: usize,
    max_bytes: usize,
) {
    if frame.config {
        cache.config = Some(frame);
        return;
    }
    if frame.key_frame {
        cache.gop_bytes = frame.content_base64.len();
        cache.gop = vec![frame];
        return;
    }
    if cache.gop.is_empty() {
        return;
    }
    cache.gop_bytes = cache.gop_bytes.saturating_add(frame.content_base64.len());
    cache.gop.push(frame);
    // Keep the keyframe at index zero; only deltas may be discarded from replay.
    while cache.gop.len() > max_frames || cache.gop_bytes > max_bytes {
        if cache.gop.len() <= 1 {
            break;
        }
        let removed = cache.gop.remove(1);
        cache.gop_bytes = cache.gop_bytes.saturating_sub(removed.content_base64.len());
    }
}

fn emit_meta(
    window: &WebviewWindow,
    stream_id: &str,
    device_id: &str,
    meta: VideoMeta,
) -> Result<(), String> {
    window
        .emit(
            "pebble:emulator-video-meta",
            VideoMetaPayload {
                stream_id: stream_id.to_string(),
                device_id: device_id.to_string(),
                meta,
            },
        )
        .map_err(|error| format!("could not deliver scrcpy video metadata: {error}"))
}

fn emit_frame(
    window: &WebviewWindow,
    stream_id: &str,
    device_id: &str,
    frame: CachedVideoFrame,
) -> Result<(), String> {
    window
        .emit(
            "pebble:emulator-video-frame",
            VideoFramePayload {
                stream_id: stream_id.to_string(),
                device_id: device_id.to_string(),
                config: frame.config,
                key_frame: frame.key_frame,
                pts: frame.pts,
                gop_index: frame.gop_index,
                content_base64: frame.content_base64,
            },
        )
        .map_err(|error| format!("could not deliver scrcpy video frame: {error}"))
}

fn emit_session_error(app: &AppHandle, device_id: &str, session_id: Uuid, message: String) {
    let state = app.state::<EmulatorScrcpyVideoState>();
    let Ok(registry) = state.registry.lock() else {
        return;
    };
    let Some(session) = registry
        .devices
        .get(device_id)
        .filter(|session| session.session_id == session_id)
    else {
        return;
    };
    for (stream_id, window) in &session.subscribers {
        let _ = window.emit(
            "pebble:emulator-video-error",
            VideoErrorPayload {
                stream_id: stream_id.clone(),
                device_id: device_id.to_string(),
                message: message.clone(),
            },
        );
    }
}

fn finish_session(app: &AppHandle, device_id: &str, session_id: Uuid) {
    let state = app.state::<EmulatorScrcpyVideoState>();
    let Ok(mut registry) = state.registry.lock() else {
        return;
    };
    let stream_ids = registry
        .devices
        .get(device_id)
        .filter(|session| session.session_id == session_id)
        .map(|session| session.subscribers.keys().cloned().collect::<Vec<_>>());
    let Some(stream_ids) = stream_ids else {
        return;
    };
    registry.devices.remove(device_id);
    for stream_id in stream_ids {
        registry.stream_devices.remove(&stream_id);
    }
}

async fn connect_video_socket(
    port: u16,
    canceled: &mut watch::Receiver<bool>,
) -> Result<TcpStream, String> {
    for _ in 0..CONNECT_ATTEMPTS {
        let mut socket = match connect_socket(port, canceled).await {
            Ok(socket) => socket,
            Err(message) if message.contains("cancelled") => return Err(message),
            Err(_) => {
                tokio::time::sleep(CONNECT_RETRY_DELAY).await;
                continue;
            }
        };
        // scrcpy's first socket starts with one dummy byte and a 64-byte device
        // name. Receiving the whole header proves adb reached the real server,
        // rather than merely accepting a forward before the abstract socket exists.
        let mut header = [0_u8; DEVICE_HEADER_BYTES];
        match tokio::time::timeout(SOCKET_READY_TIMEOUT, socket.read_exact(&mut header)).await {
            Ok(Ok(_)) if header[0] == 0 => return Ok(socket),
            _ => tokio::time::sleep(CONNECT_RETRY_DELAY).await,
        }
    }
    Err("scrcpy video socket did not deliver its readiness byte".to_string())
}

async fn connect_control_socket(
    port: u16,
    canceled: &mut watch::Receiver<bool>,
) -> Result<TcpStream, String> {
    for _ in 0..CONNECT_ATTEMPTS {
        match connect_socket(port, canceled).await {
            Ok(socket) => return Ok(socket),
            Err(message) if message.contains("cancelled") => return Err(message),
            Err(_) => tokio::time::sleep(CONNECT_RETRY_DELAY).await,
        }
    }
    Err("scrcpy control socket did not become available".to_string())
}

async fn connect_socket(
    port: u16,
    canceled: &mut watch::Receiver<bool>,
) -> Result<TcpStream, String> {
    tokio::select! {
        changed = canceled.changed() => {
            let _ = changed;
            Err("scrcpy video stream was cancelled".to_string())
        }
        result = TcpStream::connect(("127.0.0.1", port)) => {
            result.map_err(|error| format!("could not connect to scrcpy socket: {error}"))
        }
    }
}

async fn read_exact_or_cancel(
    socket: &mut TcpStream,
    bytes: &mut [u8],
    canceled: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    tokio::select! {
        changed = canceled.changed() => {
            let _ = changed;
            Err("scrcpy video stream was cancelled".to_string())
        }
        result = socket.read_exact(bytes) => {
            result.map(|_| ()).map_err(|error| format!("scrcpy socket closed during handshake: {error}"))
        }
    }
}

fn spawn_server(serial: &str, scid: &str, max_size: Option<u32>) -> Result<Child, String> {
    let mut command = Command::new("adb");
    command
        .args(server_argv(serial, scid, max_size))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command
        .spawn()
        .map_err(|error| format!("could not launch scrcpy server: {error}"))
}

async fn stop_server(server: &mut Child) {
    let _ = server.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), server.wait()).await;
}

async fn run_adb_checked(argv: Vec<String>, action: &str) -> Result<String, String> {
    let output = run_adb(argv).await?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("could not {action}: {detail}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn run_adb(argv: Vec<String>) -> Result<std::process::Output, String> {
    Command::new("adb")
        .args(argv)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("could not execute adb: {error}"))
}

fn parse_forward_port(stdout: &str) -> Result<u16, String> {
    stdout
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| "adb did not return a valid dynamic scrcpy port".to_string())
}

fn new_scid() -> String {
    let value = (Uuid::new_v4().as_u128() as u32) & 0x7fff_ffff;
    format!("{value:08x}")
}

fn validate_start_input(input: &StartVideoStreamInput) -> Result<(), String> {
    if input.device_id.trim().is_empty()
        || input.device_id.len() > 255
        || input.device_id.contains(char::is_whitespace)
    {
        return Err("invalid_target: deviceId must be an adb serial".to_string());
    }
    if input.stream_id.trim().is_empty()
        || input.stream_id.len() > 255
        || input.stream_id.contains(char::is_whitespace)
    {
        return Err("invalid_target: streamId is invalid".to_string());
    }
    if input
        .max_size
        .is_some_and(|size| size < 256 || size > 8_192)
    {
        return Err("invalid_target: maxSize must be from 256 to 8192".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(device_id: &str, stream_id: &str) -> StartVideoStreamInput {
        StartVideoStreamInput {
            device_id: device_id.to_string(),
            stream_id: stream_id.to_string(),
            max_size: Some(1920),
        }
    }

    fn frame(config: bool, key_frame: bool, pts: u64, bytes: usize) -> CachedVideoFrame {
        CachedVideoFrame {
            config,
            key_frame,
            pts: pts.to_string(),
            gop_index: 1,
            content_base64: "x".repeat(bytes),
        }
    }

    #[test]
    fn validates_stream_targets_and_limits() {
        assert!(validate_start_input(&input("emulator-5554", "stream-1")).is_ok());
        assert!(validate_start_input(&input("bad serial", "stream-1")).is_err());
        let mut too_small = input("emulator-5554", "stream-1");
        too_small.max_size = Some(128);
        assert!(validate_start_input(&too_small).is_err());
    }

    #[test]
    fn parses_only_nonzero_forward_ports() {
        assert_eq!(parse_forward_port("27183\n").unwrap(), 27183);
        assert!(parse_forward_port("0").is_err());
        assert!(parse_forward_port("not-a-port").is_err());
    }

    #[test]
    fn generates_signed_32_bit_scrcpy_ids() {
        let scid = new_scid();
        assert_eq!(scid.len(), 8);
        assert!(u32::from_str_radix(&scid, 16).unwrap() <= 0x7fff_ffff);
    }

    #[test]
    fn caches_config_and_only_decodeable_current_gop() {
        let mut cache = VideoReplayCache::default();
        cache_frame(&mut cache, frame(true, false, 0, 4));
        cache_frame(&mut cache, frame(false, false, 1, 4));
        assert!(cache.config.is_some());
        assert!(cache.gop.is_empty());

        cache_frame(&mut cache, frame(false, true, 2, 5));
        cache_frame(&mut cache, frame(false, false, 3, 6));
        assert_eq!(
            cache
                .gop
                .iter()
                .map(|item| item.pts.as_str())
                .collect::<Vec<_>>(),
            ["2", "3"]
        );

        cache_frame(&mut cache, frame(false, true, 4, 7));
        assert_eq!(cache.gop.len(), 1);
        assert_eq!(cache.gop[0].pts, "4");
        assert_eq!(cache.gop_bytes, 7);
    }

    #[test]
    fn bounds_gop_without_discarding_its_keyframe() {
        let mut cache = VideoReplayCache::default();
        cache_frame_with_limits(&mut cache, frame(false, true, 1, 4), 3, 10);
        cache_frame_with_limits(&mut cache, frame(false, false, 2, 4), 3, 10);
        cache_frame_with_limits(&mut cache, frame(false, false, 3, 4), 3, 10);
        cache_frame_with_limits(&mut cache, frame(false, false, 4, 4), 3, 10);

        assert_eq!(
            cache
                .gop
                .iter()
                .map(|item| item.pts.as_str())
                .collect::<Vec<_>>(),
            ["1", "4"]
        );
        assert_eq!(cache.gop_bytes, 8);
        assert!(cache.gop[0].key_frame);
    }
}
