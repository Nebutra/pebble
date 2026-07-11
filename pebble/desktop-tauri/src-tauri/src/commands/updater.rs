use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};

const ATOM_FEED_URL: &str = "https://github.com/nebutra/pebble/releases.atom";
const CHANGELOG_JSON_URL: &str = "https://www.nebutra.com/pebble/whats-new/changelog.json";
const NUDGE_JSON_URL: &str = "https://www.nebutra.com/pebble/whats-new/nudge.json";
const RELEASES_DOWNLOAD_BASE: &str = "https://github.com/nebutra/pebble/releases/download";
const RELEASES_TAG_BASE: &str = "https://github.com/nebutra/pebble/releases/tag";
const FETCH_TIMEOUT_SECONDS: u64 = 5;
const MAX_MANIFEST_PROBE_CANDIDATES: usize = 4;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterCheckLatestInput {
    current_version: String,
    include_prerelease: Option<bool>,
    include_perf_prerelease: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterCheckLatestResult {
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    release_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_good_tag: Option<String>,
}

#[derive(Debug, Clone)]
struct ReleaseFeedTag {
    tag: String,
    version: String,
}

#[derive(Debug)]
struct ParsedVersion {
    core: [u64; 3],
    prerelease: Vec<String>,
}

#[tauri::command]
pub async fn updater_check_latest_release(
    input: UpdaterCheckLatestInput,
) -> Result<UpdaterCheckLatestResult, String> {
    let current_version = normalize_tag_to_version(&input.current_version);
    if parse_version(&current_version).is_none() {
        return Ok(UpdaterCheckLatestResult {
            state: "unavailable".to_string(),
            version: None,
            tag: None,
            release_url: None,
            message: Some("Current Pebble version is not a valid release version.".to_string()),
            last_good_tag: None,
        });
    }

    let include_prerelease = input
        .include_prerelease
        .unwrap_or_else(|| is_prerelease_version(&current_version));
    let release_filter = if input.include_perf_prerelease == Some(true) {
        Some("perf")
    } else {
        None
    };
    let tags = fetch_release_feed_tags().await?;
    let candidates = filter_release_candidates(tags, include_prerelease, release_filter);
    let Some(newest_newer_index) = candidates
        .iter()
        .position(|entry| compare_versions(&entry.version, &current_version) > 0)
    else {
        return Ok(UpdaterCheckLatestResult {
            state: "not-available".to_string(),
            version: None,
            tag: None,
            release_url: None,
            message: None,
            last_good_tag: None,
        });
    };

    let probe_candidates = candidates
        .iter()
        .skip(newest_newer_index)
        .take(MAX_MANIFEST_PROBE_CANDIDATES);
    let mut saw_missing_newer_manifest = false;
    for entry in probe_candidates {
        if !has_ready_platform_manifest(&entry.tag).await {
            if compare_versions(&entry.version, &current_version) > 0 {
                saw_missing_newer_manifest = true;
            }
            continue;
        }
        if compare_versions(&entry.version, &current_version) <= 0 {
            continue;
        }
        if saw_missing_newer_manifest {
            return Ok(UpdaterCheckLatestResult {
                state: "not-ready".to_string(),
                version: None,
                tag: None,
                release_url: None,
                message: Some("Latest release assets are still publishing.".to_string()),
                last_good_tag: Some(entry.tag.clone()),
            });
        }
        return Ok(available_result(entry));
    }

    Ok(UpdaterCheckLatestResult {
        state: "not-ready".to_string(),
        version: None,
        tag: None,
        release_url: None,
        message: Some("Latest release assets are still publishing.".to_string()),
        last_good_tag: None,
    })
}

#[tauri::command]
pub async fn updater_fetch_changelog_entries() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| format!("Could not create Pebble changelog client: {error}"))?;
    let response = client
        .get(CHANGELOG_JSON_URL)
        .send()
        .await
        .map_err(|error| format!("Could not fetch Pebble changelog: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Could not fetch Pebble changelog: status {}",
            response.status().as_u16()
        ));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Could not parse Pebble changelog: {error}"))
}

#[tauri::command]
pub async fn updater_fetch_nudge() -> Result<serde_json::Value, String> {
    fetch_bounded_json(NUDGE_JSON_URL, "nudge").await
}

async fn fetch_bounded_json(url: &str, label: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| format!("Could not create Pebble {label} client: {error}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Could not fetch Pebble {label}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Could not fetch Pebble {label}: status {}",
            response.status().as_u16()
        ));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Could not parse Pebble {label}: {error}"))
}

async fn fetch_release_feed_tags() -> Result<Vec<ReleaseFeedTag>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| format!("Could not create Pebble release client: {error}"))?;
    let response = client
        .get(ATOM_FEED_URL)
        .send()
        .await
        .map_err(|error| format!("Could not fetch Pebble release feed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Could not fetch Pebble release feed: status {}",
            response.status().as_u16()
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|error| format!("Could not read Pebble release feed: {error}"))?;
    let tag_regex = Regex::new(r#"href="https://github\.com/nebutra/pebble/releases/tag/([^"]+)""#)
        .map_err(|error| error.to_string())?;
    let mut tags = tag_regex
        .captures_iter(&body)
        .filter_map(|capture| {
            let tag = capture.get(1)?.as_str().to_string();
            let version = normalize_tag_to_version(&tag);
            is_valid_version(&version).then_some(ReleaseFeedTag { tag, version })
        })
        .collect::<Vec<_>>();
    tags.sort_by(|left, right| compare_versions(&right.version, &left.version).cmp(&0));
    Ok(tags)
}

async fn has_ready_platform_manifest(tag: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECONDS))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    let response = match client.get(release_manifest_url(tag)).send().await {
        Ok(response) => response,
        Err(_) => return false,
    };
    if !response.status().is_success() {
        return false;
    }
    match response.text().await {
        Ok(text) => manifest_asset_names(&text).next().is_some(),
        Err(_) => false,
    }
}

fn filter_release_candidates(
    tags: Vec<ReleaseFeedTag>,
    include_prerelease: bool,
    release_filter: Option<&str>,
) -> Vec<ReleaseFeedTag> {
    tags.into_iter()
        .filter(|entry| match release_filter {
            Some("perf") => is_perf_prerelease_tag(&entry.tag),
            _ if include_prerelease => !is_perf_prerelease_tag(&entry.tag),
            _ => !is_prerelease_version(&entry.version),
        })
        .collect()
}

fn available_result(entry: &ReleaseFeedTag) -> UpdaterCheckLatestResult {
    UpdaterCheckLatestResult {
        state: "available".to_string(),
        version: Some(entry.version.clone()),
        tag: Some(entry.tag.clone()),
        release_url: Some(release_tag_url(&entry.tag)),
        message: None,
        last_good_tag: None,
    }
}

fn manifest_asset_names(manifest_text: &str) -> impl Iterator<Item = String> + '_ {
    Regex::new(r#"(?m)^\s*(?:url|path):\s*["']?([^"'\r\n]+)"#)
        .ok()
        .into_iter()
        .flat_map(|regex| {
            regex
                .captures_iter(manifest_text)
                .filter_map(|capture| {
                    capture
                        .get(1)
                        .map(|match_| match_.as_str().trim().to_string())
                })
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
}

fn release_manifest_url(tag: &str) -> String {
    format!("{}/{}", release_download_url(tag), platform_manifest_name())
}

fn release_download_url(tag: &str) -> String {
    format!("{RELEASES_DOWNLOAD_BASE}/{}", url_encode_path_segment(tag))
}

fn release_tag_url(tag: &str) -> String {
    format!("{RELEASES_TAG_BASE}/{}", url_encode_path_segment(tag))
}

fn platform_manifest_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "latest-mac.yml"
    } else if cfg!(target_os = "linux") {
        "latest-linux.yml"
    } else {
        "latest.yml"
    }
}

fn url_encode_path_segment(value: &str) -> String {
    value.replace('/', "%2F")
}

fn normalize_tag_to_version(tag: &str) -> String {
    tag.trim().trim_start_matches(['v', 'V']).to_string()
}

fn is_valid_version(value: &str) -> bool {
    parse_version(value).is_some()
}

fn is_prerelease_version(value: &str) -> bool {
    parse_version(value)
        .map(|version| !version.prerelease.is_empty())
        .unwrap_or(false)
}

fn is_perf_prerelease_tag(tag: &str) -> bool {
    let version = normalize_tag_to_version(tag);
    let Some(parsed) = parse_version(&version) else {
        return false;
    };
    parsed.prerelease.len() == 3
        && parsed.prerelease[0] == "rc"
        && parsed.prerelease[1]
            .chars()
            .all(|character| character.is_ascii_digit())
        && parsed.prerelease[2] == "perf"
}

fn parse_version(value: &str) -> Option<ParsedVersion> {
    let regex =
        Regex::new(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$").ok()?;
    let captures = regex.captures(value.trim())?;
    Some(ParsedVersion {
        core: [
            captures.get(1)?.as_str().parse().ok()?,
            captures.get(2)?.as_str().parse().ok()?,
            captures.get(3)?.as_str().parse().ok()?,
        ],
        prerelease: captures
            .get(4)
            .map(|match_| {
                match_
                    .as_str()
                    .split('.')
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
    })
}

fn compare_versions(left: &str, right: &str) -> i8 {
    let Some(left_version) = parse_version(left) else {
        return 0;
    };
    let Some(right_version) = parse_version(right) else {
        return 0;
    };
    for index in 0..left_version.core.len() {
        if left_version.core[index] != right_version.core[index] {
            return if left_version.core[index] > right_version.core[index] {
                1
            } else {
                -1
            };
        }
    }
    compare_prerelease(&left_version.prerelease, &right_version.prerelease)
}

fn compare_prerelease(left: &[String], right: &[String]) -> i8 {
    if left.is_empty() && right.is_empty() {
        return 0;
    }
    if left.is_empty() {
        return 1;
    }
    if right.is_empty() {
        return -1;
    }
    for index in 0..left.len().max(right.len()) {
        match (left.get(index), right.get(index)) {
            (Some(left), Some(right)) => {
                let comparison = compare_prerelease_identifier(left, right);
                if comparison != 0 {
                    return comparison;
                }
            }
            (None, Some(_)) => return -1,
            (Some(_), None) => return 1,
            (None, None) => return 0,
        }
    }
    0
}

fn compare_prerelease_identifier(left: &str, right: &str) -> i8 {
    let left_numeric = left.chars().all(|character| character.is_ascii_digit());
    let right_numeric = right.chars().all(|character| character.is_ascii_digit());
    match (left_numeric, right_numeric) {
        (true, true) => {
            let left_number = left.parse::<u64>().unwrap_or(0);
            let right_number = right.parse::<u64>().unwrap_or(0);
            match left_number.cmp(&right_number) {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
                std::cmp::Ordering::Greater => 1,
            }
        }
        (true, false) => -1,
        (false, true) => 1,
        (false, false) => match left.cmp(right) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_prerelease_versions() {
        assert!(compare_versions("1.4.124-rc.9", "1.4.124-rc.8") > 0);
        assert!(compare_versions("1.4.124", "1.4.124-rc.9") > 0);
        assert!(compare_versions("1.4.125", "1.4.124") > 0);
    }

    #[test]
    fn filters_perf_tags_only_when_explicit() {
        assert!(is_perf_prerelease_tag("v1.4.121-rc.6.perf"));
        assert!(!is_perf_prerelease_tag("v1.4.121-rc.6.performance"));
    }
}
