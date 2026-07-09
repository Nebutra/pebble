use tauri::{AppHandle, Emitter};

pub const DEEP_LINK_EVENT: &str = "pebble:deep-link";
const PEBBLE_URL_PREFIX: &str = "pebble://";

#[tauri::command]
pub fn deep_link_initial_urls() -> Vec<String> {
    collect_pebble_deep_links(std::env::args())
}

pub fn emit_deep_links(app: &AppHandle, urls: impl IntoIterator<Item = String>) {
    for url in collect_pebble_deep_links(urls) {
        let _ = app.emit(DEEP_LINK_EVENT, url);
    }
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
}
