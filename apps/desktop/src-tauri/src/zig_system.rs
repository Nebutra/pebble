use serde::Serialize;
use std::ffi::{c_char, c_int, CStr};

const EXPECTED_ABI_VERSION: i32 = 1;

unsafe extern "C" {
    fn pebble_system_abi_version() -> c_int;
    fn pebble_system_status_message(status: c_int) -> *const c_char;
    fn pebble_system_signal_send_pid(pid: u64, signal: c_int) -> c_int;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZigSystemStatus {
    linked: bool,
    abi_version: i32,
    expected_abi_version: i32,
    ok_message: String,
}

pub fn verify_linked_abi() -> Result<(), String> {
    let version = abi_version();
    if version != EXPECTED_ABI_VERSION {
        return Err(format!(
            "Pebble Zig system ABI mismatch: expected {EXPECTED_ABI_VERSION}, got {version}."
        ));
    }
    Ok(())
}

#[cfg(unix)]
pub fn kill_process(pid: u32) -> Result<(), String> {
    // SAFETY: pid is widened without truncation and signal 9 matches SIGKILL
    // on every Unix target supported by this library.
    let status = unsafe { pebble_system_signal_send_pid(u64::from(pid), 9) };
    if status == 0 {
        return Ok(());
    }
    Err(format!(
        "Zig system process kill failed: {}",
        status_message(status)
    ))
}

#[tauri::command]
pub fn zig_system_status() -> ZigSystemStatus {
    ZigSystemStatus {
        linked: true,
        abi_version: abi_version(),
        expected_abi_version: EXPECTED_ABI_VERSION,
        ok_message: status_message(0),
    }
}

fn abi_version() -> i32 {
    // SAFETY: the linked Zig ABI exports a no-argument integer function.
    unsafe { pebble_system_abi_version() }
}

fn status_message(status: i32) -> String {
    // SAFETY: the Zig ABI returns process-lifetime static, null-terminated strings.
    let pointer = unsafe { pebble_system_status_message(status) };
    if pointer.is_null() {
        return "unknown".to_string();
    }
    unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linked_library_matches_the_declared_abi() {
        verify_linked_abi().expect("linked Zig ABI");
        let status = zig_system_status();
        assert!(status.linked);
        assert_eq!(status.abi_version, EXPECTED_ABI_VERSION);
        assert_eq!(status.ok_message, "ok");
    }
}
