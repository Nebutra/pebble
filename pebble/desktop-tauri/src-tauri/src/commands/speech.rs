//! Tauri speech commands: OpenAI key storage, model archive downloads, and
//! cloud (OpenAI) dictation sessions. The renderer-facing contract mirrors
//! Electron's `speech:*` IPC surface; the model catalog stays TS-owned and
//! manifests are passed in, so there is a single source of truth.
//!
//! Local sherpa-onnx/whisper inference is not ported yet — `start_dictation`
//! returns an explicit typed error for local models.

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

use super::speech_model_download::{
    cleanup_partial_model, download_archive, extract_archive_blocking, flatten_nested_model_dir,
    model_files_present, safe_model_dir, verify_archive_sha256,
};
use super::speech_openai_key_store;
use super::speech_openai_transcription::{
    encode_pcm16_wav, openai_transcription_model_for_id, resample_to_rate, transcribe_wav,
    CLOUD_TRANSCRIPTION_SAMPLE_RATE, MAX_CLOUD_AUDIO_SECONDS,
};

const DOWNLOAD_PROGRESS_EVENT: &str = "pebble:speech-download-progress";
const READY_EVENT: &str = "pebble:speech-ready";
const FINAL_TRANSCRIPT_EVENT: &str = "pebble:speech-final-transcript";
const STOPPED_EVENT: &str = "pebble:speech-stopped";
const ERROR_EVENT: &str = "pebble:speech-error";

pub const LOCAL_INFERENCE_UNAVAILABLE: &str =
    "Local speech models are not available in the Tauri shell yet. Choose an OpenAI model.";

// Why: mirrors the mobile RPC audio-chunk budget — reject oversized chunks
// before base64 decoding allocates.
const MAX_AUDIO_CHUNK_BASE64_LENGTH: usize = 16_000 * 4 * 5 * 4 / 3 + 4;

#[derive(Clone)]
enum DownloadPhase {
    Downloading(f64),
    Extracting,
}

struct ActiveDownload {
    aborted: Arc<AtomicBool>,
    phase: DownloadPhase,
}

struct DictationSession {
    model_id: String,
    samples: Vec<f32>,
}

#[derive(Default)]
pub struct SpeechState {
    downloads: Mutex<HashMap<String, ActiveDownload>>,
    sessions: Mutex<HashMap<String, DictationSession>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelProbe {
    id: String,
    provider: String,
    #[serde(default)]
    files: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelDownloadInput {
    id: String,
    download_url: String,
    archive_sha256: String,
    #[serde(default)]
    size_bytes: u64,
    files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelState {
    id: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpeechKeyStatus {
    configured: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressPayload {
    model_id: String,
    progress: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionPayload {
    session_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TranscriptPayload {
    text: String,
    session_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionErrorPayload {
    error: String,
    session_id: String,
}

fn speech_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // Why: matches Electron's `<userData>/speech-models` layout so future
    // profile migration only has to move one directory.
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("speech-models"))
}

fn emit_download_progress(app: &AppHandle, model_id: &str, progress: f64) {
    let _ = app.emit(
        DOWNLOAD_PROGRESS_EVENT,
        DownloadProgressPayload {
            model_id: model_id.to_string(),
            progress,
        },
    );
}

#[tauri::command]
pub async fn speech_get_openai_key_status() -> Result<SpeechKeyStatus, String> {
    // Why: keychain access can block on the OS credential daemon; keep it off
    // the main thread (sync Tauri commands run on the main thread).
    tauri::async_runtime::spawn_blocking(|| SpeechKeyStatus {
        configured: speech_openai_key_store::has_key(),
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn speech_save_openai_key(api_key: String) -> Result<SpeechKeyStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        speech_openai_key_store::save_key(&api_key)?;
        Ok(SpeechKeyStatus { configured: true })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn speech_clear_openai_key() -> Result<SpeechKeyStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        speech_openai_key_store::clear_key()?;
        Ok(SpeechKeyStatus { configured: false })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn speech_get_model_states(
    app: AppHandle,
    state: State<'_, SpeechState>,
    models: Vec<SpeechModelProbe>,
) -> Result<Vec<SpeechModelState>, String> {
    let models_dir = speech_models_dir(&app)?;
    let live_phases: HashMap<String, DownloadPhase> = {
        let downloads = state.downloads.lock().expect("speech downloads poisoned");
        downloads
            .iter()
            .map(|(id, d)| (id.clone(), d.phase.clone()))
            .collect()
    };

    tauri::async_runtime::spawn_blocking(move || {
        let key_configured = models
            .iter()
            .any(|m| m.provider == "openai")
            .then(speech_openai_key_store::has_key)
            .unwrap_or(false);

        Ok(models
            .into_iter()
            .map(|model| {
                if model.provider == "openai" {
                    return SpeechModelState {
                        id: model.id,
                        status: if key_configured {
                            "ready"
                        } else {
                            "not-downloaded"
                        }
                        .to_string(),
                        progress: None,
                        error: None,
                    };
                }
                if let Some(phase) = live_phases.get(&model.id) {
                    let (status, progress) = match phase {
                        DownloadPhase::Downloading(p) => ("downloading", Some(*p)),
                        DownloadPhase::Extracting => ("extracting", None),
                    };
                    return SpeechModelState {
                        id: model.id,
                        status: status.to_string(),
                        progress,
                        error: None,
                    };
                }
                let status = match safe_model_dir(&models_dir, &model.id) {
                    Ok(dir) if model_files_present(&dir, &model.files) => "ready",
                    Ok(_) => "not-downloaded",
                    Err(_) => "error",
                };
                SpeechModelState {
                    id: model.id,
                    status: status.to_string(),
                    progress: None,
                    error: None,
                }
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn set_download_phase(state: &State<'_, SpeechState>, model_id: &str, phase: DownloadPhase) {
    let mut downloads = state.downloads.lock().expect("speech downloads poisoned");
    if let Some(download) = downloads.get_mut(model_id) {
        download.phase = phase;
    }
}

#[tauri::command]
pub async fn speech_download_model(
    app: AppHandle,
    state: State<'_, SpeechState>,
    input: SpeechModelDownloadInput,
) -> Result<(), String> {
    if input.archive_sha256.len() != 64 {
        return Err(format!("Model download metadata missing: {}", input.id));
    }
    let models_dir = speech_models_dir(&app)?;
    let model_dir = safe_model_dir(&models_dir, &input.id)?;
    std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;

    if model_files_present(&model_dir, &input.files) {
        emit_download_progress(&app, &input.id, -1.0);
        return Ok(());
    }

    let aborted = Arc::new(AtomicBool::new(false));
    {
        let mut downloads = state.downloads.lock().expect("speech downloads poisoned");
        if downloads.contains_key(&input.id) {
            return Ok(());
        }
        downloads.insert(
            input.id.clone(),
            ActiveDownload {
                aborted: aborted.clone(),
                phase: DownloadPhase::Downloading(0.0),
            },
        );
    }
    emit_download_progress(&app, &input.id, 0.0);

    let archive_path = models_dir.join(format!("{}.tar.bz2", input.id));
    let result =
        run_model_download(&app, &state, &input, &archive_path, &model_dir, &aborted).await;

    state
        .downloads
        .lock()
        .expect("speech downloads poisoned")
        .remove(&input.id);
    let _ = std::fs::remove_file(&archive_path);

    match result {
        Ok(()) => {
            emit_download_progress(&app, &input.id, -1.0);
            Ok(())
        }
        Err(error) => {
            cleanup_partial_model(&archive_path, &model_dir);
            emit_download_progress(&app, &input.id, -1.0);
            if aborted.load(Ordering::SeqCst) {
                // Why: cancellation stays quiet like Electron — the settings UI
                // only surfaces real failures from the awaited promise.
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

async fn run_model_download(
    app: &AppHandle,
    state: &State<'_, SpeechState>,
    input: &SpeechModelDownloadInput,
    archive_path: &std::path::Path,
    model_dir: &std::path::Path,
    aborted: &Arc<AtomicBool>,
) -> Result<(), String> {
    let progress_app = app.clone();
    let progress_model_id = input.id.clone();
    let progress_state_downloads = {
        let mut last_emitted = -1.0f64;
        let state_handle = app.state::<SpeechState>();
        move |progress: f64| {
            // Why: large archives stream thousands of chunks; only emit when
            // progress moves a full percent to keep the event channel quiet.
            if progress - last_emitted >= 0.01 {
                last_emitted = progress;
                if let Some(download) = state_handle
                    .downloads
                    .lock()
                    .expect("speech downloads poisoned")
                    .get_mut(&progress_model_id)
                {
                    download.phase = DownloadPhase::Downloading(progress);
                }
                emit_download_progress(&progress_app, &progress_model_id, progress);
            }
        }
    };

    download_archive(
        &input.download_url,
        archive_path,
        input.size_bytes,
        aborted,
        progress_state_downloads,
    )
    .await?;
    if aborted.load(Ordering::SeqCst) {
        return Err("Aborted".to_string());
    }

    let verify_path = archive_path.to_path_buf();
    let expected_sha = input.archive_sha256.clone();
    tauri::async_runtime::spawn_blocking(move || {
        verify_archive_sha256(&verify_path, &expected_sha)
    })
    .await
    .map_err(|e| e.to_string())??;
    if aborted.load(Ordering::SeqCst) {
        return Err("Aborted".to_string());
    }

    set_download_phase(state, &input.id, DownloadPhase::Extracting);
    emit_download_progress(app, &input.id, 0.95);

    let extract_archive_path = archive_path.to_path_buf();
    let extract_model_dir = model_dir.to_path_buf();
    let extract_aborted = aborted.clone();
    tauri::async_runtime::spawn_blocking(move || {
        extract_archive_blocking(&extract_archive_path, &extract_model_dir, &extract_aborted)
    })
    .await
    .map_err(|e| e.to_string())??;
    if aborted.load(Ordering::SeqCst) {
        return Err("Aborted".to_string());
    }

    let validate_model_dir = model_dir.to_path_buf();
    let files = input.files.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !model_files_present(&validate_model_dir, &files) {
            flatten_nested_model_dir(&validate_model_dir, &files)?;
        }
        if !model_files_present(&validate_model_dir, &files) {
            return Err("Model files missing after extraction".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn speech_cancel_download(
    app: AppHandle,
    state: State<'_, SpeechState>,
    model_id: String,
) -> Result<(), String> {
    let downloads = state.downloads.lock().expect("speech downloads poisoned");
    if let Some(download) = downloads.get(&model_id) {
        download.aborted.store(true, Ordering::SeqCst);
        emit_download_progress(&app, &model_id, -1.0);
    }
    Ok(())
}

#[tauri::command]
pub async fn speech_delete_model(
    app: AppHandle,
    state: State<'_, SpeechState>,
    model_id: String,
) -> Result<(), String> {
    {
        let downloads = state.downloads.lock().expect("speech downloads poisoned");
        if let Some(download) = downloads.get(&model_id) {
            download.aborted.store(true, Ordering::SeqCst);
        }
    }
    let model_dir = safe_model_dir(&speech_models_dir(&app)?, &model_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        if model_dir.exists() {
            std::fs::remove_dir_all(&model_dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn speech_start_dictation(
    app: AppHandle,
    state: State<'_, SpeechState>,
    model_id: String,
    session_id: String,
) -> Result<(), String> {
    if openai_transcription_model_for_id(&model_id).is_none() {
        // Honest gap: sherpa-onnx/whisper local inference is not ported.
        return Err(LOCAL_INFERENCE_UNAVAILABLE.to_string());
    }

    let key_configured = tauri::async_runtime::spawn_blocking(speech_openai_key_store::has_key)
        .await
        .map_err(|e| e.to_string())?;
    if !key_configured {
        return Err("OpenAI API key is not configured".to_string());
    }

    {
        let mut sessions = state.sessions.lock().expect("speech sessions poisoned");
        if !sessions.is_empty() {
            return Err("dictation_already_active".to_string());
        }
        sessions.insert(
            session_id.clone(),
            DictationSession {
                model_id,
                samples: Vec::new(),
            },
        );
    }

    let _ = app.emit(READY_EVENT, SessionPayload { session_id });
    Ok(())
}

#[tauri::command]
pub fn speech_feed_audio(
    state: State<'_, SpeechState>,
    session_id: String,
    samples_base64: String,
    sample_rate: u32,
) -> Result<(), String> {
    if samples_base64.len() > MAX_AUDIO_CHUNK_BASE64_LENGTH {
        return Err("Audio chunk is too large".to_string());
    }
    let bytes = BASE64_STANDARD
        .decode(samples_base64)
        .map_err(|_| "Audio chunk must be base64".to_string())?;
    if bytes.len() % 4 != 0 {
        return Err("Audio chunk must be little-endian float32 PCM".to_string());
    }
    let samples: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let normalized = resample_to_rate(&samples, sample_rate, CLOUD_TRANSCRIPTION_SAMPLE_RATE);

    let mut sessions = state.sessions.lock().expect("speech sessions poisoned");
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "No active dictation session".to_string())?;
    let total_seconds =
        (session.samples.len() + normalized.len()) as f64 / CLOUD_TRANSCRIPTION_SAMPLE_RATE as f64;
    if total_seconds > MAX_CLOUD_AUDIO_SECONDS {
        return Err("Cloud transcription is limited to 10 minutes per dictation".to_string());
    }
    session.samples.extend_from_slice(&normalized);
    Ok(())
}

#[tauri::command]
pub async fn speech_stop_dictation(
    app: AppHandle,
    state: State<'_, SpeechState>,
    session_id: String,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .expect("speech sessions poisoned")
        .remove(&session_id);

    let Some(session) = session else {
        // Why: parity with Electron — stopping an idle recorder still resolves
        // and emits `stopped` so the renderer state machine settles.
        let _ = app.emit(STOPPED_EVENT, SessionPayload { session_id });
        return Ok(());
    };

    if !session.samples.is_empty() {
        match finish_cloud_transcription(&session).await {
            Ok(text) => {
                if !text.is_empty() {
                    let _ = app.emit(
                        FINAL_TRANSCRIPT_EVENT,
                        TranscriptPayload {
                            text,
                            session_id: session_id.clone(),
                        },
                    );
                }
            }
            Err(error) => {
                let _ = app.emit(
                    ERROR_EVENT,
                    SessionErrorPayload {
                        error,
                        session_id: session_id.clone(),
                    },
                );
            }
        }
    }

    let _ = app.emit(STOPPED_EVENT, SessionPayload { session_id });
    Ok(())
}

async fn finish_cloud_transcription(session: &DictationSession) -> Result<String, String> {
    let api_key = tauri::async_runtime::spawn_blocking(speech_openai_key_store::read_key)
        .await
        .map_err(|e| e.to_string())??;
    let wav = encode_pcm16_wav(&session.samples, CLOUD_TRANSCRIPTION_SAMPLE_RATE);
    transcribe_wav(&session.model_id, &api_key, wav).await
}
