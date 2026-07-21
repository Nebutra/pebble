use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Runtime, State, Url, Webview};
use uuid::Uuid;

// Why: both WebView2 deferrals and WebKit document request control auto-continue.
pub const REQUEST_DECISION_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PENDING_REQUESTS: usize = 256;
const MAX_REQUEST_RECORDS: usize = 1000;
const MAX_RESPONSE_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESPONSE_HEADERS: usize = 128;
const MAX_HEADER_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PausedBrowserRequest {
    pub id: String,
    pub request_id: String,
    pub browser_tab_id: String,
    pub frame_id: String,
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub resource_type: String,
    pub state: &'static str,
    pub timestamp_ms: u128,
}

#[derive(Clone, Debug)]
pub enum BrowserRequestDecision {
    Continue,
    Fulfill {
        body: Vec<u8>,
        status: u16,
        headers: HashMap<String, String>,
    },
    Fail {
        reason: String,
    },
}

struct PendingBrowserRequest {
    tab_id: String,
    document_request: bool,
    sender: Sender<BrowserRequestDecision>,
}

struct BrowserRequestPause {
    browser_tab_id: String,
    frame_id: String,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    resource_type: String,
}

#[derive(Default)]
struct BrowserRequestControlInner {
    pending: HashMap<String, PendingBrowserRequest>,
    records: HashMap<String, PausedBrowserRequest>,
}

#[derive(Clone, Default)]
pub struct NativeBrowserRequestControlState(Arc<Mutex<BrowserRequestControlInner>>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRequestDecisionInput {
    browser_tab_id: String,
    request_id: String,
    decision: BrowserRequestDecisionInputKind,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDocumentRequestPauseInput {
    url: String,
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    resource_type: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum BrowserDocumentRequestDecision {
    Continue,
    Fulfill {
        body: String,
        status: u16,
        headers: HashMap<String, String>,
    },
    Fail {
        reason: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum BrowserRequestDecisionInputKind {
    Continue,
    Fulfill {
        #[serde(default)]
        body: String,
        #[serde(default = "default_status")]
        status: u16,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    Fail {
        #[serde(default = "default_failure_reason")]
        reason: String,
    },
}

fn default_status() -> u16 {
    200
}

fn default_failure_reason() -> String {
    "Failed by Pebble".to_string()
}

#[tauri::command]
pub fn browser_request_control_resolve(
    state: State<'_, NativeBrowserRequestControlState>,
    input: BrowserRequestDecisionInput,
) -> Result<bool, String> {
    let decision = validate_decision(input.decision)?;
    state.resolve(&input.browser_tab_id, &input.request_id, decision)
}

#[tauri::command]
pub async fn browser_document_request_pause<R: Runtime>(
    webview: Webview<R>,
    interception: State<
        '_,
        super::browser_navigation_interception::NativeBrowserNavigationInterceptionState,
    >,
    state: State<'_, NativeBrowserRequestControlState>,
    input: BrowserDocumentRequestPauseInput,
) -> Result<BrowserDocumentRequestDecision, String> {
    if cfg!(target_os = "windows") {
        return Err("document request control is owned by WebView2 on Windows".to_string());
    }
    let browser_tab_id = interception
        .tab_for_webview(webview.label())
        .ok_or_else(|| "browser WebView is not registered for request control".to_string())?;
    let (url, method, headers, resource_type) = validate_document_pause(input)?;
    let is_pause = matches!(
        interception.intercept_resource(
            &browser_tab_id,
            &url,
            &method,
            document_resource_type(&resource_type),
            false,
        ),
        Some(super::browser_navigation_interception::NativeBrowserInterceptDecision::Pause)
    );
    if !is_pause {
        return Ok(BrowserDocumentRequestDecision::Continue);
    }
    let (record, receiver) = state.pause_document(
        &browser_tab_id,
        format!("{browser_tab_id}:main-frame"),
        url,
        method,
        headers,
        resource_type,
    )?;
    let request_id = record.request_id.clone();
    let timeout_state = state.inner().clone();
    let decision = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(REQUEST_DECISION_TIMEOUT)
    })
    .await
    .map_err(|error| format!("browser request decision task failed: {error}"))?;
    match decision {
        Ok(BrowserRequestDecision::Continue) => Ok(BrowserDocumentRequestDecision::Continue),
        Ok(BrowserRequestDecision::Fulfill {
            body,
            status,
            headers,
        }) => {
            let body = String::from_utf8(body)
                .map_err(|_| "document request fulfillment body must be UTF-8".to_string())?;
            Ok(BrowserDocumentRequestDecision::Fulfill {
                body,
                status,
                headers,
            })
        }
        Ok(BrowserRequestDecision::Fail { reason }) => {
            Ok(BrowserDocumentRequestDecision::Fail { reason })
        }
        Err(_) => {
            timeout_state.finish_timeout(&request_id);
            Ok(BrowserDocumentRequestDecision::Continue)
        }
    }
}

fn validate_document_pause(
    input: BrowserDocumentRequestPauseInput,
) -> Result<(String, String, HashMap<String, String>, String), String> {
    let url = Url::parse(input.url.trim())
        .map_err(|_| "browser document request URL is invalid".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || input.url.len() > 8192 {
        return Err("browser document request URL is invalid".to_string());
    }
    let method = input.method.trim().to_ascii_uppercase();
    if method.is_empty()
        || method.len() > 16
        || !method
            .chars()
            .all(|character| character.is_ascii_alphabetic())
    {
        return Err("browser document request method is invalid".to_string());
    }
    validate_headers(&input.headers)?;
    if !matches!(input.resource_type.as_str(), "fetch" | "xhr") {
        return Err("browser document request resource type is invalid".to_string());
    }
    Ok((url.to_string(), method, input.headers, input.resource_type))
}

fn document_resource_type(resource_type: &str) -> &'static str {
    if resource_type == "xhr" {
        "xhr"
    } else {
        "fetch"
    }
}

impl NativeBrowserRequestControlState {
    // Why: native pause is owned by WebView2; WebKit enters through pause_document.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn pause(
        &self,
        browser_tab_id: &str,
        frame_id: String,
        url: String,
        method: String,
        headers: HashMap<String, String>,
        resource_type: String,
    ) -> Result<(PausedBrowserRequest, Receiver<BrowserRequestDecision>), String> {
        self.pause_with_transport(
            BrowserRequestPause {
                browser_tab_id: browser_tab_id.to_string(),
                frame_id,
                url,
                method,
                headers,
                resource_type,
            },
            false,
        )
    }

    fn pause_document(
        &self,
        browser_tab_id: &str,
        frame_id: String,
        url: String,
        method: String,
        headers: HashMap<String, String>,
        resource_type: String,
    ) -> Result<(PausedBrowserRequest, Receiver<BrowserRequestDecision>), String> {
        self.pause_with_transport(
            BrowserRequestPause {
                browser_tab_id: browser_tab_id.to_string(),
                frame_id,
                url,
                method,
                headers,
                resource_type,
            },
            true,
        )
    }

    fn pause_with_transport(
        &self,
        request: BrowserRequestPause,
        document_request: bool,
    ) -> Result<(PausedBrowserRequest, Receiver<BrowserRequestDecision>), String> {
        let request_id = Uuid::new_v4().to_string();
        let record = PausedBrowserRequest {
            id: request_id.clone(),
            request_id: request_id.clone(),
            browser_tab_id: request.browser_tab_id.clone(),
            frame_id: request.frame_id,
            url: request.url,
            method: request.method,
            headers: request.headers,
            resource_type: request.resource_type,
            state: "paused",
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or_default(),
        };
        let (sender, receiver) = mpsc::channel();
        let mut inner = self
            .0
            .lock()
            .map_err(|_| "browser request control state poisoned")?;
        if inner.pending.len() >= MAX_PENDING_REQUESTS {
            return Err("browser request control pending limit reached".to_string());
        }
        inner.pending.insert(
            request_id.clone(),
            PendingBrowserRequest {
                tab_id: request.browser_tab_id,
                document_request,
                sender,
            },
        );
        inner.records.insert(request_id, record.clone());
        if inner.records.len() > MAX_REQUEST_RECORDS {
            if let Some(oldest) = inner
                .records
                .iter()
                .min_by_key(|(_, record)| record.timestamp_ms)
                .map(|(request_id, _)| request_id.clone())
            {
                inner.records.remove(&oldest);
            }
        }
        Ok((record, receiver))
    }

    pub fn list(&self, browser_tab_id: &str) -> Vec<PausedBrowserRequest> {
        self.0
            .lock()
            .map(|inner| {
                let mut records: Vec<_> = inner
                    .records
                    .values()
                    .filter(|record| record.browser_tab_id == browser_tab_id)
                    .cloned()
                    .collect();
                records.sort_by_key(|record| record.timestamp_ms);
                records
            })
            .unwrap_or_default()
    }

    pub fn resolve(
        &self,
        browser_tab_id: &str,
        request_id: &str,
        decision: BrowserRequestDecision,
    ) -> Result<bool, String> {
        let mut inner = self
            .0
            .lock()
            .map_err(|_| "browser request control state poisoned")?;
        let Some(pending) = inner.pending.get(request_id) else {
            return Err("browser request is no longer paused".to_string());
        };
        if pending.tab_id != browser_tab_id {
            return Err("browser request does not belong to this tab".to_string());
        }
        if pending.document_request {
            validate_document_decision(&decision)?;
        }
        let pending = inner
            .pending
            .remove(request_id)
            .expect("pending request exists");
        let state_name = decision_state(&decision);
        pending
            .sender
            .send(decision)
            .map_err(|_| "browser request is no longer paused".to_string())?;
        if let Some(record) = inner.records.get_mut(request_id) {
            record.state = state_name;
        }
        Ok(true)
    }

    pub fn finish_timeout(&self, request_id: &str) {
        if let Ok(mut inner) = self.0.lock() {
            inner.pending.remove(request_id);
            if let Some(record) = inner.records.get_mut(request_id) {
                record.state = "timedOut";
            }
        }
    }

    pub fn cancel_tab(&self, browser_tab_id: &str) {
        let Ok(mut inner) = self.0.lock() else { return };
        let request_ids: Vec<_> = inner
            .pending
            .iter()
            .filter(|(_, pending)| pending.tab_id == browser_tab_id)
            .map(|(request_id, _)| request_id.clone())
            .collect();
        for request_id in request_ids {
            if let Some(pending) = inner.pending.remove(&request_id) {
                let _ = pending.sender.send(BrowserRequestDecision::Continue);
            }
            if let Some(record) = inner.records.get_mut(&request_id) {
                record.state = "cancelled";
            }
        }
    }
}

fn validate_document_decision(decision: &BrowserRequestDecision) -> Result<(), String> {
    let BrowserRequestDecision::Fulfill { body, status, .. } = decision else {
        return Ok(());
    };
    if *status < 200 {
        return Err("WebKit document fulfillment status must be 200 to 599".to_string());
    }
    if matches!(status, 204 | 205 | 304) && !body.is_empty() {
        return Err(
            "WebKit document fulfillment status does not permit a response body".to_string(),
        );
    }
    Ok(())
}

fn validate_decision(
    input: BrowserRequestDecisionInputKind,
) -> Result<BrowserRequestDecision, String> {
    match input {
        BrowserRequestDecisionInputKind::Continue => Ok(BrowserRequestDecision::Continue),
        BrowserRequestDecisionInputKind::Fail { reason } => {
            let reason = reason.trim();
            if reason.is_empty() || reason.len() > 512 || reason.chars().any(char::is_control) {
                return Err("browser request failure reason is invalid".to_string());
            }
            Ok(BrowserRequestDecision::Fail {
                reason: reason.to_string(),
            })
        }
        BrowserRequestDecisionInputKind::Fulfill {
            body,
            status,
            headers,
        } => {
            if body.len() > MAX_RESPONSE_BODY_BYTES || !(100..=599).contains(&status) {
                return Err("browser request fulfillment is invalid".to_string());
            }
            validate_headers(&headers)?;
            Ok(BrowserRequestDecision::Fulfill {
                body: body.into_bytes(),
                status,
                headers,
            })
        }
    }
}

fn validate_headers(headers: &HashMap<String, String>) -> Result<(), String> {
    if headers.len() > MAX_RESPONSE_HEADERS {
        return Err("browser request fulfillment has too many headers".to_string());
    }
    let total = headers
        .iter()
        .map(|(name, value)| name.len() + value.len())
        .sum::<usize>();
    if total > MAX_HEADER_BYTES
        || headers.iter().any(|(name, value)| {
            name.is_empty()
                || name
                    .chars()
                    .any(|character| character.is_control() || character == ':')
                || value
                    .chars()
                    .any(|character| character == '\r' || character == '\n')
        })
    {
        return Err("browser request fulfillment headers are invalid".to_string());
    }
    Ok(())
}

fn decision_state(decision: &BrowserRequestDecision) -> &'static str {
    match decision {
        BrowserRequestDecision::Continue => "continued",
        BrowserRequestDecision::Fulfill { .. } => "fulfilled",
        BrowserRequestDecision::Fail { .. } => "failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pause(
        state: &NativeBrowserRequestControlState,
        tab_id: &str,
    ) -> (PausedBrowserRequest, Receiver<BrowserRequestDecision>) {
        state
            .pause(
                tab_id,
                format!("{tab_id}:webview"),
                "https://example.com/a".into(),
                "GET".into(),
                HashMap::new(),
                "fetch".into(),
            )
            .unwrap()
    }

    #[test]
    fn preserves_tab_frame_and_request_identity() {
        let state = NativeBrowserRequestControlState::default();
        let (record, _) = pause(&state, "tab-1");
        assert_eq!(record.id, record.request_id);
        assert_eq!(record.browser_tab_id, "tab-1");
        assert_eq!(record.frame_id, "tab-1:webview");
        assert_eq!(state.list("tab-1")[0].state, "paused");
    }

    #[test]
    fn validates_only_http_fetch_and_xhr_document_requests() {
        let valid = BrowserDocumentRequestPauseInput {
            url: "https://example.com/api?q=1".into(),
            method: "post".into(),
            headers: HashMap::from([("content-type".into(), "application/json".into())]),
            resource_type: "fetch".into(),
        };
        let (url, method, _, resource_type) = validate_document_pause(valid).unwrap();
        assert_eq!(url, "https://example.com/api?q=1");
        assert_eq!(method, "POST");
        assert_eq!(resource_type, "fetch");

        for (url, resource_type) in [
            ("file:///tmp/private", "fetch"),
            ("https://example.com", "script"),
        ] {
            assert!(validate_document_pause(BrowserDocumentRequestPauseInput {
                url: url.into(),
                method: "GET".into(),
                headers: HashMap::new(),
                resource_type: resource_type.into(),
            })
            .is_err());
        }
    }

    #[test]
    fn rejects_fetch_incompatible_document_fulfillments_before_resolution() {
        let state = NativeBrowserRequestControlState::default();
        let (record, _) = state
            .pause_document(
                "tab-1",
                "tab-1:main-frame".into(),
                "https://example.com/api".into(),
                "GET".into(),
                HashMap::new(),
                "fetch".into(),
            )
            .unwrap();
        assert!(state
            .resolve(
                "tab-1",
                &record.id,
                BrowserRequestDecision::Fulfill {
                    body: b"not allowed".to_vec(),
                    status: 204,
                    headers: HashMap::new(),
                },
            )
            .is_err());
        assert_eq!(state.list("tab-1")[0].state, "paused");
    }

    #[test]
    fn resolves_once_and_rejects_cross_tab_decisions() {
        let state = NativeBrowserRequestControlState::default();
        let (record, receiver) = pause(&state, "tab-1");
        assert!(state
            .resolve("tab-2", &record.id, BrowserRequestDecision::Continue)
            .is_err());
        assert!(state
            .resolve("tab-1", &record.id, BrowserRequestDecision::Continue)
            .unwrap());
        assert!(matches!(
            receiver.recv().unwrap(),
            BrowserRequestDecision::Continue
        ));
        assert!(state
            .resolve("tab-1", &record.id, BrowserRequestDecision::Continue)
            .is_err());
    }

    #[test]
    fn cancel_releases_only_the_target_tab() {
        let state = NativeBrowserRequestControlState::default();
        let (_, first) = pause(&state, "tab-1");
        let (_, second) = pause(&state, "tab-2");
        state.cancel_tab("tab-1");
        assert!(matches!(
            first.recv().unwrap(),
            BrowserRequestDecision::Continue
        ));
        assert!(second.try_recv().is_err());
    }

    #[test]
    fn timeout_removes_the_decision_channel_and_marks_the_request() {
        let state = NativeBrowserRequestControlState::default();
        let (record, _) = pause(&state, "tab-1");
        state.finish_timeout(&record.id);
        assert_eq!(state.list("tab-1")[0].state, "timedOut");
        assert!(state
            .resolve("tab-1", &record.id, BrowserRequestDecision::Continue)
            .is_err());
    }

    #[test]
    fn rejects_response_header_injection_and_oversized_bodies() {
        assert!(validate_decision(BrowserRequestDecisionInputKind::Fulfill {
            body: "x".repeat(MAX_RESPONSE_BODY_BYTES + 1),
            status: 200,
            headers: HashMap::new()
        })
        .is_err());
        assert!(validate_decision(BrowserRequestDecisionInputKind::Fulfill {
            body: String::new(),
            status: 200,
            headers: HashMap::from([("x-test".into(), "ok\r\nbad: yes".into())])
        })
        .is_err());
    }
}
