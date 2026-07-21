use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;
use uuid::Uuid;

const MAX_PATTERNS: usize = 32;
const MAX_PATTERN_BYTES: usize = 2048;
const MAX_FULFILL_BODY_BYTES: usize = 1024 * 1024;
const MAX_CONTENT_TYPE_BYTES: usize = 256;
const MAX_INTERCEPTED: usize = 1000;
const MAX_PENDING_FULFILLMENTS: usize = 64;
const PENDING_FULFILLMENT_TTL: Duration = Duration::from_secs(30);
pub const FULFILLMENT_SCHEME: &str = "pebble-intercept";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeNavigationInterceptionRecord {
    id: String,
    url: String,
    method: &'static str,
    headers: HashMap<String, String>,
    resource_type: &'static str,
    timestamp_ms: u128,
}

#[derive(Clone, Default)]
struct TabInterceptionState {
    routes: Vec<NativeBrowserInterceptRoute>,
    intercepted: Vec<NativeNavigationInterceptionRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub(super) enum NativeBrowserInterceptRoute {
    Pause {
        pattern: String,
    },
    Abort {
        pattern: String,
    },
    Fulfill {
        pattern: String,
        body: String,
        status: u16,
        content_type: String,
    },
}

#[derive(Clone, Debug)]
// Why: fulfillment is consumed only by WebView2; other targets retain the
// validated route so renderer/runtime behavior remains cross-platform.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(super) enum NativeBrowserInterceptDecision {
    Pause,
    Abort,
    Fulfill {
        body: String,
        status: u16,
        content_type: String,
    },
}

#[derive(Clone, Debug)]
struct PendingTopLevelFulfillment {
    webview_label: String,
    body: Vec<u8>,
    status: u16,
    content_type: String,
    created_at: SystemTime,
}

pub enum NativeTopLevelNavigationDecision {
    Allow,
    Block,
    Fulfill(String),
}

#[derive(Clone, Default)]
pub struct NativeBrowserNavigationInterceptionState(
    Arc<Mutex<HashMap<String, TabInterceptionState>>>,
    Arc<Mutex<HashMap<String, PendingTopLevelFulfillment>>>,
    Arc<Mutex<HashMap<String, String>>>,
);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationInterceptionEnableInput {
    browser_tab_id: String,
    routes: Vec<NativeBrowserInterceptRoute>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationInterceptionTabInput {
    browser_tab_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationInterceptionEnableResult {
    enabled: bool,
    patterns: Vec<String>,
    routes: Vec<NativeBrowserInterceptRoute>,
    scope: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationInterceptionListResult {
    requests: Vec<NativeNavigationInterceptionRecord>,
    paused_requests: Vec<super::browser_request_control::PausedBrowserRequest>,
    patterns: Vec<String>,
    routes: Vec<NativeBrowserInterceptRoute>,
    scope: &'static str,
}

#[tauri::command]
pub fn browser_navigation_interception_enable(
    state: State<'_, NativeBrowserNavigationInterceptionState>,
    request_control: State<'_, super::browser_request_control::NativeBrowserRequestControlState>,
    input: BrowserNavigationInterceptionEnableInput,
) -> Result<BrowserNavigationInterceptionEnableResult, String> {
    let tab_id = validate_tab_id(&input.browser_tab_id)?;
    let routes = validate_routes(input.routes)?;
    // Why: replacing Fetch patterns cancels requests paused under the prior generation.
    request_control.cancel_tab(&tab_id);
    let patterns = routes
        .iter()
        .map(|route| route_pattern(route).to_owned())
        .collect();
    let mut tabs = state
        .0
        .lock()
        .map_err(|_| "browser interception state poisoned")?;
    tabs.insert(
        tab_id,
        TabInterceptionState {
            routes: routes.clone(),
            intercepted: Vec::new(),
        },
    );
    Ok(BrowserNavigationInterceptionEnableResult {
        enabled: true,
        patterns,
        routes,
        scope: interception_scope(),
    })
}

#[tauri::command]
pub fn browser_navigation_interception_disable(
    state: State<'_, NativeBrowserNavigationInterceptionState>,
    request_control: State<'_, super::browser_request_control::NativeBrowserRequestControlState>,
    input: BrowserNavigationInterceptionTabInput,
) -> Result<bool, String> {
    let tab_id = validate_tab_id(&input.browser_tab_id)?;
    let removed = state
        .0
        .lock()
        .map_err(|_| "browser interception state poisoned")?
        .remove(&tab_id)
        .is_some();
    // Why: disabling interception must release WebView2 deferrals immediately.
    request_control.cancel_tab(&tab_id);
    Ok(removed)
}

#[tauri::command]
pub fn browser_navigation_interception_list(
    state: State<'_, NativeBrowserNavigationInterceptionState>,
    request_control: State<'_, super::browser_request_control::NativeBrowserRequestControlState>,
    input: BrowserNavigationInterceptionTabInput,
) -> Result<BrowserNavigationInterceptionListResult, String> {
    let tab_id = validate_tab_id(&input.browser_tab_id)?;
    let tabs = state
        .0
        .lock()
        .map_err(|_| "browser interception state poisoned")?;
    let paused_requests = request_control.list(&tab_id);
    Ok(BrowserNavigationInterceptionListResult {
        patterns: tabs
            .get(&tab_id)
            .map(|entry| {
                entry
                    .routes
                    .iter()
                    .map(|route| route_pattern(route).to_owned())
                    .collect()
            })
            .unwrap_or_default(),
        routes: tabs
            .get(&tab_id)
            .map(|entry| entry.routes.clone())
            .unwrap_or_default(),
        requests: tabs
            .get(&tab_id)
            .map(|entry| entry.intercepted.clone())
            .unwrap_or_default(),
        paused_requests,
        scope: interception_scope(),
    })
}

impl NativeBrowserNavigationInterceptionState {
    pub fn register_webview(&self, webview_label: &str, browser_tab_id: &str) {
        if let Ok(mut bindings) = self.2.lock() {
            // Why: child WebViews are recreated on navigation; cap stale generation labels.
            bindings.retain(|_, tab_id| tab_id != browser_tab_id);
            if bindings.len() >= 512 {
                if let Some(stale_label) = bindings.keys().next().cloned() {
                    bindings.remove(&stale_label);
                }
            }
            bindings.insert(webview_label.to_string(), browser_tab_id.to_string());
        }
    }

    pub fn tab_for_webview(&self, webview_label: &str) -> Option<String> {
        self.2.lock().ok()?.get(webview_label).cloned()
    }

    #[cfg(test)]
    pub fn should_block(&self, browser_tab_id: &str, url: &str) -> bool {
        matches!(
            self.intercept_resource(browser_tab_id, url, "GET", "document", true),
            Some(NativeBrowserInterceptDecision::Abort)
        )
    }

    #[cfg(test)]
    pub fn prepare_top_level_fulfillment(
        &self,
        browser_tab_id: &str,
        webview_label: &str,
        url: &str,
    ) -> Option<String> {
        match self.decide_top_level_navigation(browser_tab_id, webview_label, url) {
            NativeTopLevelNavigationDecision::Fulfill(url) => Some(url),
            NativeTopLevelNavigationDecision::Allow | NativeTopLevelNavigationDecision::Block => {
                None
            }
        }
    }

    pub fn decide_top_level_navigation(
        &self,
        browser_tab_id: &str,
        webview_label: &str,
        url: &str,
    ) -> NativeTopLevelNavigationDecision {
        let Some(decision) = self.intercept_resource(browser_tab_id, url, "GET", "document", true)
        else {
            return NativeTopLevelNavigationDecision::Allow;
        };
        let NativeBrowserInterceptDecision::Fulfill {
            body,
            status,
            content_type,
        } = decision
        else {
            return if matches!(decision, NativeBrowserInterceptDecision::Pause) {
                NativeTopLevelNavigationDecision::Allow
            } else {
                NativeTopLevelNavigationDecision::Block
            };
        };
        let token = Uuid::new_v4().to_string();
        let Ok(mut pending) = self.1.lock() else {
            return NativeTopLevelNavigationDecision::Block;
        };
        prune_pending_fulfillments(&mut pending);
        if pending.len() >= MAX_PENDING_FULFILLMENTS {
            if let Some(oldest) = pending
                .iter()
                .min_by_key(|(_, response)| response.created_at)
                .map(|(token, _)| token.clone())
            {
                pending.remove(&oldest);
            }
        }
        pending.insert(
            token.clone(),
            PendingTopLevelFulfillment {
                webview_label: webview_label.to_string(),
                body: body.into_bytes(),
                status,
                content_type,
                created_at: SystemTime::now(),
            },
        );
        NativeTopLevelNavigationDecision::Fulfill(format!(
            "{FULFILLMENT_SCHEME}://localhost/{token}"
        ))
    }

    pub fn serve_top_level_fulfillment(
        &self,
        webview_label: &str,
        path: &str,
    ) -> tauri::http::Response<Vec<u8>> {
        let token = path.trim_matches('/');
        let response = self.1.lock().ok().and_then(|mut pending| {
            prune_pending_fulfillments(&mut pending);
            let matches_label = pending
                .get(token)
                .is_some_and(|entry| entry.webview_label == webview_label);
            matches_label.then(|| pending.remove(token)).flatten()
        });
        let Some(response) = response else {
            return tauri::http::Response::builder()
                .status(404)
                .header("content-type", "text/plain; charset=utf-8")
                .header("cache-control", "no-store")
                .body(b"Fulfillment response is unavailable.".to_vec())
                .expect("static fulfillment error response is valid");
        };
        tauri::http::Response::builder()
            .status(response.status)
            .header("content-type", response.content_type)
            .header("content-length", response.body.len().to_string())
            .header("cache-control", "no-store")
            .body(response.body)
            .expect("validated fulfillment response is valid")
    }

    pub(super) fn intercept_resource(
        &self,
        browser_tab_id: &str,
        url: &str,
        method: &str,
        resource_type: &'static str,
        _top_level: bool,
    ) -> Option<NativeBrowserInterceptDecision> {
        let Ok(mut tabs) = self.0.lock() else {
            return None;
        };
        let Some(entry) = tabs.get_mut(browser_tab_id) else {
            return None;
        };
        let route = entry
            .routes
            .iter()
            .find(|route| glob_matches(route_pattern(route), url))?;
        let decision = match route {
            NativeBrowserInterceptRoute::Pause { .. } => NativeBrowserInterceptDecision::Pause,
            NativeBrowserInterceptRoute::Abort { .. } => NativeBrowserInterceptDecision::Abort,
            NativeBrowserInterceptRoute::Fulfill {
                body,
                status,
                content_type,
                ..
            } => NativeBrowserInterceptDecision::Fulfill {
                body: body.clone(),
                status: *status,
                content_type: content_type.clone(),
            },
        };
        if !matches!(decision, NativeBrowserInterceptDecision::Pause) {
            entry.intercepted.push(NativeNavigationInterceptionRecord {
                id: Uuid::new_v4().to_string(),
                url: url.to_string(),
                method: bounded_method(method),
                headers: HashMap::new(),
                resource_type,
                timestamp_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_millis())
                    .unwrap_or_default(),
            });
        }
        if entry.intercepted.len() > MAX_INTERCEPTED {
            entry
                .intercepted
                .drain(..entry.intercepted.len() - MAX_INTERCEPTED);
        }
        Some(decision)
    }
}

fn bounded_method(method: &str) -> &'static str {
    match method {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "HEAD" => "HEAD",
        "OPTIONS" => "OPTIONS",
        _ => "OTHER",
    }
}

fn interception_scope() -> &'static str {
    if cfg!(target_os = "windows") {
        "native-top-level-and-windows-request-control"
    } else if cfg!(any(target_os = "macos", target_os = "linux")) {
        "native-top-level-and-webkit-main-frame-fetch-async-xhr-request-control"
    } else {
        "native-top-level"
    }
}

fn prune_pending_fulfillments(pending: &mut HashMap<String, PendingTopLevelFulfillment>) {
    let now = SystemTime::now();
    pending.retain(|_, response| {
        now.duration_since(response.created_at)
            .map(|age| age <= PENDING_FULFILLMENT_TTL)
            .unwrap_or(false)
    });
}

fn validate_tab_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err("browser tab id is invalid".to_string());
    }
    Ok(value.to_string())
}

fn validate_routes(
    routes: Vec<NativeBrowserInterceptRoute>,
) -> Result<Vec<NativeBrowserInterceptRoute>, String> {
    if routes.is_empty() || routes.len() > MAX_PATTERNS {
        return Err("browser interception requires 1 to 32 routes".to_string());
    }
    routes
        .into_iter()
        .map(|route| {
            let pattern = route_pattern(&route).trim().to_string();
            if pattern.is_empty()
                || pattern.len() > MAX_PATTERN_BYTES
                || pattern.chars().any(char::is_control)
            {
                return Err("browser interception pattern is invalid".to_string());
            }
            match route {
                NativeBrowserInterceptRoute::Pause { .. } => {
                    Ok(NativeBrowserInterceptRoute::Pause { pattern })
                }
                NativeBrowserInterceptRoute::Abort { .. } => {
                    Ok(NativeBrowserInterceptRoute::Abort { pattern })
                }
                NativeBrowserInterceptRoute::Fulfill {
                    body,
                    status,
                    content_type,
                    ..
                } => {
                    if body.len() > MAX_FULFILL_BODY_BYTES || !(100..=599).contains(&status) {
                        return Err("browser fulfillment response is invalid".to_string());
                    }
                    let content_type = content_type.trim();
                    if content_type.is_empty()
                        || content_type.len() > MAX_CONTENT_TYPE_BYTES
                        || content_type.chars().any(char::is_control)
                    {
                        return Err("browser fulfillment content type is invalid".to_string());
                    }
                    Ok(NativeBrowserInterceptRoute::Fulfill {
                        pattern,
                        body,
                        status,
                        content_type: content_type.to_string(),
                    })
                }
            }
        })
        .collect()
}

fn route_pattern(route: &NativeBrowserInterceptRoute) -> &str {
    match route {
        NativeBrowserInterceptRoute::Pause { pattern }
        | NativeBrowserInterceptRoute::Abort { pattern }
        | NativeBrowserInterceptRoute::Fulfill { pattern, .. } => pattern,
    }
}

fn glob_matches(pattern: &str, value: &str) -> bool {
    glob_matches_bytes(pattern.as_bytes(), value.as_bytes(), 0, 0)
}

fn glob_matches_bytes(
    pattern: &[u8],
    value: &[u8],
    pattern_index: usize,
    value_index: usize,
) -> bool {
    if pattern_index == pattern.len() {
        return value_index == value.len();
    }
    if pattern[pattern_index] == b'*' {
        let recursive = pattern.get(pattern_index + 1) == Some(&b'*');
        let next_pattern = pattern_index + if recursive { 2 } else { 1 };
        if glob_matches_bytes(pattern, value, next_pattern, value_index) {
            return true;
        }
        return value_index < value.len()
            && (recursive || value[value_index] != b'/')
            && glob_matches_bytes(pattern, value, pattern_index, value_index + 1);
    }
    value_index < value.len()
        && pattern[pattern_index] == value[value_index]
        && glob_matches_bytes(pattern, value, pattern_index + 1, value_index + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_double_star_and_single_segment_patterns() {
        assert!(glob_matches("**/blocked", "https://example.com/a/blocked"));
        assert!(glob_matches(
            "https://example.com/*",
            "https://example.com/a"
        ));
        assert!(!glob_matches(
            "https://example.com/*",
            "https://example.com/a/b"
        ));
    }

    #[test]
    fn binds_document_request_control_to_the_creating_webview() {
        let state = NativeBrowserNavigationInterceptionState::default();
        state.register_webview("browser-tab-1-1", "tab-1");
        assert_eq!(
            state.tab_for_webview("browser-tab-1-1").as_deref(),
            Some("tab-1")
        );
        assert_eq!(state.tab_for_webview("browser-tab-2-1"), None);
    }

    #[test]
    fn records_and_bounds_native_top_level_navigation() {
        let state = NativeBrowserNavigationInterceptionState::default();
        state.0.lock().unwrap().insert(
            "tab-1".to_string(),
            TabInterceptionState {
                routes: vec![NativeBrowserInterceptRoute::Abort {
                    pattern: "https://example.com/**".to_string(),
                }],
                intercepted: Vec::new(),
            },
        );
        assert!(state.should_block("tab-1", "https://example.com/blocked"));
        assert!(!state.should_block("tab-1", "https://other.test/allowed"));
        assert_eq!(state.0.lock().unwrap()["tab-1"].intercepted.len(), 1);
    }

    #[test]
    fn records_native_subresource_method_and_type() {
        let state = NativeBrowserNavigationInterceptionState::default();
        state.0.lock().unwrap().insert(
            "tab-1".to_string(),
            TabInterceptionState {
                routes: vec![NativeBrowserInterceptRoute::Abort {
                    pattern: "https://example.com/**".to_string(),
                }],
                intercepted: Vec::new(),
            },
        );
        assert!(matches!(
            state.intercept_resource(
                "tab-1",
                "https://example.com/assets/app.js",
                "POST",
                "script",
                false
            ),
            Some(NativeBrowserInterceptDecision::Abort)
        ));
        let tabs = state.0.lock().unwrap();
        let record = &tabs["tab-1"].intercepted[0];
        assert_eq!(record.method, "POST");
        assert_eq!(record.resource_type, "script");
    }

    #[test]
    fn returns_bounded_fulfillment_for_matching_subresources() {
        let routes = validate_routes(vec![NativeBrowserInterceptRoute::Fulfill {
            pattern: "https://example.com/api/**".to_string(),
            body: "{\"ok\":true}".to_string(),
            status: 201,
            content_type: "application/json".to_string(),
        }])
        .unwrap();
        let state = NativeBrowserNavigationInterceptionState::default();
        state.0.lock().unwrap().insert(
            "tab-1".to_string(),
            TabInterceptionState {
                routes,
                intercepted: Vec::new(),
            },
        );

        let decision = state.intercept_resource(
            "tab-1",
            "https://example.com/api/data",
            "GET",
            "fetch",
            false,
        );
        assert!(matches!(
            decision,
            Some(NativeBrowserInterceptDecision::Fulfill { status: 201, .. })
        ));
        let fulfillment = state
            .prepare_top_level_fulfillment("tab-1", "browser-tab-1", "https://example.com/api/data")
            .unwrap();
        assert!(fulfillment.starts_with("pebble-intercept://localhost/"));
        let token_path = fulfillment
            .strip_prefix("pebble-intercept://localhost")
            .unwrap();
        assert_eq!(
            state
                .serve_top_level_fulfillment("browser-other", token_path)
                .status(),
            404
        );
        let response = state.serve_top_level_fulfillment("browser-tab-1", token_path);
        assert_eq!(response.status(), 201);
        assert_eq!(response.body(), b"{\"ok\":true}");
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(
            state
                .serve_top_level_fulfillment("browser-tab-1", token_path)
                .status(),
            404
        );
    }

    #[test]
    fn rejects_oversized_fulfillment_bodies() {
        assert!(validate_routes(vec![NativeBrowserInterceptRoute::Fulfill {
            pattern: "**/*".to_string(),
            body: "x".repeat(MAX_FULFILL_BODY_BYTES + 1),
            status: 200,
            content_type: "text/plain".to_string(),
        }])
        .is_err());
    }
}
