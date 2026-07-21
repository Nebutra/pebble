use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State, Url};

pub const DEEP_LINK_EVENT: &str = "pebble:deep-link";
const MAX_DEEP_LINK_BYTES: usize = 8 * 1024;
const MAX_PENDING_DEEP_LINKS: usize = 128;

#[derive(Default)]
struct DeepLinkQueue {
    pending: Vec<String>,
    renderer_ready: bool,
}

impl DeepLinkQueue {
    fn push_pending(&mut self, urls: impl IntoIterator<Item = String>) {
        for url in urls {
            if self.pending.len() >= MAX_PENDING_DEEP_LINKS {
                self.pending.remove(0);
            }
            if !self.pending.contains(&url) {
                self.pending.push(url);
            }
        }
    }

    fn drain_and_mark_ready(&mut self, startup_urls: Vec<String>) -> Vec<String> {
        self.push_pending(startup_urls);
        let urls = dedupe_deep_links(self.pending.drain(..));
        self.renderer_ready = true;
        urls
    }
}

#[derive(Default)]
pub struct DeepLinkState {
    queue: Mutex<DeepLinkQueue>,
}

#[tauri::command]
pub fn deep_link_initial_urls(state: State<'_, DeepLinkState>) -> Vec<String> {
    let startup_urls = collect_pebble_deep_links(std::env::args());
    let Ok(mut queue) = state.queue.lock() else {
        return startup_urls;
    };
    // Why: draining and opening the ready barrier under one lock prevents an
    // activation from being queued after the final drain and stranded forever.
    queue.drain_and_mark_ready(startup_urls)
}

pub fn emit_deep_links(app: &AppHandle, urls: impl IntoIterator<Item = String>) {
    let urls = dedupe_deep_links(collect_pebble_deep_links(urls));
    let state = app.state::<DeepLinkState>();
    let Ok(mut queue) = state.queue.lock() else {
        return;
    };
    if !queue.renderer_ready {
        queue.push_pending(urls);
        return;
    }
    drop(queue);
    for url in urls {
        let _ = app.emit(DEEP_LINK_EVENT, url);
    }
}

fn dedupe_deep_links(urls: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    urls.into_iter()
        .filter(|url| seen.insert(url.clone()))
        .collect()
}

fn collect_pebble_deep_links(urls: impl IntoIterator<Item = String>) -> Vec<String> {
    urls.into_iter()
        .filter_map(|candidate| normalize_pebble_deep_link(&candidate))
        .collect()
}

fn normalize_pebble_deep_link(candidate: &str) -> Option<String> {
    let value = candidate.trim();
    if value.is_empty() || value.len() > MAX_DEEP_LINK_BYTES || value.chars().any(char::is_control)
    {
        return None;
    }
    let parsed = Url::parse(value).ok()?;
    if parsed.scheme() != "pebble"
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.host_str().is_none()
    {
        return None;
    }
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_well_formed_pebble_deep_links_from_startup_args() {
        let urls = collect_pebble_deep_links([
            "--flag".to_string(),
            "https://example.com".to_string(),
            "pebble://pair?code=abc".to_string(),
            "PEBBLE://settings/voice".to_string(),
        ]);
        assert_eq!(urls, ["pebble://pair?code=abc", "PEBBLE://settings/voice"]);
    }

    #[test]
    fn rejects_ambiguous_or_oversized_protocol_inputs() {
        let oversized = format!("pebble://pair?code={}", "a".repeat(MAX_DEEP_LINK_BYTES));
        for value in [
            "pebble:",
            "pebble:///settings/voice",
            "pebble://user@settings/voice",
            "pebble://settings:42/voice",
            "pebble://settings/voice\nhttps://example.com",
            oversized.as_str(),
        ] {
            assert_eq!(normalize_pebble_deep_link(value), None, "accepted {value}");
        }
    }

    #[test]
    fn deduplicates_replayed_protocol_activations_in_first_seen_order() {
        let urls = dedupe_deep_links([
            "pebble://pair?code=abc".to_string(),
            "pebble://pair?code=abc".to_string(),
            "pebble://pair?code=def".to_string(),
        ]);
        assert_eq!(urls, ["pebble://pair?code=abc", "pebble://pair?code=def"]);
    }

    #[test]
    fn cold_start_queue_is_bounded_and_deduplicated() {
        let mut queue = DeepLinkQueue::default();
        queue.push_pending(
            (0..(MAX_PENDING_DEEP_LINKS + 10))
                .map(|index| format!("pebble://tasks?sequence={index}")),
        );
        assert_eq!(queue.pending.len(), MAX_PENDING_DEEP_LINKS);
        assert_eq!(queue.pending.first().unwrap(), "pebble://tasks?sequence=10");
    }

    #[test]
    fn ready_transition_drains_cold_and_startup_urls_once() {
        let mut queue = DeepLinkQueue::default();
        queue.push_pending(["pebble://activity".to_string()]);
        let drained = queue.drain_and_mark_ready(vec![
            "pebble://tasks".to_string(),
            "pebble://activity".to_string(),
        ]);
        assert_eq!(drained, ["pebble://activity", "pebble://tasks"]);
        assert!(queue.renderer_ready);
        assert!(queue.pending.is_empty());
    }
}
