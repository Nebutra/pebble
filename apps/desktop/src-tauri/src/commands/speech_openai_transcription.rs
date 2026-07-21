//! OpenAI-compatible cloud transcription: PCM accumulation, WAV encoding, and
//! the multipart upload. Mirrors Electron's `openai-transcription-client.ts`.

use regex::Regex;
use std::sync::OnceLock;

pub const OPENAI_TRANSCRIPTION_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
pub const CLOUD_TRANSCRIPTION_SAMPLE_RATE: u32 = 16_000;
pub const MAX_CLOUD_AUDIO_SECONDS: f64 = 10.0 * 60.0;

pub fn openai_transcription_model_for_id(model_id: &str) -> Option<&'static str> {
    match model_id {
        "openai-gpt-4o-mini-transcribe" => Some("gpt-4o-mini-transcribe"),
        "openai-gpt-4o-transcribe" => Some("gpt-4o-transcribe"),
        _ => None,
    }
}

pub fn sanitize_openai_error_message(message: &str) -> String {
    static INCORRECT_KEY: OnceLock<Regex> = OnceLock::new();
    static SK_TOKEN: OnceLock<Regex> = OnceLock::new();
    static BEARER: OnceLock<Regex> = OnceLock::new();

    let incorrect_key = INCORRECT_KEY
        .get_or_init(|| Regex::new(r"(?i)incorrect api key provided:").expect("static regex"));
    if incorrect_key.is_match(message) {
        return "Incorrect OpenAI API key provided.".to_string();
    }

    // Why: API error bodies can echo the submitted key; redact before the
    // message reaches renderer logs or toasts.
    let sk = SK_TOKEN.get_or_init(|| Regex::new(r"\bsk-[A-Za-z0-9_-]+").expect("static regex"));
    let bearer = BEARER
        .get_or_init(|| Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+").expect("static regex"));
    let sanitized = bearer
        .replace_all(&sk.replace_all(message, "[redacted]"), "Bearer [redacted]")
        .trim()
        .to_string();

    if sanitized.is_empty() {
        "OpenAI transcription request failed".to_string()
    } else {
        sanitized
    }
}

/// Linear-interpolation resample, matching Electron's `stt-audio-resample.ts`.
pub fn resample_to_rate(samples: &[f32], input_rate: u32, output_rate: u32) -> Vec<f32> {
    if samples.is_empty() || input_rate == 0 || output_rate == 0 || input_rate == output_rate {
        return samples.to_vec();
    }
    let output_len =
        ((samples.len() as f64 * output_rate as f64 / input_rate as f64).round() as usize).max(1);
    let ratio = input_rate as f64 / output_rate as f64;
    let mut output = Vec::with_capacity(output_len);
    for i in 0..output_len {
        let source_index = i as f64 * ratio;
        let left = source_index.floor() as usize;
        let right = (left + 1).min(samples.len() - 1);
        let weight = (source_index - left as f64) as f32;
        let left_sample = samples.get(left).copied().unwrap_or(0.0);
        output.push(left_sample * (1.0 - weight) + samples[right] * weight);
    }
    output
}

pub fn encode_pcm16_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_bytes = samples.len() * 2;
    let mut buffer = Vec::with_capacity(44 + data_bytes);

    buffer.extend_from_slice(b"RIFF");
    buffer.extend_from_slice(&((36 + data_bytes) as u32).to_le_bytes());
    buffer.extend_from_slice(b"WAVE");
    buffer.extend_from_slice(b"fmt ");
    buffer.extend_from_slice(&16u32.to_le_bytes());
    buffer.extend_from_slice(&1u16.to_le_bytes()); // PCM
    buffer.extend_from_slice(&1u16.to_le_bytes()); // mono
    buffer.extend_from_slice(&sample_rate.to_le_bytes());
    buffer.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    buffer.extend_from_slice(&2u16.to_le_bytes());
    buffer.extend_from_slice(&16u16.to_le_bytes());
    buffer.extend_from_slice(b"data");
    buffer.extend_from_slice(&(data_bytes as u32).to_le_bytes());

    for sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let value = if clamped < 0.0 {
            clamped * 0x8000 as f32
        } else {
            clamped * 0x7fff as f32
        };
        buffer.extend_from_slice(&(value.round() as i16).to_le_bytes());
    }

    buffer
}

#[derive(serde::Deserialize, Default)]
struct OpenAiErrorBody {
    message: Option<String>,
}

#[derive(serde::Deserialize, Default)]
struct OpenAiTranscriptionResponse {
    text: Option<String>,
    error: Option<OpenAiErrorBody>,
}

pub async fn transcribe_wav(model_id: &str, api_key: &str, wav: Vec<u8>) -> Result<String, String> {
    let api_model = openai_transcription_model_for_id(model_id)
        .ok_or_else(|| format!("Unknown OpenAI transcription model: {model_id}"))?;

    let part = reqwest::multipart::Part::bytes(wav)
        .file_name("dictation.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("model", api_model)
        .text("response_format", "json")
        .part("file", part);

    let response = reqwest::Client::new()
        .post(OPENAI_TRANSCRIPTION_URL)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            format!(
                "OpenAI transcription failed: {}",
                sanitize_openai_error_message(&e.to_string())
            )
        })?;

    let status = response.status();
    let body: OpenAiTranscriptionResponse = response.json().await.unwrap_or_default();
    let error_message = body.error.and_then(|e| e.message);

    if !status.is_success() {
        let message = error_message
            .map(|m| sanitize_openai_error_message(&m))
            .unwrap_or_else(|| status.to_string());
        return Err(format!("OpenAI transcription failed: {message}"));
    }

    match body.text {
        Some(text) => Ok(text.trim().to_string()),
        None => match error_message {
            Some(message) => Err(sanitize_openai_error_message(&message)),
            None => Err("OpenAI transcription response did not include text".to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_catalog_ids_to_api_models() {
        assert_eq!(
            openai_transcription_model_for_id("openai-gpt-4o-mini-transcribe"),
            Some("gpt-4o-mini-transcribe")
        );
        assert_eq!(
            openai_transcription_model_for_id("openai-gpt-4o-transcribe"),
            Some("gpt-4o-transcribe")
        );
        assert_eq!(openai_transcription_model_for_id("whisper-tiny"), None);
    }

    #[test]
    fn sanitizes_api_key_material_from_errors() {
        assert_eq!(
            sanitize_openai_error_message("Incorrect API key provided: sk-abc123"),
            "Incorrect OpenAI API key provided."
        );
        assert_eq!(
            sanitize_openai_error_message("request with sk-secret_TOKEN failed"),
            "request with [redacted] failed"
        );
        assert_eq!(
            sanitize_openai_error_message("header Bearer abc.def-123 rejected"),
            "header Bearer [redacted] rejected"
        );
        assert_eq!(
            sanitize_openai_error_message("   "),
            "OpenAI transcription request failed"
        );
    }

    #[test]
    fn resample_halves_length_when_downsampling_2x() {
        let samples: Vec<f32> = (0..32000).map(|i| (i % 100) as f32 / 100.0).collect();
        let out = resample_to_rate(&samples, 32_000, 16_000);
        assert_eq!(out.len(), 16_000);
    }

    #[test]
    fn resample_is_identity_at_same_rate() {
        let samples = vec![0.1f32, 0.2, 0.3];
        assert_eq!(resample_to_rate(&samples, 16_000, 16_000), samples);
    }

    #[test]
    fn wav_header_matches_pcm16_mono_layout() {
        let wav = encode_pcm16_wav(&[0.0, 1.0, -1.0], 16_000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(wav.len(), 44 + 6);
        // Sample values: 0, 0x7fff (max), -0x8000 (min).
        assert_eq!(i16::from_le_bytes(wav[44..46].try_into().unwrap()), 0);
        assert_eq!(i16::from_le_bytes(wav[46..48].try_into().unwrap()), 0x7fff);
        assert_eq!(i16::from_le_bytes(wav[48..50].try_into().unwrap()), -0x8000);
    }
}
