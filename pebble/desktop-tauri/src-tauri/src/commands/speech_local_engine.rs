//! sherpa-onnx engine construction for local dictation. Everything native
//! lives behind the `local-speech` cargo feature so the shell still builds
//! (with a typed runtime gap) when the prebuilt sherpa-onnx binary cannot be
//! fetched at build time.

use super::speech_local_dictation::LocalEngineFactory;
use super::speech_local_model::{LocalSpeechModelSpec, ResolvedModelPaths};

pub fn local_inference_supported() -> bool {
    cfg!(feature = "local-speech")
}

#[cfg(feature = "local-speech")]
pub fn local_engine_factory(
    spec: &LocalSpeechModelSpec,
    paths: &ResolvedModelPaths,
) -> Result<LocalEngineFactory, String> {
    sherpa_engine::factory(spec.clone(), paths.clone())
}

#[cfg(not(feature = "local-speech"))]
pub fn local_engine_factory(
    _spec: &LocalSpeechModelSpec,
    _paths: &ResolvedModelPaths,
) -> Result<LocalEngineFactory, String> {
    Err(super::speech::LOCAL_INFERENCE_UNAVAILABLE.to_string())
}

#[cfg(feature = "local-speech")]
mod sherpa_engine {
    use super::super::speech_local_dictation::{
        EngineFeedOutput, LocalDictationEngine, LocalEngineFactory,
    };
    use super::super::speech_local_model::{LocalSpeechModelSpec, ResolvedModelPaths};
    use sherpa_rs::sherpa_rs_sys as sys;
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;
    use std::path::Path;

    // Why: mirror Electron's stt-worker recognizer settings exactly so local
    // transcripts match the reference shell (thread counts, endpoint rules).
    const FEATURE_DIM: i32 = 80;
    const ONLINE_NUM_THREADS: i32 = 1;
    const OFFLINE_NUM_THREADS: i32 = 2;

    pub fn factory(
        spec: LocalSpeechModelSpec,
        paths: ResolvedModelPaths,
    ) -> Result<LocalEngineFactory, String> {
        // Validate the model-type/streaming combination before spawning the
        // session thread so unsupported manifests fail fast.
        match (spec.streaming, spec.model_type.as_str()) {
            (true, "transducer") | (true, "paraformer") => {}
            (false, "whisper") | (false, "transducer") => {}
            (streaming, other) => {
                return Err(format!(
                    "Unsupported local speech model type: {other} (streaming: {streaming})"
                ))
            }
        }
        Ok(Box::new(move || {
            if spec.streaming {
                OnlineSherpaEngine::create(&spec, &paths)
                    .map(|engine| Box::new(engine) as Box<dyn LocalDictationEngine>)
            } else {
                OfflineSherpaEngine::create(&spec, &paths)
                    .map(|engine| Box::new(engine) as Box<dyn LocalDictationEngine>)
            }
        }))
    }

    fn path_cstring(path: &Path, role: &str) -> Result<CString, String> {
        let text = path
            .to_str()
            .ok_or_else(|| format!("Model {role} path is not valid UTF-8"))?;
        CString::new(text).map_err(|_| format!("Model {role} path contains a NUL byte"))
    }

    // ---- offline (buffer everything, decode once on stop) ----

    enum OfflineRecognizer {
        Whisper(sherpa_rs::whisper::WhisperRecognizer),
        Transducer(sherpa_rs::transducer::TransducerRecognizer),
    }

    /// Offline models cannot decode incrementally — buffer all audio and decode
    /// in one shot on finalize, exactly like Electron's offline branch.
    struct OfflineSherpaEngine {
        recognizer: OfflineRecognizer,
        sample_rate: u32,
        buffered: Vec<f32>,
    }

    impl OfflineSherpaEngine {
        fn create(spec: &LocalSpeechModelSpec, paths: &ResolvedModelPaths) -> Result<Self, String> {
            let to_string = |path: &Path, role: &str| -> Result<String, String> {
                path.to_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("Model {role} path is not valid UTF-8"))
            };
            let recognizer = if spec.model_type == "whisper" {
                let config = sherpa_rs::whisper::WhisperConfig {
                    encoder: to_string(&paths.encoder, "encoder")?,
                    decoder: to_string(&paths.decoder, "decoder")?,
                    tokens: to_string(&paths.tokens, "tokens")?,
                    // Why: empty language lets multilingual Whisper auto-detect,
                    // matching Electron which never pins a language.
                    language: String::new(),
                    num_threads: Some(OFFLINE_NUM_THREADS),
                    provider: Some("cpu".to_string()),
                    ..Default::default()
                };
                OfflineRecognizer::Whisper(
                    sherpa_rs::whisper::WhisperRecognizer::new(config)
                        .map_err(|e| format!("Failed to load whisper model: {e}"))?,
                )
            } else {
                let joiner = paths
                    .joiner
                    .as_ref()
                    .ok_or_else(|| "Transducer model is missing a joiner".to_string())?;
                let config = sherpa_rs::transducer::TransducerConfig {
                    encoder: to_string(&paths.encoder, "encoder")?,
                    decoder: to_string(&paths.decoder, "decoder")?,
                    joiner: to_string(joiner, "joiner")?,
                    tokens: to_string(&paths.tokens, "tokens")?,
                    num_threads: OFFLINE_NUM_THREADS,
                    sample_rate: spec.sample_rate as i32,
                    feature_dim: FEATURE_DIM,
                    decoding_method: "greedy_search".to_string(),
                    model_type: "transducer".to_string(),
                    provider: Some("cpu".to_string()),
                    ..Default::default()
                };
                OfflineRecognizer::Transducer(
                    sherpa_rs::transducer::TransducerRecognizer::new(config)
                        .map_err(|e| format!("Failed to load transducer model: {e}"))?,
                )
            };
            Ok(Self {
                recognizer,
                sample_rate: spec.sample_rate,
                buffered: Vec::new(),
            })
        }
    }

    impl LocalDictationEngine for OfflineSherpaEngine {
        fn feed(&mut self, samples: &[f32]) -> Result<EngineFeedOutput, String> {
            self.buffered.extend_from_slice(samples);
            Ok(EngineFeedOutput::default())
        }

        fn finalize(&mut self) -> Result<Option<String>, String> {
            if self.buffered.is_empty() {
                return Ok(None);
            }
            let samples = std::mem::take(&mut self.buffered);
            let text = match &mut self.recognizer {
                OfflineRecognizer::Whisper(recognizer) => {
                    recognizer.transcribe(self.sample_rate, &samples).text
                }
                OfflineRecognizer::Transducer(recognizer) => {
                    recognizer.transcribe(self.sample_rate, &samples)
                }
            };
            let text = text.trim().to_string();
            Ok((!text.is_empty()).then_some(text))
        }
    }

    // ---- online (streaming decode with endpoint detection) ----

    /// Streaming recognizer over the raw sherpa-onnx C API — the high-level
    /// sherpa-rs crate only wraps offline recognizers.
    struct OnlineSherpaEngine {
        recognizer: *const sys::SherpaOnnxOnlineRecognizer,
        stream: *const sys::SherpaOnnxOnlineStream,
        sample_rate: u32,
    }

    impl OnlineSherpaEngine {
        fn create(spec: &LocalSpeechModelSpec, paths: &ResolvedModelPaths) -> Result<Self, String> {
            let encoder = path_cstring(&paths.encoder, "encoder")?;
            let decoder = path_cstring(&paths.decoder, "decoder")?;
            let joiner = match &paths.joiner {
                Some(path) => Some(path_cstring(path, "joiner")?),
                None => None,
            };
            let tokens = path_cstring(&paths.tokens, "tokens")?;
            let provider = CString::new("cpu").expect("static provider");
            let decoding_method = CString::new("greedy_search").expect("static decoding method");

            // Why: zeroed config mirrors the C API's designated-initializer
            // convention — null pointers mean "model family not used".
            let mut model_config: sys::SherpaOnnxOnlineModelConfig = unsafe { std::mem::zeroed() };
            if spec.model_type == "transducer" {
                let joiner = joiner
                    .as_ref()
                    .ok_or_else(|| "Transducer model is missing a joiner".to_string())?;
                model_config.transducer = sys::SherpaOnnxOnlineTransducerModelConfig {
                    encoder: encoder.as_ptr(),
                    decoder: decoder.as_ptr(),
                    joiner: joiner.as_ptr(),
                };
            } else {
                model_config.paraformer = sys::SherpaOnnxOnlineParaformerModelConfig {
                    encoder: encoder.as_ptr(),
                    decoder: decoder.as_ptr(),
                };
            }
            model_config.tokens = tokens.as_ptr();
            model_config.num_threads = ONLINE_NUM_THREADS;
            model_config.provider = provider.as_ptr();

            let mut config: sys::SherpaOnnxOnlineRecognizerConfig = unsafe { std::mem::zeroed() };
            config.feat_config = sys::SherpaOnnxFeatureConfig {
                sample_rate: spec.sample_rate as i32,
                feature_dim: FEATURE_DIM,
            };
            config.model_config = model_config;
            config.decoding_method = decoding_method.as_ptr();
            // Endpoint rules match Electron's stt-worker streaming config.
            config.enable_endpoint = 1;
            config.rule1_min_trailing_silence = 2.4;
            config.rule2_min_trailing_silence = 1.2;
            config.rule3_min_utterance_length = 20.0;

            let recognizer = unsafe { sys::SherpaOnnxCreateOnlineRecognizer(&config) };
            if recognizer.is_null() {
                return Err("Failed to create streaming recognizer from model files".to_string());
            }
            let stream = unsafe { sys::SherpaOnnxCreateOnlineStream(recognizer) };
            if stream.is_null() {
                unsafe { sys::SherpaOnnxDestroyOnlineRecognizer(recognizer) };
                return Err("Failed to create streaming recognizer stream".to_string());
            }
            Ok(Self {
                recognizer,
                stream,
                sample_rate: spec.sample_rate,
            })
        }

        fn decode_pending(&mut self) {
            unsafe {
                while sys::SherpaOnnxIsOnlineStreamReady(self.recognizer, self.stream) == 1 {
                    sys::SherpaOnnxDecodeOnlineStream(self.recognizer, self.stream);
                }
            }
        }

        fn current_text(&self) -> String {
            unsafe {
                let result = sys::SherpaOnnxGetOnlineStreamResult(self.recognizer, self.stream);
                if result.is_null() {
                    return String::new();
                }
                let text_ptr: *const c_char = (*result).text;
                let text = if text_ptr.is_null() {
                    String::new()
                } else {
                    CStr::from_ptr(text_ptr)
                        .to_string_lossy()
                        .trim()
                        .to_string()
                };
                sys::SherpaOnnxDestroyOnlineRecognizerResult(result);
                text
            }
        }
    }

    impl LocalDictationEngine for OnlineSherpaEngine {
        fn feed(&mut self, samples: &[f32]) -> Result<EngineFeedOutput, String> {
            unsafe {
                sys::SherpaOnnxOnlineStreamAcceptWaveform(
                    self.stream,
                    self.sample_rate as i32,
                    samples.as_ptr(),
                    samples.len() as i32,
                );
            }
            self.decode_pending();
            let text = self.current_text();
            let mut output = EngineFeedOutput {
                partial: (!text.is_empty()).then(|| text.clone()),
                finalized: None,
            };
            if unsafe { sys::SherpaOnnxOnlineStreamIsEndpoint(self.recognizer, self.stream) } == 1 {
                // Why: Electron emits the endpoint text as both partial and
                // final, then resets the stream for the next utterance.
                output.finalized = (!text.is_empty()).then_some(text);
                unsafe { sys::SherpaOnnxOnlineStreamReset(self.recognizer, self.stream) };
            }
            Ok(output)
        }

        fn finalize(&mut self) -> Result<Option<String>, String> {
            unsafe { sys::SherpaOnnxOnlineStreamInputFinished(self.stream) };
            self.decode_pending();
            let text = self.current_text();
            Ok((!text.is_empty()).then_some(text))
        }
    }

    impl Drop for OnlineSherpaEngine {
        fn drop(&mut self) {
            unsafe {
                sys::SherpaOnnxDestroyOnlineStream(self.stream);
                sys::SherpaOnnxDestroyOnlineRecognizer(self.recognizer);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::path::PathBuf;

        fn paths(joiner: bool) -> ResolvedModelPaths {
            ResolvedModelPaths {
                encoder: PathBuf::from("/m/encoder.onnx"),
                decoder: PathBuf::from("/m/decoder.onnx"),
                joiner: joiner.then(|| PathBuf::from("/m/joiner.onnx")),
                tokens: PathBuf::from("/m/tokens.txt"),
            }
        }

        fn spec(model_type: &str, streaming: bool) -> LocalSpeechModelSpec {
            LocalSpeechModelSpec {
                model_type: model_type.to_string(),
                streaming,
                sample_rate: 16_000,
                files: vec![],
            }
        }

        #[test]
        fn factory_accepts_catalog_combinations_and_rejects_unknown_types() {
            assert!(factory(spec("transducer", true), paths(true)).is_ok());
            assert!(factory(spec("paraformer", true), paths(false)).is_ok());
            assert!(factory(spec("whisper", false), paths(false)).is_ok());
            assert!(factory(spec("transducer", false), paths(true)).is_ok());
            // Streaming whisper and unknown families are not a thing in the
            // catalog; the factory must reject before a session thread spawns.
            assert!(factory(spec("whisper", true), paths(false)).is_err());
            assert!(factory(spec("nemo-ctc", false), paths(false)).is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn capability_probe_matches_compiled_feature() {
        assert_eq!(local_inference_supported(), cfg!(feature = "local-speech"));
    }

    #[cfg(not(feature = "local-speech"))]
    #[test]
    fn factory_reports_typed_gap_without_the_engine_feature() {
        let spec = LocalSpeechModelSpec {
            model_type: "whisper".to_string(),
            streaming: false,
            sample_rate: 16_000,
            files: vec![],
        };
        let paths = ResolvedModelPaths {
            encoder: PathBuf::from("/m/encoder.onnx"),
            decoder: PathBuf::from("/m/decoder.onnx"),
            joiner: None,
            tokens: PathBuf::from("/m/tokens.txt"),
        };
        let Err(error) = local_engine_factory(&spec, &paths) else {
            panic!("expected typed gap without the engine feature");
        };
        assert!(error.contains("not available in the Tauri shell"));
    }

    // Why: keep the import used in both feature configurations.
    #[cfg(feature = "local-speech")]
    #[test]
    fn factory_is_constructible_with_the_engine_feature() {
        let spec = LocalSpeechModelSpec {
            model_type: "whisper".to_string(),
            streaming: false,
            sample_rate: 16_000,
            files: vec![],
        };
        let paths = ResolvedModelPaths {
            encoder: PathBuf::from("/m/encoder.onnx"),
            decoder: PathBuf::from("/m/decoder.onnx"),
            joiner: None,
            tokens: PathBuf::from("/m/tokens.txt"),
        };
        assert!(local_engine_factory(&spec, &paths).is_ok());
    }
}
