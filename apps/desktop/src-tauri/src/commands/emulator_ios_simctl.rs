//! Pure parsing/mapping logic for the iOS Simulator (`xcrun simctl`) adapter.
//! Isolated from process-spawn/IO so it is unit-testable without a simulator
//! runtime installed (see `emulator_ios_provider.rs` for the process boundary).

use serde::Deserialize;
use serde_json::Value;

/// One device entry from `xcrun simctl list devices --json`, normalized
/// across the runtime-keyed map the tool actually emits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SimctlDevice {
    pub udid: String,
    pub name: String,
    /// Raw simctl state string ("Booted", "Shutdown", "Booting", ...).
    pub state: String,
    /// Runtime identifier, e.g. "com.apple.CoreSimulator.SimRuntime.iOS-17-5".
    pub runtime: String,
    pub is_available: bool,
}

#[derive(Debug, Deserialize)]
struct RawDeviceList {
    #[serde(default)]
    devices: std::collections::BTreeMap<String, Vec<RawDevice>>,
}

#[derive(Debug, Deserialize, Default)]
struct RawDevice {
    #[serde(default)]
    udid: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(rename = "isAvailable", default)]
    is_available: Option<bool>,
}

/// Parses `xcrun simctl list devices --json` (or `-j`) stdout. Devices
/// missing a udid are skipped — simctl emits placeholder entries for
/// unavailable runtimes in some Xcode versions.
pub fn parse_simctl_device_list(stdout: &str) -> Result<Vec<SimctlDevice>, String> {
    let trimmed = stdout.trim();
    let source = if trimmed.is_empty() { "{}" } else { trimmed };
    let raw: RawDeviceList =
        serde_json::from_str(source).map_err(|error| format!("invalid simctl JSON: {error}"))?;

    let mut devices = Vec::new();
    for (runtime, entries) in raw.devices {
        for entry in entries {
            let Some(udid) = entry.udid.filter(|value| !value.trim().is_empty()) else {
                continue;
            };
            devices.push(SimctlDevice {
                name: entry
                    .name
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| udid.clone()),
                udid,
                state: entry.state.unwrap_or_else(|| "unknown".to_string()),
                runtime: runtime.clone(),
                is_available: entry.is_available.unwrap_or(true),
            });
        }
    }
    Ok(devices)
}

/// The Go runtime's `EmulatorDeviceStatus` vocabulary
/// (runtime/go/internal/runtimecore/domain.go).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmulatorDeviceStatus {
    Available,
    Booting,
    Running,
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

/// Maps a raw simctl state string onto the Go runtime's device status enum.
/// `is_available: false` (a simctl runtime marked as unusable, e.g. a deleted
/// Xcode platform) always wins over the reported boot state.
pub fn map_simctl_state(state: &str, is_available: bool) -> EmulatorDeviceStatus {
    if !is_available {
        return EmulatorDeviceStatus::Error;
    }
    match state {
        "Booted" => EmulatorDeviceStatus::Running,
        "Booting" => EmulatorDeviceStatus::Booting,
        "Shutdown" | "Shutting Down" => EmulatorDeviceStatus::Available,
        _ => EmulatorDeviceStatus::Stopped,
    }
}

/// Builds the `xcrun` argv for each simctl-backed operation this adapter
/// supports. Kept separate from execution so argument construction is
/// testable without spawning a process.
///
/// `Shutdown`/`OpenUrl`/`StatusBarOverride` are reserved for device-lifecycle
/// verbs the Go action queue does not expose yet (its `isEmulatorCommand`
/// vocabulary is tap/swipe/type/install/launch/screenshot/logs/pressKey/
/// rotate only); kept here, with argv construction tested, so wiring a future
/// queue verb is a call-site change, not a new command shape.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub enum SimctlCommand {
    ListDevices,
    Boot {
        udid: String,
    },
    Shutdown {
        udid: String,
    },
    Install {
        udid: String,
        app_path: String,
    },
    Launch {
        udid: String,
        bundle_id: String,
    },
    Screenshot {
        udid: String,
        out_path: String,
    },
    LogsSnapshot {
        udid: String,
        last_seconds: u16,
    },
    OpenUrl {
        udid: String,
        url: String,
    },
    /// `simctl status_bar <udid> override ...` — the one simctl-native way to
    /// script visible device state without synthetic touch input.
    StatusBarOverride {
        udid: String,
        args: Vec<String>,
    },
}

impl SimctlCommand {
    pub fn to_argv(&self) -> Vec<String> {
        match self {
            Self::ListDevices => vec![
                "simctl".to_string(),
                "list".to_string(),
                "devices".to_string(),
                "--json".to_string(),
            ],
            Self::Boot { udid } => vec!["simctl".to_string(), "boot".to_string(), udid.clone()],
            Self::Shutdown { udid } => {
                vec!["simctl".to_string(), "shutdown".to_string(), udid.clone()]
            }
            Self::Install { udid, app_path } => vec![
                "simctl".to_string(),
                "install".to_string(),
                udid.clone(),
                app_path.clone(),
            ],
            Self::Launch { udid, bundle_id } => vec![
                "simctl".to_string(),
                "launch".to_string(),
                udid.clone(),
                bundle_id.clone(),
            ],
            Self::Screenshot { udid, out_path } => vec![
                "simctl".to_string(),
                "io".to_string(),
                udid.clone(),
                "screenshot".to_string(),
                out_path.clone(),
            ],
            Self::LogsSnapshot { udid, last_seconds } => vec![
                "simctl".to_string(),
                "spawn".to_string(),
                udid.clone(),
                "log".to_string(),
                "show".to_string(),
                "--last".to_string(),
                format!("{last_seconds}s"),
                "--style".to_string(),
                "compact".to_string(),
            ],
            Self::OpenUrl { udid, url } => vec![
                "simctl".to_string(),
                "openurl".to_string(),
                udid.clone(),
                url.clone(),
            ],
            Self::StatusBarOverride { udid, args } => {
                let mut argv = vec![
                    "simctl".to_string(),
                    "status_bar".to_string(),
                    udid.clone(),
                    "override".to_string(),
                ];
                argv.extend(args.iter().cloned());
                argv
            }
        }
    }
}

/// A simctl error is idempotent-boot ("Unable to boot device in current
/// state: Booted") or idempotent-shutdown text; the caller should treat these
/// as success rather than a failure.
pub fn is_already_booted_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("booted") || lower.contains("current state: booted")
}

pub fn is_already_shutdown_error(message: &str) -> bool {
    message.to_lowercase().contains("current state: shutdown")
}

/// Extracts a `payload.command` field from an `emulator.*` claimed-action
/// JSON payload (mirrors `execute_claimed_action`'s access pattern for
/// computer-use). Returns `None` when the field is absent or not a string.
pub fn payload_str<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(Value::as_str)
}

/// Reads a numeric coordinate from a queued input action.
pub fn payload_f64(payload: &Value, key: &str) -> Option<f64> {
    payload.get(key).and_then(Value::as_f64)
}

/// Validated input capabilities sent directly to the bundled native helper.
#[derive(Debug, Clone, PartialEq)]
pub enum ServeSimInputCommand {
    Gesture {
        point_json: String,
        udid: String,
    },
    Tap {
        x: f64,
        y: f64,
        udid: String,
    },
    Type {
        text: String,
        udid: String,
    },
    Button {
        name: String,
        udid: String,
    },
    Rotate {
        orientation: String,
        udid: String,
    },
    CoreAnimationDebug {
        option: String,
        enabled: bool,
        udid: String,
    },
    MemoryWarning {
        udid: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "devices": {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
          {
            "udid": "AAAAAAAA-0000-0000-0000-000000000001",
            "name": "iPhone 15",
            "state": "Booted",
            "isAvailable": true
          },
          {
            "udid": "AAAAAAAA-0000-0000-0000-000000000002",
            "name": "iPhone SE (3rd generation)",
            "state": "Shutdown",
            "isAvailable": true
          },
          { "state": "Shutdown", "isAvailable": false }
        ],
        "com.apple.CoreSimulator.SimRuntime.watchOS-10-5": []
      }
    }"#;

    #[test]
    fn builds_bounded_log_snapshot_argv() {
        assert_eq!(
            SimctlCommand::LogsSnapshot {
                udid: "UDID-1".to_string(),
                last_seconds: 45
            }
            .to_argv(),
            ["simctl", "spawn", "UDID-1", "log", "show", "--last", "45s", "--style", "compact"]
                .map(str::to_string)
        );
    }

    #[test]
    fn parses_devices_across_runtimes_and_skips_missing_udid() {
        let devices = parse_simctl_device_list(SAMPLE).unwrap();
        assert_eq!(devices.len(), 2);
        let booted = devices
            .iter()
            .find(|d| d.udid == "AAAAAAAA-0000-0000-0000-000000000001")
            .unwrap();
        assert_eq!(booted.name, "iPhone 15");
        assert_eq!(booted.state, "Booted");
        assert_eq!(
            booted.runtime,
            "com.apple.CoreSimulator.SimRuntime.iOS-17-5"
        );
        assert!(booted.is_available);
    }

    #[test]
    fn parses_empty_device_map() {
        let devices = parse_simctl_device_list("{}").unwrap();
        assert!(devices.is_empty());
    }

    #[test]
    fn parses_blank_stdout_as_empty() {
        let devices = parse_simctl_device_list("   ").unwrap();
        assert!(devices.is_empty());
    }

    #[test]
    fn rejects_invalid_json() {
        let error = parse_simctl_device_list("not json").unwrap_err();
        assert!(error.contains("invalid simctl JSON"));
    }

    #[test]
    fn maps_booted_state_to_running() {
        assert_eq!(
            map_simctl_state("Booted", true),
            EmulatorDeviceStatus::Running
        );
    }

    #[test]
    fn maps_booting_state() {
        assert_eq!(
            map_simctl_state("Booting", true),
            EmulatorDeviceStatus::Booting
        );
    }

    #[test]
    fn maps_shutdown_state_to_available() {
        assert_eq!(
            map_simctl_state("Shutdown", true),
            EmulatorDeviceStatus::Available
        );
    }

    #[test]
    fn maps_unknown_state_to_stopped() {
        assert_eq!(
            map_simctl_state("weird-state", true),
            EmulatorDeviceStatus::Stopped
        );
    }

    #[test]
    fn unavailable_device_is_always_error_regardless_of_state() {
        assert_eq!(
            map_simctl_state("Booted", false),
            EmulatorDeviceStatus::Error
        );
    }

    #[test]
    fn builds_list_devices_argv() {
        assert_eq!(
            SimctlCommand::ListDevices.to_argv(),
            vec!["simctl", "list", "devices", "--json"]
        );
    }

    #[test]
    fn builds_boot_argv() {
        let command = SimctlCommand::Boot {
            udid: "UDID-1".to_string(),
        };
        assert_eq!(command.to_argv(), vec!["simctl", "boot", "UDID-1"]);
    }

    #[test]
    fn builds_install_argv() {
        let command = SimctlCommand::Install {
            udid: "UDID-1".to_string(),
            app_path: "/tmp/App.app".to_string(),
        };
        assert_eq!(
            command.to_argv(),
            vec!["simctl", "install", "UDID-1", "/tmp/App.app"]
        );
    }

    #[test]
    fn builds_launch_argv() {
        let command = SimctlCommand::Launch {
            udid: "UDID-1".to_string(),
            bundle_id: "com.example.app".to_string(),
        };
        assert_eq!(
            command.to_argv(),
            vec!["simctl", "launch", "UDID-1", "com.example.app"]
        );
    }

    #[test]
    fn builds_screenshot_argv() {
        let command = SimctlCommand::Screenshot {
            udid: "UDID-1".to_string(),
            out_path: "/tmp/shot.png".to_string(),
        };
        assert_eq!(
            command.to_argv(),
            vec!["simctl", "io", "UDID-1", "screenshot", "/tmp/shot.png"]
        );
    }

    #[test]
    fn builds_status_bar_override_argv() {
        let command = SimctlCommand::StatusBarOverride {
            udid: "UDID-1".to_string(),
            args: vec!["--time".to_string(), "9:41".to_string()],
        };
        assert_eq!(
            command.to_argv(),
            vec![
                "simctl",
                "status_bar",
                "UDID-1",
                "override",
                "--time",
                "9:41"
            ]
        );
    }

    #[test]
    fn detects_already_booted_error_text() {
        assert!(is_already_booted_error(
            "Unable to boot device in current state: Booted"
        ));
    }

    #[test]
    fn detects_already_shutdown_error_text() {
        assert!(is_already_shutdown_error(
            "An error was encountered processing the command (domain=..., code=...): Unable to shutdown device in current state: Shutdown"
        ));
    }

    #[test]
    fn payload_helpers_read_expected_types() {
        let payload: Value =
            serde_json::from_str(r#"{"udid":"UDID-1","x":12.5,"appPath":"/tmp/a.app"}"#).unwrap();
        assert_eq!(payload_str(&payload, "udid"), Some("UDID-1"));
        assert_eq!(payload_f64(&payload, "x"), Some(12.5));
        assert_eq!(payload_str(&payload, "missing"), None);
    }
}
