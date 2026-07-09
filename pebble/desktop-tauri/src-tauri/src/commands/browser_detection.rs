use serde::Serialize;
use serde_json::Value;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy)]
struct ChromiumBrowserDef {
    family: &'static str,
    label: &'static str,
    mac_root: Option<&'static str>,
    win_root: Option<&'static str>,
    linux_root: Option<&'static str>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserProfile {
    name: String,
    directory: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedBrowserInfo {
    family: String,
    label: String,
    profiles: Vec<BrowserProfile>,
    selected_profile: String,
}

const CHROMIUM_BROWSERS: &[ChromiumBrowserDef] = &[
    ChromiumBrowserDef {
        family: "chrome",
        label: "Google Chrome",
        mac_root: Some("Google/Chrome"),
        win_root: Some("Google/Chrome/User Data"),
        linux_root: Some("google-chrome"),
    },
    ChromiumBrowserDef {
        family: "edge",
        label: "Microsoft Edge",
        mac_root: Some("Microsoft Edge"),
        win_root: Some("Microsoft/Edge/User Data"),
        linux_root: Some("microsoft-edge"),
    },
    ChromiumBrowserDef {
        family: "arc",
        label: "Arc",
        mac_root: Some("Arc/User Data"),
        win_root: None,
        linux_root: None,
    },
    ChromiumBrowserDef {
        family: "chromium",
        label: "Brave",
        mac_root: Some("BraveSoftware/Brave-Browser"),
        win_root: Some("BraveSoftware/Brave-Browser/User Data"),
        linux_root: Some("BraveSoftware/Brave-Browser"),
    },
    ChromiumBrowserDef {
        family: "comet",
        label: "Comet",
        mac_root: Some("Comet"),
        win_root: Some("Comet/User Data"),
        linux_root: None,
    },
    ChromiumBrowserDef {
        family: "helium",
        label: "Helium",
        mac_root: Some("net.imput.helium"),
        win_root: None,
        linux_root: None,
    },
];

#[tauri::command]
pub fn browser_detect_installed_browsers() -> Vec<DetectedBrowserInfo> {
    detect_installed_browsers()
}

fn detect_installed_browsers() -> Vec<DetectedBrowserInfo> {
    let mut detected = Vec::new();
    for browser in CHROMIUM_BROWSERS {
        let Some(root) = browser_root_path(browser) else {
            continue;
        };
        let profiles = discover_chromium_profiles(&root);
        let selected_profile = profiles
            .iter()
            .find(|profile| {
                let profile_dir = root.join(&profile.directory);
                resolve_chromium_cookies_path(&profile_dir).is_some()
            })
            .map(|profile| profile.directory.clone());
        if let Some(selected_profile) = selected_profile {
            detected.push(DetectedBrowserInfo {
                family: browser.family.to_string(),
                label: browser.label.to_string(),
                profiles,
                selected_profile,
            });
        }
    }
    if let Some(firefox) = detect_firefox() {
        detected.push(firefox);
    }
    if let Some(safari) = detect_safari() {
        detected.push(safari);
    }
    detected
}

fn browser_root_path(def: &ChromiumBrowserDef) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return def.mac_root.map(|root| {
            home_dir()
                .join("Library")
                .join("Application Support")
                .join_path_segments(root)
        });
    }
    if cfg!(target_os = "windows") {
        return def
            .win_root
            .and_then(|root| env_path("LOCALAPPDATA").map(|base| base.join_path_segments(root)));
    }
    def.linux_root.map(|root| config_home().join(root))
}

fn discover_chromium_profiles(browser_root: &Path) -> Vec<BrowserProfile> {
    let local_state_path = browser_root.join("Local State");
    let Ok(raw) = fs::read_to_string(local_state_path) else {
        return default_profile();
    };
    let Ok(local_state) = serde_json::from_str::<Value>(&raw) else {
        return default_profile();
    };
    let Some(info_cache) = local_state
        .get("profile")
        .and_then(|profile| profile.get("info_cache"))
        .and_then(Value::as_object)
    else {
        return default_profile();
    };
    let mut profiles = Vec::new();
    for (directory, info) in info_cache {
        if !is_safe_browser_profile_directory(directory) {
            continue;
        }
        let name = info
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(directory)
            .to_string();
        profiles.push(BrowserProfile {
            name,
            directory: directory.to_string(),
        });
    }
    if profiles.is_empty() {
        return default_profile();
    }
    profiles.sort_by(|left, right| {
        profile_directory_rank(&left.directory).cmp(&profile_directory_rank(&right.directory))
    });
    profiles
}

fn default_profile() -> Vec<BrowserProfile> {
    vec![BrowserProfile {
        name: "Default".to_string(),
        directory: "Default".to_string(),
    }]
}

fn profile_directory_rank(directory: &str) -> (u8, String) {
    if directory == "Default" {
        return (0, directory.to_string());
    }
    if directory.starts_with("Profile ") {
        return (1, directory.to_string());
    }
    (2, directory.to_string())
}

fn resolve_chromium_cookies_path(profile_dir: &Path) -> Option<PathBuf> {
    let network_path = profile_dir.join("Network").join("Cookies");
    if network_path.exists() {
        return Some(network_path);
    }
    let legacy_path = profile_dir.join("Cookies");
    if legacy_path.exists() {
        return Some(legacy_path);
    }
    None
}

fn is_safe_browser_profile_directory(directory: &str) -> bool {
    !directory.is_empty()
        && directory != "."
        && !directory.contains('\0')
        && !directory.contains('/')
        && !directory.contains('\\')
        && !directory.contains("..")
}

fn firefox_profiles_root() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return Some(
            home_dir()
                .join("Library")
                .join("Application Support")
                .join("Firefox")
                .join("Profiles"),
        );
    }
    if cfg!(target_os = "windows") {
        return env_path("APPDATA")
            .map(|base| base.join("Mozilla").join("Firefox").join("Profiles"));
    }
    Some(home_dir().join(".mozilla").join("firefox"))
}

fn detect_firefox() -> Option<DetectedBrowserInfo> {
    let profiles_root = firefox_profiles_root()?;
    let profiles = discover_firefox_profiles(&profiles_root);
    let selected_profile = profiles
        .iter()
        .find(|profile| {
            profiles_root
                .join(&profile.directory)
                .join("cookies.sqlite")
                .exists()
        })
        .map(|profile| profile.directory.clone());
    if let Some(selected_profile) = selected_profile {
        return Some(DetectedBrowserInfo {
            family: "firefox".to_string(),
            label: "Firefox".to_string(),
            profiles,
            selected_profile,
        });
    }
    None
}

fn discover_firefox_profiles(profiles_root: &Path) -> Vec<BrowserProfile> {
    let Ok(entries) = fs::read_dir(profiles_root) else {
        return Vec::new();
    };
    let mut directories: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|file_type| file_type.is_dir())
                .map(|_| entry.file_name().to_string_lossy().to_string())
        })
        .collect();
    directories.sort_by(|left, right| firefox_profile_rank(left).cmp(&firefox_profile_rank(right)));
    directories
        .into_iter()
        .map(|directory| BrowserProfile {
            name: firefox_profile_name(&directory),
            directory,
        })
        .collect()
}

fn firefox_profile_rank(directory: &str) -> (u8, String) {
    if directory.contains("default-release") {
        return (0, directory.to_string());
    }
    if directory.contains("default") {
        return (1, directory.to_string());
    }
    (2, directory.to_string())
}

fn firefox_profile_name(directory: &str) -> String {
    directory
        .split_once('.')
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| directory.to_string())
}

fn detect_safari() -> Option<DetectedBrowserInfo> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let home = home_dir();
    let candidates = [
        home.join("Library")
            .join("Cookies")
            .join("Cookies.binarycookies"),
        home.join("Library")
            .join("Containers")
            .join("com.apple.Safari")
            .join("Data")
            .join("Library")
            .join("Cookies")
            .join("Cookies.binarycookies"),
    ];
    if candidates.iter().any(|candidate| candidate.exists()) {
        return Some(DetectedBrowserInfo {
            family: "safari".to_string(),
            label: "Safari".to_string(),
            profiles: default_profile(),
            selected_profile: "Default".to_string(),
        });
    }
    None
}

fn home_dir() -> PathBuf {
    env_path("HOME")
        .or_else(|| env_path("USERPROFILE"))
        .unwrap_or_default()
}

fn config_home() -> PathBuf {
    env_path("XDG_CONFIG_HOME").unwrap_or_else(|| home_dir().join(".config"))
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

trait PathSegments {
    fn join_path_segments(self, path: &str) -> PathBuf;
}

impl PathSegments for PathBuf {
    fn join_path_segments(self, path: &str) -> PathBuf {
        path.split('/')
            .fold(self, |base, segment| base.join(segment))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_profile_directories() {
        assert!(is_safe_browser_profile_directory("Default"));
        assert!(!is_safe_browser_profile_directory(""));
        assert!(!is_safe_browser_profile_directory("."));
        assert!(!is_safe_browser_profile_directory("../Default"));
        assert!(!is_safe_browser_profile_directory("Profile/1"));
        assert!(!is_safe_browser_profile_directory("Profile\\1"));
    }

    #[test]
    fn derives_firefox_profile_display_name() {
        assert_eq!(
            firefox_profile_name("abc.default-release"),
            "default-release"
        );
        assert_eq!(firefox_profile_name("plain"), "plain");
    }
}
