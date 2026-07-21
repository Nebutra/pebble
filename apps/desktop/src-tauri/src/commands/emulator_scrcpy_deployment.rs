use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::Manager;

pub const SCRCPY_SERVER_VERSION: &str = "2.4";
pub const SCRCPY_DEVICE_JAR_PATH: &str = "/data/local/tmp/scrcpy-server.jar";
const SCRCPY_SERVER_SHA256: &str =
    "93c272b7438605c055e127f7444064ed78fa9ca49f81156777fd201e79ce7ba3";
const MIN_SERVER_BYTES: usize = 10_000;
const MAX_SERVER_BYTES: usize = 2 * 1024 * 1024;

pub fn push_argv(serial: &str, local_jar: &Path) -> Vec<String> {
    vec![
        "-s".to_string(),
        serial.to_string(),
        "push".to_string(),
        local_jar.to_string_lossy().into_owned(),
        SCRCPY_DEVICE_JAR_PATH.to_string(),
    ]
}

pub fn forward_argv(serial: &str, scid: &str) -> Vec<String> {
    vec![
        "-s".to_string(),
        serial.to_string(),
        "forward".to_string(),
        "tcp:0".to_string(),
        format!("localabstract:scrcpy_{scid}"),
    ]
}

pub fn remove_forward_argv(serial: &str, port: u16) -> Vec<String> {
    vec![
        "-s".to_string(),
        serial.to_string(),
        "forward".to_string(),
        "--remove".to_string(),
        format!("tcp:{port}"),
    ]
}

pub fn server_argv(serial: &str, scid: &str, max_size: Option<u32>) -> Vec<String> {
    let mut argv = vec![
        "-s".to_string(),
        serial.to_string(),
        "shell".to_string(),
        format!("CLASSPATH={SCRCPY_DEVICE_JAR_PATH}"),
        "app_process".to_string(),
        "/".to_string(),
        "com.genymobile.scrcpy.Server".to_string(),
        SCRCPY_SERVER_VERSION.to_string(),
        format!("scid={scid}"),
        "log_level=info".to_string(),
        "tunnel_forward=true".to_string(),
        "audio=false".to_string(),
        "control=true".to_string(),
        "cleanup=true".to_string(),
        "clipboard_autosync=false".to_string(),
        "video_codec=h264".to_string(),
        "send_device_meta=true".to_string(),
        "send_codec_meta=true".to_string(),
        "send_frame_meta=true".to_string(),
    ];
    if let Some(max_size) = max_size {
        argv.push(format!("max_size={max_size}"));
    }
    argv
}

pub async fn ensure_server_jar(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("could not resolve Pebble cache directory: {error}"))?
        .join("scrcpy");
    let path = directory.join(format!("scrcpy-server-v{SCRCPY_SERVER_VERSION}.jar"));
    if file_has_expected_digest(&path) {
        return Ok(path);
    }
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create scrcpy cache directory: {error}"))?;
    let url = format!(
        "https://github.com/Genymobile/scrcpy/releases/download/v{0}/scrcpy-server-v{0}",
        SCRCPY_SERVER_VERSION
    );
    let response = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| format!("could not create scrcpy download client: {error}"))?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("could not download scrcpy server: {error}"))?
        .error_for_status()
        .map_err(|error| format!("could not download scrcpy server: {error}"))?;
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("scrcpy server download failed: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_SERVER_BYTES {
            return Err("scrcpy server download exceeded the size limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    verify_server_bytes(&bytes)?;
    let temporary = path.with_extension("jar.download");
    std::fs::write(&temporary, bytes)
        .map_err(|error| format!("could not cache scrcpy server: {error}"))?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("could not finalize scrcpy server cache: {error}"))?;
    Ok(path)
}

fn file_has_expected_digest(path: &Path) -> bool {
    std::fs::read(path)
        .ok()
        .is_some_and(|bytes| verify_server_bytes(&bytes).is_ok())
}

fn verify_server_bytes(bytes: &[u8]) -> Result<(), String> {
    if !(MIN_SERVER_BYTES..=MAX_SERVER_BYTES).contains(&bytes.len()) {
        return Err("scrcpy server download was empty or truncated".to_string());
    }
    let digest = format!("{:x}", Sha256::digest(bytes));
    if digest != SCRCPY_SERVER_SHA256 {
        return Err("scrcpy server checksum did not match the pinned v2.4 artifact".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_byte_exact_scrcpy_24_argv() {
        let push = push_argv("emulator-5554", Path::new("/tmp/server.jar"));
        assert_eq!(push[0..3], ["-s", "emulator-5554", "push"]);
        assert_eq!(push.last().unwrap(), SCRCPY_DEVICE_JAR_PATH);
        assert_eq!(
            forward_argv("emulator-5554", "0123abcd"),
            [
                "-s",
                "emulator-5554",
                "forward",
                "tcp:0",
                "localabstract:scrcpy_0123abcd"
            ]
        );
        let server = server_argv("emulator-5554", "0123abcd", Some(1920));
        assert!(server.contains(&"video_codec=h264".to_string()));
        assert!(server.contains(&"send_frame_meta=true".to_string()));
        assert!(server.contains(&"max_size=1920".to_string()));
    }

    #[test]
    fn rejects_untrusted_or_truncated_server_bytes() {
        assert!(verify_server_bytes(&[0; 100])
            .unwrap_err()
            .contains("truncated"));
        assert!(verify_server_bytes(&vec![0; MIN_SERVER_BYTES])
            .unwrap_err()
            .contains("checksum"));
    }
}
