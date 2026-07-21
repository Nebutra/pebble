use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const REPOSITORY: &str = "nebutra/pebble";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

#[tauri::command]
pub async fn star_nag_check() -> Option<bool> {
    // Why: gh may wait on credentials or the network; never occupy Tauri's
    // command executor while Settings is committing its first frame.
    tauri::async_runtime::spawn_blocking(|| {
        if run_gh(&["auth", "status"]) != Some(true) {
            return None;
        }
        let endpoint = format!("user/starred/{REPOSITORY}");
        run_gh(&["api", &endpoint])
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn star_nag_star() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        let endpoint = format!("user/starred/{REPOSITORY}");
        run_gh(&["api", "-X", "PUT", &endpoint]).unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

fn run_gh(args: &[&str]) -> Option<bool> {
    let mut child = Command::new("gh")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    // Why: drain both pipes while waiting so a verbose gh/auth failure cannot
    // fill a pipe and leave the desktop host blocked indefinitely.
    let stdout = spawn_reader(child.stdout.take());
    let stderr = spawn_reader(child.stderr.take());
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = stdout.join();
                let _ = stderr.join();
                return Some(status.success());
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn spawn_reader<R: Read + Send + 'static>(pipe: Option<R>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        if let Some(mut pipe) = pipe {
            let mut sink = Vec::new();
            let _ = pipe.read_to_end(&mut sink);
        }
    })
}
