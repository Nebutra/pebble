//! Local speech model spec parsing and on-disk layout resolution. Mirrors
//! Electron's stt-worker file-role lookup so the TS-owned catalog stays the
//! single source of truth for model metadata.

use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Manifest fields the renderer passes for local dictation. The catalog is
/// TS-owned; Rust only validates and resolves what it is handed.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
// Why: `streaming` is only read by the feature-gated sherpa engine; without
// the feature the field still must deserialize for the typed gap path.
#[cfg_attr(not(feature = "local-speech"), allow(dead_code))]
pub struct LocalSpeechModelSpec {
    pub model_type: String,
    pub streaming: bool,
    pub sample_rate: u32,
    pub files: Vec<String>,
}

/// Absolute paths to the model files a recognizer needs, resolved from the
/// manifest's file list against the downloaded model directory.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedModelPaths {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    /// Present only for transducer models.
    pub joiner: Option<PathBuf>,
    pub tokens: PathBuf,
}

// Why: different models name their ONNX files differently (encoder.int8.onnx,
// tiny-encoder.onnx, encoder-epoch-99-avg-1.onnx) — match the role substring
// exactly like Electron's stt-worker resolveFile.
fn resolve_role_file(files: &[String], role: &str, model_dir: &Path) -> Result<PathBuf, String> {
    files
        .iter()
        .find(|f| f.contains(role) && f.ends_with(".onnx"))
        .map(|f| model_dir.join(f))
        .ok_or_else(|| {
            format!(
                "No *{role}*.onnx found in model files: {}",
                files.join(", ")
            )
        })
}

fn resolve_tokens_file(files: &[String], model_dir: &Path) -> Result<PathBuf, String> {
    files
        .iter()
        .find(|f| f.ends_with("tokens.txt"))
        .map(|f| model_dir.join(f))
        .ok_or_else(|| format!("No *tokens.txt found in model files: {}", files.join(", ")))
}

pub fn resolve_model_paths(
    spec: &LocalSpeechModelSpec,
    model_dir: &Path,
) -> Result<ResolvedModelPaths, String> {
    if spec.sample_rate == 0 {
        return Err("Model sample rate must be non-zero".to_string());
    }
    let needs_joiner = spec.model_type == "transducer";
    Ok(ResolvedModelPaths {
        encoder: resolve_role_file(&spec.files, "encoder", model_dir)?,
        decoder: resolve_role_file(&spec.files, "decoder", model_dir)?,
        joiner: if needs_joiner {
            Some(resolve_role_file(&spec.files, "joiner", model_dir)?)
        } else {
            None
        },
        tokens: resolve_tokens_file(&spec.files, model_dir)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(model_type: &str, files: &[&str]) -> LocalSpeechModelSpec {
        LocalSpeechModelSpec {
            model_type: model_type.to_string(),
            streaming: false,
            sample_rate: 16_000,
            files: files.iter().map(|f| f.to_string()).collect(),
        }
    }

    #[test]
    fn resolves_transducer_roles_across_naming_schemes() {
        let dir = Path::new("/models/parakeet");
        let paths = resolve_model_paths(
            &spec(
                "transducer",
                &[
                    "encoder.int8.onnx",
                    "decoder.int8.onnx",
                    "joiner.int8.onnx",
                    "tokens.txt",
                ],
            ),
            dir,
        )
        .expect("resolve");
        assert_eq!(paths.encoder, dir.join("encoder.int8.onnx"));
        assert_eq!(paths.joiner, Some(dir.join("joiner.int8.onnx")));
        assert_eq!(paths.tokens, dir.join("tokens.txt"));

        let epoch = resolve_model_paths(
            &spec(
                "transducer",
                &[
                    "encoder-epoch-99-avg-1.onnx",
                    "decoder-epoch-99-avg-1.onnx",
                    "joiner-epoch-99-avg-1.onnx",
                    "tokens.txt",
                ],
            ),
            dir,
        )
        .expect("resolve");
        assert_eq!(epoch.decoder, dir.join("decoder-epoch-99-avg-1.onnx"));
    }

    #[test]
    fn resolves_whisper_prefixed_files_without_joiner() {
        let dir = Path::new("/models/whisper-tiny");
        let paths = resolve_model_paths(
            &spec(
                "whisper",
                &["tiny-encoder.onnx", "tiny-decoder.onnx", "tiny-tokens.txt"],
            ),
            dir,
        )
        .expect("resolve");
        assert_eq!(paths.encoder, dir.join("tiny-encoder.onnx"));
        assert_eq!(paths.tokens, dir.join("tiny-tokens.txt"));
        assert_eq!(paths.joiner, None);
    }

    #[test]
    fn rejects_missing_roles_and_zero_sample_rate() {
        let dir = Path::new("/models/broken");
        let missing_joiner = resolve_model_paths(
            &spec(
                "transducer",
                &["encoder.onnx", "decoder.onnx", "tokens.txt"],
            ),
            dir,
        );
        assert!(missing_joiner.is_err());

        let mut zero_rate = spec("whisper", &["encoder.onnx", "decoder.onnx", "tokens.txt"]);
        zero_rate.sample_rate = 0;
        assert!(resolve_model_paths(&zero_rate, dir).is_err());
    }
}
