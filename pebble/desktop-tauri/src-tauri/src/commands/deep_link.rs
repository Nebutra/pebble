use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use tauri::{AppHandle, Emitter, Manager, State};

pub const DEEP_LINK_EVENT: &str = "pebble:deep-link";
const PEBBLE_URL_PREFIX: &str = "pebble://";

#[derive(Default)]
pub struct DeepLinkState {
    pending: Mutex<Vec<String>>,
    renderer_ready: AtomicBool,
}

#[tauri::command]
pub fn deep_link_initial_urls(state: State<'_, DeepLinkState>) -> Vec<String> {
    let mut urls = collect_pebble_deep_links(std::env::args());
    if let Ok(mut pending) = state.pending.lock() {
        urls.extend(pending.drain(..));
    }
    state.renderer_ready.store(true, Ordering::Release);
    dedupe_deep_links(urls)
}

pub fn emit_deep_links(app: &AppHandle, urls: impl IntoIterator<Item = String>) {
    let urls = dedupe_deep_links(collect_pebble_deep_links(urls));
    let state = app.state::<DeepLinkState>();
    if !state.renderer_ready.load(Ordering::Acquire) {
        if let Ok(mut pending) = state.pending.lock() {
            pending.extend(urls.iter().cloned());
        }
    }
    for url in urls {
        let _ = app.emit(DEEP_LINK_EVENT, url);
    }
}

fn dedupe_deep_links(urls: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    urls.into_iter()
        .filter(|url| seen.insert(url.clone()))
        .collect()
}

fn collect_pebble_deep_links(urls: impl IntoIterator<Item = String>) -> Vec<String> {
    urls.into_iter()
        .filter(|url| is_pebble_deep_link(url))
        .collect()
}

fn is_pebble_deep_link(url: &str) -> bool {
    url.trim()
        .to_ascii_lowercase()
        .starts_with(PEBBLE_URL_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_pebble_deep_links_from_startup_args() {
        let urls = collect_pebble_deep_links([
            "--flag".to_string(),
            "https://example.com".to_string(),
            "pebble://pair?code=abc".to_string(),
            "PEBBLE://pair#def".to_string(),
        ]);
        assert_eq!(urls, ["pebble://pair?code=abc", "PEBBLE://pair#def"]);
    }

    #[test]
    fn deduplicates_replayed_protocol_activations() {
        let urls = dedupe_deep_links(vec![
            "pebble://pair?code=abc".to_string(),
            "pebble://pair?code=abc".to_string(),
            "pebble://pair?code=def".to_string(),
        ]);
        assert_eq!(urls, ["pebble://pair?code=abc", "pebble://pair?code=def"]);
    }
}
