//! Speech model archive download, integrity verification, and extraction.
//! Mirrors Electron's `model-manager.ts` state machine: download to
//! `<models-dir>/<id>.tar.bz2`, sha256-verify, extract with the OS `tar`, then
//! validate the manifest's expected files.

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const EXTRACTION_TIMEOUT: Duration = Duration::from_secs(600);

pub fn is_valid_speech_model_id(model_id: &str) -> bool {
    // Why: the id becomes a directory name under the models root; reject
    // separators and dot-segments so a hostile manifest cannot escape it.
    !model_id.is_empty()
        && !model_id.contains("..")
        && model_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && model_id
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
}

pub fn safe_model_dir(models_dir: &Path, model_id: &str) -> Result<PathBuf, String> {
    if !is_valid_speech_model_id(model_id) {
        return Err(format!("Invalid model id: {model_id}"));
    }
    let dir = models_dir.join(model_id);
    if dir.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("Invalid model id: {model_id}"));
    }
    Ok(dir)
}

pub fn model_files_present(model_dir: &Path, files: &[String]) -> bool {
    !files.is_empty() && files.iter().all(|f| model_dir.join(f).exists())
}

pub async fn download_archive(
    url: &str,
    dest: &Path,
    expected_size: u64,
    aborted: &Arc<AtomicBool>,
    mut on_progress: impl FnMut(f64),
) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid download URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Model downloads must use HTTPS".to_string());
    }

    // Why: reqwest follows redirects itself (10 max); enforcing https on every
    // hop keeps parity with Electron's per-redirect scheme check.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 5 {
                attempt.error("Too many redirects")
            } else if attempt.url().scheme() != "https" {
                attempt.error("Model download redirect must use HTTPS")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(parsed).send().await.map_err(|e| e.to_string())?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let total_size = response.content_length().unwrap_or(expected_size).max(1);
    let mut downloaded: u64 = 0;
    let mut file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();

    loop {
        // Why: a stalled HTTPS stream may never yield another chunk; bound the
        // wait so cancelled/wedged downloads fail instead of hanging forever.
        let chunk = match tokio::time::timeout(DOWNLOAD_IDLE_TIMEOUT, stream.next()).await {
            Err(_) => {
                return Err(format!(
                    "Model download timed out after {} seconds without network activity",
                    DOWNLOAD_IDLE_TIMEOUT.as_secs()
                ))
            }
            Ok(None) => break,
            Ok(Some(chunk)) => chunk.map_err(|e| e.to_string())?,
        };
        if aborted.load(Ordering::SeqCst) {
            return Err("Aborted".to_string());
        }
        use std::io::Write;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        on_progress((downloaded as f64 / total_size as f64).min(0.9));
    }

    Ok(())
}

pub fn verify_archive_sha256(archive_path: &Path, expected_sha256: &str) -> Result<(), String> {
    let mut file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected_sha256.to_lowercase() {
        // Why: these archives feed native model parsers; filename checks do
        // not protect against compromised or redirected release assets.
        return Err("Downloaded model archive failed integrity verification".to_string());
    }
    Ok(())
}

fn tar_executable() -> Result<PathBuf, String> {
    if !cfg!(target_os = "windows") {
        return Ok(PathBuf::from("tar"));
    }
    let system_root = std::env::var("SystemRoot")
        .or_else(|_| std::env::var("WINDIR"))
        .unwrap_or_else(|_| "C:\\Windows".to_string());
    let candidate = Path::new(&system_root).join("System32").join("tar.exe");
    if candidate.exists() {
        return Ok(candidate);
    }
    // Why: packaged Windows apps can have a stripped PATH. Use the OS tar
    // location explicitly, and fail with a repairable error if it is absent.
    Err(format!(
        "Windows tar.exe not found at {}",
        candidate.display()
    ))
}

/// Blocking; callers must run this off the async runtime (spawn_blocking).
pub fn extract_archive_blocking(
    archive_path: &Path,
    model_dir: &Path,
    aborted: &Arc<AtomicBool>,
) -> Result<(), String> {
    fs::create_dir_all(model_dir).map_err(|e| e.to_string())?;

    let mut child = std::process::Command::new(tar_executable()?)
        .arg("-xjf")
        .arg(archive_path)
        .arg("-C")
        .arg(model_dir)
        .arg("--strip-components=1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start tar: {e}"))?;

    let stderr_pipe = child.stderr.take();
    // Why: read stderr on a side thread so a chatty tar cannot fill the pipe
    // and deadlock the wait loop below.
    let stderr_reader = std::thread::spawn(move || {
        let mut output = String::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_string(&mut output);
        }
        output
    });

    let started = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let stderr = stderr_reader.join().unwrap_or_default();
            if status.success() {
                return Ok(());
            }
            return Err(format!(
                "tar exited with code {}: {}",
                status.code().unwrap_or(-1),
                stderr.chars().take(500).collect::<String>()
            ));
        }
        if aborted.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Aborted".to_string());
        }
        if started.elapsed() > EXTRACTION_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Extraction timed out after 10 minutes".to_string());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Some archives nest files one directory deeper than `--strip-components=1`
/// expects; if the manifest files are missing, hoist them from the first
/// nested directory that contains one.
pub fn flatten_nested_model_dir(model_dir: &Path, files: &[String]) -> Result<(), String> {
    let entries = fs::read_dir(model_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let nested = entry.path();
        if !nested.is_dir() {
            continue;
        }
        let nested_names: Vec<String> = fs::read_dir(&nested)
            .map_err(|e| e.to_string())?
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        if !files.iter().any(|f| nested_names.contains(f)) {
            continue;
        }
        for name in nested_names {
            fs::rename(nested.join(&name), model_dir.join(&name)).map_err(|e| e.to_string())?;
        }
        fs::remove_dir_all(&nested).map_err(|e| e.to_string())?;
        return Ok(());
    }
    Ok(())
}

pub fn cleanup_partial_model(archive_path: &Path, model_dir: &Path) {
    let _ = fs::remove_file(archive_path);
    let _ = fs::remove_dir_all(model_dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_id_validation_rejects_path_escapes() {
        assert!(is_valid_speech_model_id("parakeet-tdt-0.6b-v3-int8"));
        assert!(is_valid_speech_model_id("whisper-tiny"));
        assert!(!is_valid_speech_model_id(""));
        assert!(!is_valid_speech_model_id("../evil"));
        assert!(!is_valid_speech_model_id("a/b"));
        assert!(!is_valid_speech_model_id("a\\b"));
        assert!(!is_valid_speech_model_id("..model"));
        assert!(!is_valid_speech_model_id(".hidden"));
        assert!(!is_valid_speech_model_id("model id"));
    }

    #[test]
    fn safe_model_dir_stays_under_models_root() {
        let root = Path::new("/models");
        assert_eq!(
            safe_model_dir(root, "whisper-tiny").unwrap(),
            root.join("whisper-tiny")
        );
        assert!(safe_model_dir(root, "../escape").is_err());
    }

    #[test]
    fn verify_sha256_detects_mismatch_and_match() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("archive.tar.bz2");
        fs::write(&file, b"hello world").unwrap();
        let expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
        assert!(verify_archive_sha256(&file, expected).is_ok());
        assert!(verify_archive_sha256(&file, &expected.to_uppercase()).is_ok());
        assert!(verify_archive_sha256(&file, &"0".repeat(64)).is_err());
    }

    #[test]
    fn model_files_present_requires_all_manifest_files() {
        let dir = tempfile::tempdir().unwrap();
        let files = vec!["encoder.onnx".to_string(), "tokens.txt".to_string()];
        assert!(!model_files_present(dir.path(), &files));
        fs::write(dir.path().join("encoder.onnx"), b"x").unwrap();
        assert!(!model_files_present(dir.path(), &files));
        fs::write(dir.path().join("tokens.txt"), b"x").unwrap();
        assert!(model_files_present(dir.path(), &files));
        assert!(!model_files_present(dir.path(), &[]));
    }

    #[test]
    fn flatten_hoists_nested_model_files() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("sherpa-onnx-whisper-tiny");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("tiny-encoder.onnx"), b"x").unwrap();
        fs::write(nested.join("tiny-tokens.txt"), b"x").unwrap();

        let files = vec![
            "tiny-encoder.onnx".to_string(),
            "tiny-tokens.txt".to_string(),
        ];
        flatten_nested_model_dir(dir.path(), &files).unwrap();
        assert!(model_files_present(dir.path(), &files));
        assert!(!nested.exists());
    }
}
