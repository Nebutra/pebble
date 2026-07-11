//! Pure parsing/argv-building logic for the Android (`adb` / `emulator` /
//! `avdmanager`) adapter. Isolated from process-spawn/IO so it is
//! unit-testable without the Android SDK installed (see
//! `emulator_android_provider.rs` for the process boundary), mirroring
//! `emulator_ios_simctl.rs`'s split for the iOS Simulator adapter.

use serde_json::Value;

/// One device entry from `adb devices -l`. `adb`'s own listing carries no AVD
/// name — the caller resolves it separately per serial via `emulator
/// -list-avds`/`adb emu avd name` (see `emulator_android_provider.rs`'s
/// `resolve_avd_name`), so it is not a field here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdbDevice {
    /// adb serial, e.g. "emulator-5554" or a hardware device's USB/TCP serial.
    pub serial: String,
    /// Raw adb state ("device", "offline", "unauthorized", ...).
    pub state: String,
    /// `adb devices -l`'s `model:` field when present (hardware devices).
    pub model: Option<String>,
}

/// The Go runtime's `EmulatorDeviceStatus` vocabulary
/// (pebble/go-runtime/internal/runtimecore/domain.go), same enum shape as
/// `emulator_ios_simctl::EmulatorDeviceStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmulatorDeviceStatus {
    Available,
    Booting,
    Running,
    // Reserved for parity with the iOS status vocabulary; adb's state
    // machine collapses this into `Error` (see `map_adb_state`) since adb
    // has no "defined but explicitly stopped" distinct from "not connected".
    #[allow(dead_code)]
    Stopped,
    Error,
}

impl EmulatorDeviceStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Booting => "booting",
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::Error => "error",
        }
    }
}

/// Maps a raw `adb devices` state string onto the Go runtime's device status
/// enum. Unlike simctl (which reports Shutdown devices as list entries), adb
/// only lists devices/emulators that are already connected — so "offline"
/// and "unauthorized" map to `Error` (a connected-but-unusable device),
/// never `Available`/`Stopped` (those describe an AVD adb cannot see at all;
/// see `map_avd_only_state` for AVDs known only through `emulator -list-avds`).
pub fn map_adb_state(state: &str) -> EmulatorDeviceStatus {
    match state {
        "device" => EmulatorDeviceStatus::Running,
        "offline" => EmulatorDeviceStatus::Error,
        "unauthorized" => EmulatorDeviceStatus::Error,
        "bootloader" | "recovery" | "sideload" => EmulatorDeviceStatus::Booting,
        _ => EmulatorDeviceStatus::Error,
    }
}

/// Status for an AVD name that `emulator -list-avds` reports but that has no
/// corresponding `adb devices` entry (i.e. it is defined but not booted).
pub const fn avd_only_status() -> EmulatorDeviceStatus {
    EmulatorDeviceStatus::Available
}

/// Parses `adb devices -l` stdout into device records. The first line is
/// always the `List of devices attached` header (with a variable number of
/// blank lines around it); each device line is
/// `<serial> <state> [key:value ...]`. Lines that don't parse as
/// `serial state` are skipped rather than erroring, since adb has printed
/// warnings (e.g. a stale-adb-server notice) on this stream in the wild.
pub fn parse_adb_devices(stdout: &str) -> Vec<AdbDevice> {
    let mut devices = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("List of devices attached") {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(serial) = parts.next() else {
            continue;
        };
        let Some(state) = parts.next() else {
            continue;
        };
        let mut model = None;
        for field in parts {
            if let Some(value) = field.strip_prefix("model:") {
                model = Some(value.to_string());
            }
        }
        devices.push(AdbDevice {
            serial: serial.to_string(),
            state: state.to_string(),
            model,
        });
    }
    devices
}

/// Parses `emulator -list-avds` stdout: one AVD name per line, blank lines
/// ignored. AVD names may not contain whitespace (the tool substitutes `_`),
/// so no further splitting is needed per line.
pub fn parse_avd_list(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// Resolves AVD names onto `emulator-*` serials via `adb -s <serial> emu avd
/// name`, the standard way to map a running emulator console back to its AVD
/// (there is no bulk equivalent — each running emulator console must be
/// queried individually). This function only shapes the argv/parsing; the
/// per-serial dispatch loop lives in the provider.
pub fn build_avd_name_argv(serial: &str) -> Vec<String> {
    vec![
        "-s".to_string(),
        serial.to_string(),
        "emu".to_string(),
        "avd".to_string(),
        "name".to_string(),
    ]
}

/// `adb -s <serial> emu avd name` prints the AVD name as its first
/// non-"OK"/non-empty line.
pub fn parse_avd_name_response(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && *line != "OK")
        .map(str::to_string)
}

/// Only `emulator-*` serials are AVD-backed; other serials (USB/TCP/Wi-Fi
/// physical devices) never resolve to an AVD name.
pub fn is_emulator_serial(serial: &str) -> bool {
    serial.starts_with("emulator-")
}

/// Builds the `adb`/`emulator` argv for each operation this adapter
/// supports. Kept separate from execution so argument construction is
/// testable without spawning a process, mirroring
/// `emulator_ios_simctl::SimctlCommand`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdbCommand {
    ListDevices,
    ListAvds,
    Install {
        serial: String,
        apk_path: String,
    },
    /// `monkey -p <package> -c android.intent.category.LAUNCHER 1` launches
    /// a package's default launcher activity without needing the caller to
    /// know the specific activity class name, matching what Electron's
    /// `android-emulator-backend.ts` launch flow does.
    Launch {
        serial: String,
        package: String,
    },
    Screenshot {
        serial: String,
    },
    /// `adb -s <serial> uninstall <package>` — reserved for a future
    /// device-lifecycle verb the Go action queue does not expose yet (its
    /// `isEmulatorCommand` vocabulary is tap/swipe/type/install/launch/
    /// screenshot/logs/pressKey/rotate only); kept here, with argv
    /// construction tested, so wiring it later is a call-site change.
    #[allow(dead_code)]
    Uninstall {
        serial: String,
        package: String,
    },
}

impl AdbCommand {
    /// Argv to pass to the `adb` binary (or `emulator` for `ListAvds`, see
    /// `binary_name`).
    pub fn to_argv(&self) -> Vec<String> {
        match self {
            Self::ListDevices => vec!["devices".to_string(), "-l".to_string()],
            Self::ListAvds => vec!["-list-avds".to_string()],
            Self::Install { serial, apk_path } => vec![
                "-s".to_string(),
                serial.clone(),
                "install".to_string(),
                "-r".to_string(),
                apk_path.clone(),
            ],
            Self::Launch { serial, package } => vec![
                "-s".to_string(),
                serial.clone(),
                "shell".to_string(),
                "monkey".to_string(),
                "-p".to_string(),
                package.clone(),
                "-c".to_string(),
                "android.intent.category.LAUNCHER".to_string(),
                "1".to_string(),
            ],
            Self::Screenshot { serial } => vec![
                "-s".to_string(),
                serial.clone(),
                "exec-out".to_string(),
                "screencap".to_string(),
                "-p".to_string(),
            ],
            Self::Uninstall { serial, package } => vec![
                "-s".to_string(),
                serial.clone(),
                "uninstall".to_string(),
                package.clone(),
            ],
        }
    }

    /// `ListAvds` is the only verb that runs through the `emulator` binary
    /// rather than `adb` — the two SDK tools split device-connection state
    /// (`adb`) from AVD-definition listing (`emulator`).
    pub const fn binary_name(&self) -> &'static str {
        match self {
            Self::ListAvds => "emulator",
            _ => "adb",
        }
    }
}

/// Extracts a string field from an `emulator.*` claimed-action JSON payload
/// (mirrors `emulator_ios_simctl::payload_str`).
pub fn payload_str<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(Value::as_str)
}

/// Validates an Android application ID against the platform's own naming
/// rules (dot-separated segments, each starting with a letter and containing
/// only letters/digits/underscores). `adb shell` joins its trailing argv into
/// one string and hands it to the device's shell, so an unvalidated package
/// name reaching `adb shell monkey -p <package> ...` could carry shell
/// metacharacters (`;`, `$()`, backticks) executed on the attached device —
/// this allowlist rejects anything that isn't a real package identifier
/// before it ever reaches argv construction.
pub fn is_valid_android_package_name(value: &str) -> bool {
    if value.is_empty() || value.len() > 255 {
        return false;
    }
    value.split('.').all(|segment| {
        let mut chars = segment.chars();
        matches!(chars.next(), Some(first) if first.is_ascii_alphabetic())
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_package_names_are_accepted() {
        assert!(is_valid_android_package_name("com.example.app"));
        assert!(is_valid_android_package_name("com.example.app_2"));
        assert!(is_valid_android_package_name("a.b.c"));
    }

    #[test]
    fn shell_metacharacters_are_rejected() {
        assert!(!is_valid_android_package_name("com.example;reboot"));
        assert!(!is_valid_android_package_name("com.example$(reboot)"));
        assert!(!is_valid_android_package_name("com.example`reboot`"));
        assert!(!is_valid_android_package_name("com.example && reboot"));
        assert!(!is_valid_android_package_name("com.example|reboot"));
    }

    #[test]
    fn malformed_segments_are_rejected() {
        assert!(!is_valid_android_package_name(""));
        assert!(!is_valid_android_package_name("."));
        assert!(!is_valid_android_package_name("com..example"));
        assert!(!is_valid_android_package_name(".com.example"));
        assert!(!is_valid_android_package_name("com.example."));
        assert!(!is_valid_android_package_name("1com.example"));
        assert!(!is_valid_android_package_name(&"com.".repeat(100)));
    }

    const SAMPLE_DEVICES: &str = "List of devices attached\n\
emulator-5554\tdevice product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\
R58N90ABCDE\tdevice product:o1s model:Galaxy_S23 device:o1s transport_id:2\n\
emulator-5556\toffline transport_id:3\n\
\n";

    #[test]
    fn parses_devices_with_model_and_state() {
        let devices = parse_adb_devices(SAMPLE_DEVICES);
        assert_eq!(devices.len(), 3);

        let emu = devices
            .iter()
            .find(|d| d.serial == "emulator-5554")
            .unwrap();
        assert_eq!(emu.state, "device");
        assert_eq!(emu.model.as_deref(), Some("sdk_gphone64_arm64"));

        let hw = devices.iter().find(|d| d.serial == "R58N90ABCDE").unwrap();
        assert_eq!(hw.state, "device");
        assert_eq!(hw.model.as_deref(), Some("Galaxy_S23"));

        let offline = devices
            .iter()
            .find(|d| d.serial == "emulator-5556")
            .unwrap();
        assert_eq!(offline.state, "offline");
        assert_eq!(offline.model, None);
    }

    #[test]
    fn parses_empty_device_list() {
        let devices = parse_adb_devices("List of devices attached\n\n");
        assert!(devices.is_empty());
    }

    #[test]
    fn parses_blank_stdout_as_empty() {
        assert!(parse_adb_devices("   \n  ").is_empty());
    }

    #[test]
    fn skips_lines_missing_a_state_field() {
        let devices = parse_adb_devices("List of devices attached\nemulator-5554\n");
        assert!(devices.is_empty());
    }

    #[test]
    fn maps_device_state_to_running() {
        assert_eq!(map_adb_state("device"), EmulatorDeviceStatus::Running);
    }

    #[test]
    fn maps_offline_state_to_error() {
        assert_eq!(map_adb_state("offline"), EmulatorDeviceStatus::Error);
    }

    #[test]
    fn maps_unauthorized_state_to_error() {
        assert_eq!(map_adb_state("unauthorized"), EmulatorDeviceStatus::Error);
    }

    #[test]
    fn maps_bootloader_state_to_booting() {
        assert_eq!(map_adb_state("bootloader"), EmulatorDeviceStatus::Booting);
    }

    #[test]
    fn maps_unknown_state_to_error() {
        assert_eq!(map_adb_state("weird-state"), EmulatorDeviceStatus::Error);
    }

    #[test]
    fn avd_only_status_is_available() {
        assert_eq!(avd_only_status(), EmulatorDeviceStatus::Available);
    }

    #[test]
    fn parses_avd_list_one_per_line() {
        let avds = parse_avd_list("Pixel_API_37\nPixel_Tablet_API_34\n");
        assert_eq!(avds, vec!["Pixel_API_37", "Pixel_Tablet_API_34"]);
    }

    #[test]
    fn parses_avd_list_skips_blank_lines() {
        let avds = parse_avd_list("Pixel_API_37\n\n\nPixel_Tablet_API_34\n\n");
        assert_eq!(avds, vec!["Pixel_API_37", "Pixel_Tablet_API_34"]);
    }

    #[test]
    fn parses_empty_avd_list() {
        assert!(parse_avd_list("").is_empty());
    }

    #[test]
    fn builds_avd_name_argv() {
        assert_eq!(
            build_avd_name_argv("emulator-5554"),
            vec!["-s", "emulator-5554", "emu", "avd", "name"]
        );
    }

    #[test]
    fn parses_avd_name_response_skipping_ok_line() {
        let response = parse_avd_name_response("Pixel_API_37\nOK\n");
        assert_eq!(response, Some("Pixel_API_37".to_string()));
    }

    #[test]
    fn parses_avd_name_response_with_leading_ok_line() {
        // Some emulator console versions print OK before the name.
        let response = parse_avd_name_response("OK\nPixel_API_37\n");
        assert_eq!(response, Some("Pixel_API_37".to_string()));
    }

    #[test]
    fn parses_avd_name_response_empty_as_none() {
        assert_eq!(parse_avd_name_response("\n\n"), None);
    }

    #[test]
    fn recognizes_emulator_serials() {
        assert!(is_emulator_serial("emulator-5554"));
        assert!(!is_emulator_serial("R58N90ABCDE"));
    }

    #[test]
    fn builds_list_devices_argv() {
        assert_eq!(AdbCommand::ListDevices.to_argv(), vec!["devices", "-l"]);
        assert_eq!(AdbCommand::ListDevices.binary_name(), "adb");
    }

    #[test]
    fn builds_list_avds_argv() {
        assert_eq!(AdbCommand::ListAvds.to_argv(), vec!["-list-avds"]);
        assert_eq!(AdbCommand::ListAvds.binary_name(), "emulator");
    }

    #[test]
    fn builds_install_argv() {
        let command = AdbCommand::Install {
            serial: "emulator-5554".to_string(),
            apk_path: "/tmp/app.apk".to_string(),
        };
        assert_eq!(
            command.to_argv(),
            vec!["-s", "emulator-5554", "install", "-r", "/tmp/app.apk"]
        );
        assert_eq!(command.binary_name(), "adb");
    }

    #[test]
    fn builds_launch_argv() {
        let command = AdbCommand::Launch {
            serial: "emulator-5554".to_string(),
            package: "com.example.app".to_string(),
        };
        assert_eq!(
            command.to_argv(),
            vec![
                "-s",
                "emulator-5554",
                "shell",
                "monkey",
                "-p",
                "com.example.app",
                "-c",
                "android.intent.category.LAUNCHER",
                "1"
            ]
        );
    }

    #[test]
    fn builds_screenshot_argv() {
        let command = AdbCommand::Screenshot {
            serial: "emulator-5554".to_string(),
        };
        assert_eq!(
            command.to_argv(),
            vec!["-s", "emulator-5554", "exec-out", "screencap", "-p"]
        );
    }

    #[test]
    fn builds_uninstall_argv() {
        let command = AdbCommand::Uninstall {
            serial: "emulator-5554".to_string(),
            package: "com.example.app".to_string(),
        };
        assert_eq!(
            command.to_argv(),
            vec!["-s", "emulator-5554", "uninstall", "com.example.app"]
        );
    }

    #[test]
    fn payload_str_reads_expected_type() {
        let payload: Value =
            serde_json::from_str(r#"{"serial":"emulator-5554","apkPath":"/tmp/a.apk"}"#).unwrap();
        assert_eq!(payload_str(&payload, "serial"), Some("emulator-5554"));
        assert_eq!(payload_str(&payload, "missing"), None);
    }
}
