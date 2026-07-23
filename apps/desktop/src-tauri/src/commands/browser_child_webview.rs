use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl,
};

#[path = "browser_download_file_progress.rs"]
mod browser_download_file_progress;
#[path = "browser_permission_overrides.rs"]
pub(crate) mod browser_permission_overrides;
#[path = "browser_permission_policy.rs"]
mod browser_permission_policy;
#[path = "browser_process_failure.rs"]
mod browser_process_failure;
#[path = "browser_screencast_dirty.rs"]
mod browser_screencast_dirty;
#[path = "browser_script_dialog.rs"]
mod browser_script_dialog;
#[path = "browser_subresource_interception_windows.rs"]
mod browser_subresource_interception_windows;
#[path = "browser_webkit_document_request_control.rs"]
mod browser_webkit_document_request_control;
#[path = "browser_webview_download_linux.rs"]
mod browser_webview_download_linux;
#[path = "browser_webview_download_macos.rs"]
mod browser_webview_download_macos;
#[path = "browser_webview_download_windows.rs"]
mod browser_webview_download_windows;
#[path = "browser_webview_pdf.rs"]
mod browser_webview_pdf;
#[path = "browser_webview_screenshot.rs"]
pub(crate) mod browser_webview_screenshot;

pub use browser_permission_overrides::NativeBrowserPermissionOverrideRegistry;
use browser_webview_screenshot::{capture_platform_webview, validate_screenshot_crop};

pub(crate) const BROWSER_WEBVIEW_LABEL_PREFIX: &str = "browser-";
const BROWSER_DOWNLOAD_EVENT: &str = "pebble://browser-download";
const BROWSER_NEW_WINDOW_EVENT: &str = "pebble://browser-new-window";
const BROWSER_CONTEXT_MENU_EVENT: &str = "pebble://browser-context-menu";
const BROWSER_PAGE_LOAD_EVENT: &str = "pebble://browser-page-load";
const MAX_PROFILE_KEY_LENGTH: usize = 160;
const MAX_BROWSER_USER_AGENT_LENGTH: usize = 2048;
const MAX_INIT_SCRIPT_COUNT: usize = 32;
const MAX_INIT_SCRIPT_BYTES: usize = 512 * 1024;
const MAX_INIT_SCRIPT_TOTAL_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChildWebviewCreateInput {
    pub label: String,
    pub url: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub profile_key: Option<String>,
    pub user_agent: Option<String>,
    pub browser_tab_id: String,
    pub permission_profile_id: Option<String>,
    #[serde(default)]
    pub grab_shortcuts: Vec<String>,
    #[serde(default)]
    pub init_scripts: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChildWebviewCreateResult {
    pub label: String,
    pub isolated_profile: bool,
}

#[tauri::command]
pub async fn browser_profile_storage_delete(
    app: AppHandle,
    profile_key: String,
) -> Result<bool, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        delete_browser_profile_storage(&app_data_dir, &profile_key)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeBrowserNewWindowEvent {
    browser_tab_id: String,
    url: String,
    allowed_in_pebble: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeBrowserPageLoadEvent {
    browser_tab_id: String,
    label: String,
    url: String,
    event: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum NativeBrowserContextMenuEvent {
    Requested {
        browser_tab_id: String,
        screen_x: f64,
        screen_y: f64,
        page_url: String,
        link_url: String,
        selection_text: String,
    },
    Dismissed {
        browser_tab_id: String,
    },
    PermissionDenied {
        browser_tab_id: String,
        permission: String,
        origin: String,
    },
    GrabModeToggle {
        browser_tab_id: String,
    },
    GrabActionShortcut {
        browser_tab_id: String,
        key: String,
    },
}

pub(super) fn emit_browser_permission_denied(
    app: &AppHandle,
    browser_tab_id: &str,
    permission: &str,
    raw_origin: &str,
) {
    let origin = Url::parse(raw_origin)
        .ok()
        .map(|url| url.origin().ascii_serialization())
        .filter(|origin| origin != "null")
        .unwrap_or_else(|| "unknown".to_string());
    let _ = app.emit(
        BROWSER_CONTEXT_MENU_EVENT,
        NativeBrowserContextMenuEvent::PermissionDenied {
            browser_tab_id: browser_tab_id.to_string(),
            permission: permission.chars().take(64).collect(),
            origin,
        },
    );
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum BrowserScreenshotFormat {
    Png,
    Jpeg,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChildWebviewScreenshotInput {
    pub label: String,
    pub format: BrowserScreenshotFormat,
    pub crop: Option<BrowserScreenshotCrop>,
    pub device_scale_factor: Option<f64>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshotCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChildWebviewScreenshotResult {
    pub data: String,
    pub format: BrowserScreenshotFormat,
}

#[derive(Debug, Serialize)]
pub struct BrowserChildWebviewPdfResult {
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChildWebviewPdfInput {
    pub label: String,
}

#[derive(Clone, Debug)]
struct PendingNativeDownload {
    id: String,
    browser_tab_id: String,
    url: String,
    filename: String,
    path: PathBuf,
    request_id: Option<String>,
}

#[derive(Clone, Debug)]
struct DesiredNativeDownload {
    request_id: String,
    path: PathBuf,
    created_at: Instant,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDownloadCompletion {
    path: String,
    success: bool,
}

#[derive(Default)]
struct NativeDownloadState {
    by_url: HashMap<String, VecDeque<PendingNativeDownload>>,
    claimed_native_ids: HashSet<String>,
    reserved_paths: HashSet<PathBuf>,
    desired_by_tab: HashMap<String, DesiredNativeDownload>,
    completions: HashMap<String, BrowserDownloadCompletion>,
    #[cfg(target_os = "windows")]
    active_webviews: HashMap<String, String>,
}

#[derive(Clone, Default)]
pub struct NativeBrowserDownloadRegistry(Arc<Mutex<NativeDownloadState>>);

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum NativeBrowserDownloadEvent {
    Requested {
        native_download_id: String,
        browser_tab_id: String,
        url: String,
        filename: String,
        path: String,
    },
    Progress {
        native_download_id: String,
        browser_tab_id: String,
        received_bytes: u64,
        total_bytes: Option<u64>,
    },
    Finished {
        native_download_id: String,
        browser_tab_id: String,
        url: String,
        filename: String,
        path: String,
        success: bool,
    },
}

#[tauri::command]
pub fn browser_child_webview_create(
    app: AppHandle,
    download_registry: State<'_, NativeBrowserDownloadRegistry>,
    permission_overrides: State<'_, NativeBrowserPermissionOverrideRegistry>,
    interception_state: State<
        '_,
        super::browser_navigation_interception::NativeBrowserNavigationInterceptionState,
    >,
    request_control: State<'_, super::browser_request_control::NativeBrowserRequestControlState>,
    input: BrowserChildWebviewCreateInput,
) -> Result<BrowserChildWebviewCreateResult, String> {
    let label = validate_browser_webview_label(&input.label)?;
    let url = validate_browser_url(&input.url)?;
    let browser_tab_id = validate_browser_tab_id(&input.browser_tab_id)?;
    let permission_profile_id =
        validate_permission_profile_id(input.permission_profile_id.as_deref())?;
    validate_bounds(&input)?;
    let profile_key = validate_profile_key(input.profile_key.as_deref())?;
    let user_agent = validate_browser_user_agent(input.user_agent.as_deref())?;
    let init_scripts = validate_browser_init_scripts(&input.init_scripts)?;
    let window = crate::primary_window::window(&app)
        .ok_or_else(|| "primary window is not available".to_string())?;
    let mut builder = tauri::webview::WebviewBuilder::new(label.clone(), WebviewUrl::External(url))
        .devtools(true)
        .initialization_script(browser_context_menu_script(&input.grab_shortcuts)?)
        .initialization_script(browser_automation_capture_script())
        .initialization_script(browser_screencast_dirty::script())
        .initialization_script(browser_webkit_document_request_control::script());
    for script in init_scripts {
        builder = builder.initialization_script(script);
    }
    if let Some(user_agent) = user_agent.as_deref() {
        builder = builder.user_agent(user_agent);
    }
    if let Some(profile_key) = profile_key.as_deref() {
        let data_directory = browser_profile_data_directory(&app, profile_key)?;
        std::fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
        builder = builder
            .data_directory(data_directory)
            .data_store_identifier(stable_profile_identifier(profile_key));
    }
    let download_app = app.clone();
    let download_directory = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    let download_state = download_registry.0.clone();
    let tracking_state = download_state.clone();
    let tracking_app = app.clone();
    let download_tab_id = browser_tab_id.clone();
    builder = builder.on_download(move |_webview, event| {
        handle_browser_download_event(
            &download_app,
            &download_directory,
            &download_tab_id,
            &download_state,
            event,
        )
    });
    let popup_app = app.clone();
    let popup_tab_id = browser_tab_id.clone();
    builder = builder.on_new_window(move |url, _features| {
        let allowed_in_pebble = matches!(url.scheme(), "http" | "https");
        let _ = popup_app.emit(
            BROWSER_NEW_WINDOW_EVENT,
            NativeBrowserNewWindowEvent {
                browser_tab_id: popup_tab_id.clone(),
                url: url.to_string(),
                allowed_in_pebble,
            },
        );
        NewWindowResponse::Deny
    });
    let page_load_app = app.clone();
    let page_load_tab_id = browser_tab_id.clone();
    let page_load_label = label.clone();
    builder = builder.on_page_load(move |_webview, payload| {
        let event = match payload.event() {
            PageLoadEvent::Started => "started",
            PageLoadEvent::Finished => "finished",
        };
        let _ = page_load_app.emit(
            BROWSER_PAGE_LOAD_EVENT,
            NativeBrowserPageLoadEvent {
                browser_tab_id: page_load_tab_id.clone(),
                label: page_load_label.clone(),
                url: payload.url().to_string(),
                event,
            },
        );
    });
    let navigation_app = app.clone();
    let navigation_tab_id = browser_tab_id.clone();
    let navigation_webview_label = label.clone();
    let native_interception = interception_state.inner().clone();
    let native_subresource_interception = native_interception.clone();
    let native_request_control = request_control.inner().clone();
    native_interception.register_webview(&label, &browser_tab_id);
    builder = builder.on_navigation(move |url| {
        if url.scheme() != "pebble-context" {
            if url.scheme() == super::browser_navigation_interception::FULFILLMENT_SCHEME {
                return true;
            }
            match native_interception.decide_top_level_navigation(
                &navigation_tab_id,
                &navigation_webview_label,
                url.as_str(),
            ) {
                super::browser_navigation_interception::NativeTopLevelNavigationDecision::Allow => {
                    return true;
                }
                super::browser_navigation_interception::NativeTopLevelNavigationDecision::Block => {
                    return false;
                }
                super::browser_navigation_interception::NativeTopLevelNavigationDecision::Fulfill(
                    fulfillment_url,
                ) => {
                    let app = navigation_app.clone();
                    let label = navigation_webview_label.clone();
                    let _ = navigation_app.run_on_main_thread(move || {
                        if let (Some(webview), Ok(url)) =
                            (app.get_webview(&label), Url::parse(&fulfillment_url))
                        {
                            let _ = webview.navigate(url);
                        }
                    });
                    return false;
                }
            }
        }
        if let Some(event) = parse_context_menu_navigation(url, &navigation_tab_id) {
            let _ = navigation_app.emit(BROWSER_CONTEXT_MENU_EVENT, event);
        }
        false
    });
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(input.x, input.y),
            LogicalSize::new(input.width, input.height),
        )
        .map_err(|error| error.to_string())?;
    browser_webview_download_windows::attach_download_tracking(
        &webview,
        label.clone(),
        tracking_app,
        Arc::clone(&tracking_state),
    )?;
    browser_webview_download_linux::attach(&webview, Arc::clone(&tracking_state))?;
    browser_webview_download_macos::attach(&webview, tracking_state)?;
    browser_process_failure::attach(&webview, app.clone(), label.clone(), input.url.clone())?;
    super::browser_http_auth::attach(&webview, label.clone())?;
    browser_permission_policy::attach(
        &webview,
        app.clone(),
        browser_tab_id.clone(),
        permission_profile_id,
        permission_overrides.inner().clone(),
    )?;
    browser_subresource_interception_windows::attach(
        &webview,
        browser_tab_id,
        native_subresource_interception,
        native_request_control,
    )?;
    webview
        .with_webview(|platform_webview| {
            if let Err(error) = browser_script_dialog::attach(platform_webview) {
                eprintln!("[browser-dialog] native hook failed: {error}");
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(BrowserChildWebviewCreateResult {
        label,
        isolated_profile: profile_key.is_some(),
    })
}

fn validate_browser_init_scripts(scripts: &[String]) -> Result<Vec<&str>, String> {
    if scripts.len() > MAX_INIT_SCRIPT_COUNT {
        return Err(format!(
            "browser init scripts exceed {MAX_INIT_SCRIPT_COUNT} entries"
        ));
    }
    let mut total = 0usize;
    let mut validated = Vec::with_capacity(scripts.len());
    for script in scripts {
        let bytes = script.len();
        if bytes == 0 || bytes > MAX_INIT_SCRIPT_BYTES {
            return Err("browser init script must contain 1 to 524288 bytes".to_string());
        }
        total = total.saturating_add(bytes);
        if total > MAX_INIT_SCRIPT_TOTAL_BYTES {
            return Err("browser init scripts exceed the 1 MiB aggregate limit".to_string());
        }
        validated.push(script.as_str());
    }
    Ok(validated)
}

#[tauri::command]
pub async fn browser_child_webview_resolve_dialog(
    app: AppHandle,
    label: String,
    accept: bool,
    text: Option<String>,
) -> Result<bool, String> {
    let label = validate_browser_webview_label(&label)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser WebView is not available".to_string())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let _ = sender.send(browser_script_dialog::resolve(
                platform_webview,
                accept,
                text,
            ));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "browser dialog resolver was dropped".to_string())?
}

fn browser_context_menu_script(grab_shortcuts: &[String]) -> Result<String, String> {
    if grab_shortcuts.len() > 8 || grab_shortcuts.iter().any(|binding| binding.len() > 128) {
        return Err("browser grab shortcut configuration is too large".to_string());
    }
    let bindings = serde_json::to_string(grab_shortcuts).map_err(|error| error.to_string())?;
    Ok(r#"
(() => {
  let menuOpen = false;
  const grabBindings = __PEBBLE_GRAB_BINDINGS__;
  const Params = URLSearchParams;
  const signal = (kind, values = {}) => {
    const params = new Params({ kind, ...values });
    window.location.href = `pebble-context://event?${params.toString()}`;
  };
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest('a[href]');
    menuOpen = true;
    signal('requested', {
      screenX: String(event.screenX),
      screenY: String(event.screenY),
      pageUrl: String(window.location.href).slice(0, 8192),
      linkUrl: String(link?.href ?? '').slice(0, 8192),
      selectionText: String(window.getSelection()?.toString() ?? '').slice(0, 4096)
    });
  }, true);
  document.addEventListener('pointerdown', (event) => {
    if (!menuOpen || event.button === 2) return;
    menuOpen = false;
    signal('dismissed');
  }, true);
  document.addEventListener('keydown', (event) => {
    const key = String(event.key || '').toLowerCase();
    if (window.__pebbleGrab && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (key === 'c' || key === 's')) {
      event.preventDefault();
      event.stopPropagation();
      signal('grabActionShortcut', { key });
      return;
    }
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const matches = grabBindings.some((binding) => {
      const tokens = String(binding).split('+').map((token) => token.trim().toLowerCase()).filter(Boolean);
      const expectedKey = tokens.at(-1);
      const wantsMod = tokens.includes('mod');
      const wantsMeta = tokens.includes('meta') || tokens.includes('cmd') || (wantsMod && isMac);
      const wantsCtrl = tokens.includes('ctrl') || tokens.includes('control') || (wantsMod && !isMac);
      const wantsAlt = tokens.includes('alt') || tokens.includes('option');
      const wantsShift = tokens.includes('shift');
      return expectedKey === key && event.metaKey === wantsMeta && event.ctrlKey === wantsCtrl && event.altKey === wantsAlt && event.shiftKey === wantsShift;
    });
    if (!matches) return;
    const active = document.activeElement;
    const editable = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active?.isContentEditable === true || active?.tagName === 'SELECT' || active?.tagName === 'IFRAME';
    const selection = window.getSelection();
    if (editable || (selection?.type === 'Range' && selection.toString().trim())) return;
    event.preventDefault();
    event.stopPropagation();
    signal('grabModeToggle');
  }, true);
  const reportDenied = (permission) => signal('permissionDenied', {
    permission,
    origin: String(window.location.origin).slice(0, 512)
  });
  const media = navigator.mediaDevices;
  if (media?.getUserMedia) {
    const original = media.getUserMedia.bind(media);
    media.getUserMedia = (...args) => original(...args).catch((error) => {
      if (error?.name === 'NotAllowedError') reportDenied('media');
      throw error;
    });
  }
  if (globalThis.Notification?.requestPermission) {
    const original = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = (...args) => original(...args).then((result) => {
      if (result === 'denied') reportDenied('notifications');
      return result;
    });
  }
})();
"#
    .replace("__PEBBLE_GRAB_BINDINGS__", &bindings))
}

fn browser_automation_capture_script() -> &'static str {
    r#"
(() => {
  const MAX = 1000;
  const state = globalThis.__pebbleAutomationCapture = {
    active: false,
    console: [],
    network: [],
    interceptPatterns: [],
    interceptRoutes: [],
    intercepted: [],
    extraHeaders: {},
    offline: false,
    authorization: null,
    networkInflight: 0,
    harStartedAt: null
  };
  const push = (target, entry) => {
    if (!state.active) return;
    pushBounded(target, entry);
  };
  const pushBounded = (target, entry) => {
    target.push(entry);
    if (target.length > MAX) target.splice(0, target.length - MAX);
  };
  const requestId = () => crypto.randomUUID?.() || String(Date.now()) + Math.random();
  const text = (value) => {
    try { return typeof value === 'string' ? value : JSON.stringify(value); }
    catch { return String(value); }
  };
  const patternMatches = (pattern, url) => {
    let escaped = '';
    for (let index = 0; index < pattern.length; index += 1) {
      const character = pattern[index];
      if (character === '*') {
        if (pattern[index + 1] === '*') {
          escaped += '.*';
          index += 1;
        } else {
          escaped += '[^/]*';
        }
      } else {
        escaped += /[.+^${}()|[\]\\]/.test(character) ? '\\' + character : character;
      }
    }
    try { return new RegExp('^' + escaped + '$').test(url); } catch { return false; }
  };
  const matchingRoute = (url) => state.interceptRoutes.find((route) => patternMatches(route.pattern, url));
  const intercept = (url, method, resourceType) => {
    const route = matchingRoute(url);
    if (!route) return null;
    // Interception is independent from capture; callers may block and inspect
    // requests without collecting console or completed network traffic.
    if (route.action !== 'pause') {
      pushBounded(state.intercepted, {
        id: requestId(),
        url,
        method,
        headers: {},
        resourceType
      });
    }
    return route;
  };
  for (const level of ['debug', 'info', 'log', 'warn', 'error']) {
    const original = console[level]?.bind(console);
    if (!original) continue;
    console[level] = (...args) => {
      push(state.console, {
        level,
        text: args.map(text).join(' ').slice(0, 16384),
        timestamp: Date.now(),
        url: location.href.slice(0, 8192)
      });
      return original(...args);
    };
  }
  const originalFetch = globalThis.fetch?.bind(globalThis);
  if (originalFetch) {
    globalThis.fetch = async (...args) => {
      const started = Date.now();
      const request = args[0];
      const method = String(args[1]?.method || (request instanceof Request ? request.method : 'GET'));
      const url = new URL(String(request instanceof Request ? request.url : request), location.href).href.slice(0, 8192);
      if (state.offline) throw new TypeError('Failed to fetch');
      const route = intercept(url, method, 'fetch');
      if (route?.action === 'abort') throw new TypeError('Failed to fetch');
      if (route?.action === 'fulfill') {
        const response = new Response(route.body, { status: route.status, headers: { 'Content-Type': route.contentType } });
        pushBounded(state.network, { id: requestId(), url, method, status: route.status, resourceType: 'fetch',
          requestHeaders: {}, responseHeaders: { 'content-type': route.contentType }, responseBody: route.body.slice(0, 65536), timestamp: started });
        return response;
      }
      state.networkInflight++;
      try {
        const init = args[1] || {};
        const headers = new Headers(request instanceof Request ? request.headers : init.headers);
        for (const [name, value] of Object.entries(state.extraHeaders)) headers.set(name, value);
        if (state.authorization && !headers.has('authorization')) headers.set('Authorization', state.authorization);
        const response = request instanceof Request
          ? await originalFetch(new Request(request, { ...init, headers }))
          : await originalFetch(request, { ...init, headers });
        const entry = {
          id: requestId(),
          url,
          method,
          status: response.status,
          resourceType: 'fetch',
          requestHeaders: Object.fromEntries(headers.entries()),
          responseHeaders: Object.fromEntries(response.headers.entries()),
          mimeType: String(response.headers.get('content-type') || '').slice(0, 512),
          size: Number(response.headers.get('content-length') || 0) || 0,
          timestamp: started
        };
        pushBounded(state.network, entry);
        void response.clone().text().then((body) => { entry.responseBody = body.slice(0, 65536); }).catch(() => {});
        return response;
      } catch (error) {
        pushBounded(state.network, { id: requestId(), url, method, status: 0, resourceType: 'fetch', mimeType: '', size: 0, timestamp: started });
        throw error;
      } finally {
        state.networkInflight = Math.max(0, state.networkInflight - 1);
      }
    };
  }
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__pebbleRequest = { method: String(method), url: new URL(String(url), location.href).href.slice(0, 8192), async: rest[0] !== false, headers: new Headers() };
    return open.call(this, method, url, ...rest);
  };
  const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    try { this.__pebbleRequest?.headers?.append(String(name), String(value)); } catch {}
    return setRequestHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const started = Date.now();
    const continueRequest = () => {
      state.networkInflight++;
      for (const [name, value] of Object.entries(state.extraHeaders)) {
        try { this.setRequestHeader(name, value); } catch {}
      }
      if (state.authorization && !Object.keys(state.extraHeaders).some((name) => name.toLowerCase() === 'authorization')) {
        try { this.setRequestHeader('Authorization', state.authorization); } catch {}
      }
      this.addEventListener('loadend', () => {
        state.networkInflight = Math.max(0, state.networkInflight - 1);
        pushBounded(state.network, {
          id: requestId(),
          url: this.__pebbleRequest?.url || '',
          method: this.__pebbleRequest?.method || 'GET',
          status: this.status || 0,
          resourceType: 'xhr',
          mimeType: String(this.getResponseHeader('content-type') || '').slice(0, 512),
          size: Number(this.getResponseHeader('content-length') || 0) || 0,
          timestamp: started
        });
      }, { once: true });
      return send.apply(this, args);
    };
    if (state.offline) {
      this.abort();
      queueMicrotask(() => {
        this.dispatchEvent(new ProgressEvent('error'));
        this.dispatchEvent(new ProgressEvent('loadend'));
      });
      return;
    }
    const route = intercept(this.__pebbleRequest?.url || '', this.__pebbleRequest?.method || 'GET', 'xhr');
    if (route?.action === 'abort') {
      this.abort();
      return;
    }
    if (route?.action === 'fulfill') {
      Object.defineProperties(this, {
        readyState: { configurable: true, value: 4 },
        status: { configurable: true, value: route.status },
        responseText: { configurable: true, value: route.body },
        response: { configurable: true, value: route.body }
      });
      this.getResponseHeader = (name) => String(name).toLowerCase() === 'content-type' ? route.contentType : null;
      pushBounded(state.network, { id: requestId(), url: this.__pebbleRequest?.url || '',
        method: this.__pebbleRequest?.method || 'GET', status: route.status, resourceType: 'xhr',
        requestHeaders: {}, responseHeaders: { 'content-type': route.contentType }, responseBody: route.body.slice(0, 65536), timestamp: started });
      queueMicrotask(() => {
        this.dispatchEvent(new ProgressEvent('readystatechange'));
        this.dispatchEvent(new ProgressEvent('load'));
        this.dispatchEvent(new ProgressEvent('loadend'));
      });
      return;
    }
    return continueRequest();
  };
})();
"#
}

fn parse_context_menu_navigation(
    url: &Url,
    browser_tab_id: &str,
) -> Option<NativeBrowserContextMenuEvent> {
    let values: HashMap<_, _> = url.query_pairs().into_owned().collect();
    match values.get("kind")?.as_str() {
        "requested" => Some(NativeBrowserContextMenuEvent::Requested {
            browser_tab_id: browser_tab_id.to_string(),
            screen_x: values.get("screenX")?.parse().ok()?,
            screen_y: values.get("screenY")?.parse().ok()?,
            page_url: bounded_context_value(values.get("pageUrl"), 8192),
            link_url: bounded_context_value(values.get("linkUrl"), 8192),
            selection_text: bounded_context_value(values.get("selectionText"), 4096),
        }),
        "dismissed" => Some(NativeBrowserContextMenuEvent::Dismissed {
            browser_tab_id: browser_tab_id.to_string(),
        }),
        "permissionDenied" => Some(NativeBrowserContextMenuEvent::PermissionDenied {
            browser_tab_id: browser_tab_id.to_string(),
            permission: bounded_context_value(values.get("permission"), 64),
            origin: bounded_context_value(values.get("origin"), 512),
        }),
        "grabModeToggle" => Some(NativeBrowserContextMenuEvent::GrabModeToggle {
            browser_tab_id: browser_tab_id.to_string(),
        }),
        "grabActionShortcut" => {
            let key = bounded_context_value(values.get("key"), 1);
            if key != "c" && key != "s" {
                return None;
            }
            Some(NativeBrowserContextMenuEvent::GrabActionShortcut {
                browser_tab_id: browser_tab_id.to_string(),
                key,
            })
        }
        _ => None,
    }
}

fn bounded_context_value(value: Option<&String>, max_chars: usize) -> String {
    value
        .map(|value| value.chars().take(max_chars).collect())
        .unwrap_or_default()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChildWebviewCancelDownloadInput {
    pub native_download_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChildWebviewPrepareDownloadInput {
    pub label: String,
    pub browser_tab_id: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChildWebviewWaitDownloadInput {
    pub request_id: String,
}

#[tauri::command]
pub fn browser_child_webview_prepare_download(
    app: AppHandle,
    download_registry: State<'_, NativeBrowserDownloadRegistry>,
    input: BrowserChildWebviewPrepareDownloadInput,
) -> Result<String, String> {
    let label = validate_browser_webview_label(&input.label)?;
    let browser_tab_id = validate_browser_tab_id(&input.browser_tab_id)?;
    if app.get_webview(&label).is_none() {
        return Err("browser webview is not available".to_string());
    }
    let path = validate_requested_download_path(&input.path)?;
    let mut state = download_registry
        .0
        .lock()
        .map_err(|_| "download registry is unavailable")?;
    prune_stale_desired_downloads(&mut state);
    if state.reserved_paths.contains(&path) {
        return Err("browser download path is already reserved".to_string());
    }
    if let Some(previous) = state.desired_by_tab.remove(&browser_tab_id) {
        state.reserved_paths.remove(&previous.path);
    }
    let request_id = format!("download-request-{}", uuid::Uuid::new_v4());
    state.reserved_paths.insert(path.clone());
    state.desired_by_tab.insert(
        browser_tab_id,
        DesiredNativeDownload {
            request_id: request_id.clone(),
            path,
            created_at: Instant::now(),
        },
    );
    Ok(request_id)
}

#[tauri::command]
pub async fn browser_child_webview_wait_download(
    download_registry: State<'_, NativeBrowserDownloadRegistry>,
    input: BrowserChildWebviewWaitDownloadInput,
) -> Result<BrowserDownloadCompletion, String> {
    let request_id = input.request_id.trim();
    if !request_id.starts_with("download-request-") || request_id.len() > 256 {
        return Err("invalid browser download request id".to_string());
    }
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if let Some(completion) = download_registry
            .0
            .lock()
            .map_err(|_| "download registry is unavailable")?
            .completions
            .remove(request_id)
        {
            return Ok(completion);
        }
        if Instant::now() >= deadline {
            let mut state = download_registry
                .0
                .lock()
                .map_err(|_| "download registry is unavailable")?;
            let tab_id = state.desired_by_tab.iter().find_map(|(tab_id, desired)| {
                (desired.request_id == request_id).then(|| tab_id.clone())
            });
            if let Some(tab_id) = tab_id {
                if let Some(desired) = state.desired_by_tab.remove(&tab_id) {
                    state.reserved_paths.remove(&desired.path);
                }
            }
            return Err("browser download timed out".to_string());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tauri::command]
pub async fn browser_child_webview_cancel_download(
    app: AppHandle,
    download_registry: State<'_, NativeBrowserDownloadRegistry>,
    input: BrowserChildWebviewCancelDownloadInput,
) -> Result<bool, String> {
    let native_download_id = input.native_download_id.trim();
    if native_download_id.is_empty() || native_download_id.len() > 256 {
        return Err("invalid native browser download id".to_string());
    }
    let canceled = browser_webview_download_windows::cancel_download(
        &app,
        &download_registry.0,
        native_download_id,
    )
    .await?;
    if canceled {
        return Ok(true);
    }
    if browser_webview_download_linux::cancel(&app, native_download_id).await? {
        return Ok(true);
    }
    browser_webview_download_macos::cancel(&app, &download_registry.0, native_download_id).await
}

fn handle_browser_download_event(
    app: &AppHandle,
    download_directory: &Path,
    browser_tab_id: &str,
    state: &Arc<Mutex<NativeDownloadState>>,
    event: DownloadEvent<'_>,
) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let url_text = url.to_string();
            let mut downloads = match state.lock() {
                Ok(downloads) => downloads,
                Err(_) => return false,
            };
            prune_stale_desired_downloads(&mut downloads);
            let desired = downloads.desired_by_tab.remove(browser_tab_id);
            let filename = desired
                .as_ref()
                .and_then(|entry| entry.path.file_name())
                .and_then(|name| name.to_str())
                .map(str::to_string)
                .unwrap_or_else(|| browser_download_filename(destination, &url_text));
            let path = desired
                .as_ref()
                .map(|entry| entry.path.clone())
                .unwrap_or_else(|| {
                    reserve_browser_download_path(download_directory, &filename, &downloads)
                });
            *destination = path.clone();
            downloads.reserved_paths.insert(path.clone());
            let pending = PendingNativeDownload {
                id: format!("native-download-{}", uuid::Uuid::new_v4()),
                browser_tab_id: browser_tab_id.to_string(),
                url: url_text.clone(),
                filename: filename.clone(),
                path: path.clone(),
                request_id: desired.map(|entry| entry.request_id),
            };
            let payload = NativeBrowserDownloadEvent::Requested {
                native_download_id: pending.id.clone(),
                browser_tab_id: pending.browser_tab_id.clone(),
                url: pending.url.clone(),
                filename,
                path: path.to_string_lossy().into_owned(),
            };
            downloads
                .by_url
                .entry(url_text)
                .or_default()
                .push_back(pending.clone());
            drop(downloads);
            browser_webview_download_macos::bind_pending_download(state, &pending);
            let _ = app.emit(BROWSER_DOWNLOAD_EVENT, payload);
            browser_download_file_progress::start_file_progress_tracking(
                app.clone(),
                Arc::clone(state),
                pending,
            );
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let url_text = url.to_string();
            let mut state = match state.lock() {
                Ok(state) => state,
                Err(_) => return true,
            };
            let pending = take_finished_download(&mut state, &url_text, path.as_deref());
            let Some(pending) = pending else {
                return true;
            };
            state.reserved_paths.remove(&pending.path);
            if let Some(request_id) = pending.request_id.as_ref() {
                state.completions.insert(
                    request_id.clone(),
                    BrowserDownloadCompletion {
                        path: path
                            .as_ref()
                            .unwrap_or(&pending.path)
                            .to_string_lossy()
                            .into_owned(),
                        success,
                    },
                );
            }
            #[cfg(target_os = "windows")]
            {
                state.active_webviews.remove(&pending.id);
                browser_webview_download_windows::forget_download(&pending.id);
            }
            browser_webview_download_linux::forget(&pending.id);
            browser_webview_download_macos::forget(&pending.id);
            let resolved_path = path.unwrap_or(pending.path);
            let payload = NativeBrowserDownloadEvent::Finished {
                native_download_id: pending.id,
                browser_tab_id: pending.browser_tab_id,
                url: pending.url,
                filename: pending.filename,
                path: resolved_path.to_string_lossy().into_owned(),
                success,
            };
            let _ = app.emit(BROWSER_DOWNLOAD_EVENT, payload);
            true
        }
        _ => true,
    }
}

fn take_finished_download(
    state: &mut NativeDownloadState,
    url: &str,
    finished_path: Option<&Path>,
) -> Option<PendingNativeDownload> {
    let queue = state.by_url.get_mut(url)?;
    // Why: same-URL downloads may finish out of order; their reserved paths
    // are stable native identities even when Tauri omits a download handle.
    let pending = if let Some(path) = finished_path {
        queue
            .iter()
            .position(|entry| entry.path == path)
            .and_then(|index| queue.remove(index))
    } else {
        queue.pop_front()
    };
    if queue.is_empty() {
        state.by_url.remove(url);
    }
    if let Some(pending) = pending.as_ref() {
        state.claimed_native_ids.remove(&pending.id);
    }
    pending
}

fn claim_pending_download_for_url(
    state: &mut NativeDownloadState,
    url: &str,
) -> Option<PendingNativeDownload> {
    let pending = state
        .by_url
        .get(url)?
        .iter()
        .find(|pending| !state.claimed_native_ids.contains(&pending.id))?
        .clone();
    state.claimed_native_ids.insert(pending.id.clone());
    Some(pending)
}

fn validate_requested_download_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute() || path.file_name().is_none() {
        return Err("browser download path must be an absolute file path".to_string());
    }
    if path.exists() {
        return Err("browser download path already exists".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "browser download path has no parent".to_string())?;
    if !parent.is_dir() {
        return Err("browser download parent directory does not exist".to_string());
    }
    Ok(path)
}

fn prune_stale_desired_downloads(state: &mut NativeDownloadState) {
    let stale: Vec<String> = state
        .desired_by_tab
        .iter()
        .filter(|(_, entry)| entry.created_at.elapsed() > Duration::from_secs(120))
        .map(|(tab_id, _)| tab_id.clone())
        .collect();
    for tab_id in stale {
        if let Some(entry) = state.desired_by_tab.remove(&tab_id) {
            state.reserved_paths.remove(&entry.path);
        }
    }
}

fn browser_download_filename(destination: &Path, url: &str) -> String {
    let candidate = destination
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            url.split('?')
                .next()
                .and_then(|value| value.rsplit('/').next())
                .filter(|name| !name.trim().is_empty())
                .map(str::to_string)
        });
    sanitize_browser_download_filename(candidate.as_deref())
}

fn sanitize_browser_download_filename(value: Option<&str>) -> String {
    let value = value.unwrap_or("download").trim();
    if value.is_empty() || value == "." || value == ".." {
        return "download".to_string();
    }
    let cleaned: String = value
        .chars()
        .take(180)
        .map(|character| {
            if character.is_control() || matches!(character, '/' | '\\' | ':') {
                '_'
            } else {
                character
            }
        })
        .collect();
    if cleaned.trim_matches(['.', ' ']).is_empty() {
        "download".to_string()
    } else {
        cleaned
    }
}

fn reserve_browser_download_path(
    directory: &Path,
    filename: &str,
    state: &NativeDownloadState,
) -> PathBuf {
    let original = Path::new(filename);
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("download");
    let extension = original.extension().and_then(|value| value.to_str());
    for suffix in 0..10_000_u32 {
        let candidate_name = if suffix == 0 {
            filename.to_string()
        } else if let Some(extension) = extension {
            format!("{stem} ({suffix}).{extension}")
        } else {
            format!("{stem} ({suffix})")
        };
        let candidate = directory.join(candidate_name);
        if !candidate.exists() && !state.reserved_paths.contains(&candidate) {
            return candidate;
        }
    }
    directory.join(format!("download-{}", uuid::Uuid::new_v4()))
}

#[tauri::command]
pub async fn browser_child_webview_screenshot(
    app: AppHandle,
    input: BrowserChildWebviewScreenshotInput,
) -> Result<BrowserChildWebviewScreenshotResult, String> {
    let label = validate_browser_webview_label(&input.label)?;
    let crop = validate_screenshot_crop(input.crop)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    let format = input.format;
    let device_scale_factor = validate_device_scale_factor(input.device_scale_factor)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let _ = sender.send(capture_platform_webview(
                platform_webview,
                format,
                crop,
                device_scale_factor,
            ));
        })
        .map_err(|error| error.to_string())?;
    let bytes = receiver
        .await
        .map_err(|_| "browser screenshot callback was dropped".to_string())??;
    if bytes.is_empty() {
        return Err("browser screenshot returned empty image data".to_string());
    }
    Ok(BrowserChildWebviewScreenshotResult {
        data: BASE64_STANDARD.encode(bytes),
        format,
    })
}

#[tauri::command]
pub async fn browser_child_webview_pdf(
    app: AppHandle,
    input: BrowserChildWebviewPdfInput,
) -> Result<BrowserChildWebviewPdfResult, String> {
    let label = validate_browser_webview_label(&input.label)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    let bytes = capture_webview_pdf_bytes(&webview).await?;
    Ok(BrowserChildWebviewPdfResult {
        data: BASE64_STANDARD.encode(bytes),
    })
}

pub(crate) async fn capture_webview_pdf_bytes(webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            browser_webview_pdf::capture_platform_pdf(platform_webview, sender);
        })
        .map_err(|error| error.to_string())?;
    let bytes = tokio::time::timeout(Duration::from_secs(30), receiver)
        .await
        .map_err(|_| "browser PDF capture timed out".to_string())?
        .map_err(|_| "browser PDF callback was dropped".to_string())??;
    validate_pdf_bytes(&bytes)?;
    Ok(bytes)
}

fn validate_pdf_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 8 || bytes.len() > 128 * 1024 * 1024 || !bytes.starts_with(b"%PDF-") {
        return Err("browser PDF result is not a valid bounded PDF".to_string());
    }
    Ok(())
}

fn validate_device_scale_factor(value: Option<f64>) -> Result<f64, String> {
    let value = value.unwrap_or(1.0);
    if !value.is_finite() || !(0.25..=8.0).contains(&value) {
        return Err("invalid browser screenshot device scale factor".to_string());
    }
    Ok(value)
}

pub(super) fn validate_browser_webview_label(value: &str) -> Result<String, String> {
    let label = value.trim();
    if !label.starts_with(BROWSER_WEBVIEW_LABEL_PREFIX) || label.len() > 256 {
        return Err("invalid browser webview label".to_string());
    }
    if !label.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '/' | ':')
    }) {
        return Err("invalid browser webview label".to_string());
    }
    Ok(label.to_string())
}

fn validate_browser_url(value: &str) -> Result<tauri::Url, String> {
    let url = value
        .trim()
        .parse::<tauri::Url>()
        .map_err(|_| "invalid browser URL".to_string())?;
    let allowed = matches!(url.scheme(), "http" | "https" | "file")
        || (url.scheme() == "about" && url.as_str() == "about:blank");
    if !allowed {
        return Err("unsupported browser URL scheme".to_string());
    }
    Ok(url)
}

fn validate_bounds(input: &BrowserChildWebviewCreateInput) -> Result<(), String> {
    if !input.x.is_finite()
        || !input.y.is_finite()
        || !input.width.is_finite()
        || !input.height.is_finite()
        || input.width < 1.0
        || input.height < 1.0
    {
        return Err("invalid browser webview bounds".to_string());
    }
    Ok(())
}

fn validate_profile_key(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let key = value.trim();
    if key.is_empty() || key.len() > MAX_PROFILE_KEY_LENGTH {
        return Err("invalid browser profile key".to_string());
    }
    if !key
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("invalid browser profile key".to_string());
    }
    Ok(Some(key.to_string()))
}

fn validate_permission_profile_id(value: Option<&str>) -> Result<String, String> {
    let value = value.unwrap_or_default().trim();
    if value.len() > MAX_PROFILE_KEY_LENGTH || value.chars().any(char::is_control) {
        return Err("invalid browser permission profile id".to_string());
    }
    Ok(value.to_string())
}

fn validate_browser_user_agent(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_BROWSER_USER_AGENT_LENGTH
        || trimmed.chars().any(char::is_control)
    {
        return Err("browser user agent is invalid".to_string());
    }
    Ok(Some(trimmed.to_string()))
}

fn validate_browser_tab_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err("invalid browser tab id".to_string());
    }
    Ok(value.to_string())
}

fn browser_profile_data_directory(app: &AppHandle, profile_key: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| browser_profile_data_directory_from_root(&directory, profile_key))
        .map_err(|error| error.to_string())
}

fn browser_profile_data_directory_from_root(root: &Path, profile_key: &str) -> PathBuf {
    root.join("browser-profiles").join(profile_key)
}

fn delete_browser_profile_storage(root: &Path, profile_key: &str) -> Result<bool, String> {
    let profile_key = validate_profile_key(Some(profile_key))?
        .ok_or_else(|| "invalid browser profile key".to_string())?;
    // Why: deletion is capability-scoped to Pebble's profile root. The caller
    // never supplies a filesystem path that a child WebView could escape.
    let directory = browser_profile_data_directory_from_root(root, &profile_key);
    let metadata = match std::fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        std::fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
    } else {
        std::fs::remove_file(directory).map_err(|error| error.to_string())?;
    }
    Ok(true)
}

fn stable_profile_identifier(value: &str) -> [u8; 16] {
    let mut first = 0xcbf29ce484222325_u64;
    let mut second = 0x84222325cbf29ce4_u64;
    for byte in value.bytes() {
        first ^= u64::from(byte);
        first = first.wrapping_mul(0x100000001b3);
        second ^= u64::from(byte).wrapping_add(0x9d);
        second = second.wrapping_mul(0x100000001b3);
    }
    let mut identifier = [0_u8; 16];
    identifier[..8].copy_from_slice(&first.to_be_bytes());
    identifier[8..].copy_from_slice(&second.to_be_bytes());
    identifier
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_supported_browser_urls_only() {
        assert!(validate_browser_url("https://pebble.nebutra.com").is_ok());
        assert!(validate_browser_url("about:blank").is_ok());
        assert!(validate_browser_url("javascript:alert(1)").is_err());
        assert!(validate_browser_url("data:text/html,unsafe").is_err());
    }

    #[test]
    fn validates_profile_keys_for_native_storage_paths() {
        assert_eq!(
            validate_profile_key(Some("pebble-browser-session-123"))
                .expect("valid profile key")
                .as_deref(),
            Some("pebble-browser-session-123")
        );
        assert!(validate_profile_key(Some("../outside")).is_err());
    }

    #[test]
    fn validates_default_and_isolated_permission_profile_ids() {
        assert_eq!(
            validate_permission_profile_id(None).expect("default profile id"),
            ""
        );
        assert_eq!(
            validate_permission_profile_id(Some("bprof_123")).expect("isolated profile id"),
            "bprof_123"
        );
        assert!(validate_permission_profile_id(Some("bad\nprofile")).is_err());
    }

    #[test]
    fn profile_identifiers_are_stable_and_distinct() {
        assert_eq!(
            stable_profile_identifier("profile-a"),
            stable_profile_identifier("profile-a")
        );
        assert_ne!(
            stable_profile_identifier("profile-a"),
            stable_profile_identifier("profile-b")
        );
    }

    #[test]
    fn deletes_only_validated_browser_profile_storage() {
        let root = std::env::temp_dir().join(format!(
            "pebble-browser-profile-delete-{}",
            uuid::Uuid::new_v4()
        ));
        let profile =
            browser_profile_data_directory_from_root(&root, "pebble-browser-session-profile-1");
        std::fs::create_dir_all(&profile).expect("create profile directory");
        std::fs::write(profile.join("Cookies"), b"stored-cookie").expect("write profile data");

        assert!(
            delete_browser_profile_storage(&root, "pebble-browser-session-profile-1")
                .expect("delete profile storage")
        );
        assert!(!profile.exists());
        assert!(delete_browser_profile_storage(&root, "../outside").is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn validates_optional_screenshot_crop_geometry() {
        assert!(validate_screenshot_crop(None).is_ok());
        assert!(validate_screenshot_crop(Some(BrowserScreenshotCrop {
            x: 10.0,
            y: 20.0,
            width: 300.0,
            height: 200.0,
        }))
        .is_ok());
        assert!(validate_screenshot_crop(Some(BrowserScreenshotCrop {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 20.0,
        }))
        .is_err());
        assert!(validate_screenshot_crop(Some(BrowserScreenshotCrop {
            x: -1.0,
            y: 0.0,
            width: 20.0,
            height: 20.0,
        }))
        .is_err());
        assert_eq!(validate_device_scale_factor(Some(2.0)), Ok(2.0));
        assert!(validate_device_scale_factor(Some(0.0)).is_err());
        assert!(validate_device_scale_factor(Some(9.0)).is_err());
    }

    #[test]
    fn reserves_collision_safe_browser_download_paths() {
        let directory = Path::new("/tmp/downloads");
        let mut state = NativeDownloadState::default();
        state.reserved_paths.insert(directory.join("archive.zip"));
        assert_eq!(
            reserve_browser_download_path(directory, "archive.zip", &state),
            directory.join("archive (1).zip")
        );
        assert_eq!(
            browser_download_filename(Path::new(""), "https://example.com/report.pdf?token=x"),
            "report.pdf"
        );
        assert_eq!(
            browser_download_filename(Path::new(""), "https://example.com/.."),
            "download"
        );
        assert_eq!(
            sanitize_browser_download_filename(Some("a/b:c.txt")),
            "a_b_c.txt"
        );
    }

    #[test]
    fn validates_explicit_download_targets_without_overwrite() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("report.pdf");
        assert_eq!(
            validate_requested_download_path(target.to_str().unwrap()).unwrap(),
            target
        );
        std::fs::write(&target, b"existing").unwrap();
        assert!(validate_requested_download_path(target.to_str().unwrap()).is_err());
        assert!(validate_requested_download_path("relative/report.pdf").is_err());
    }

    #[test]
    fn validates_native_pdf_signature_and_size() {
        assert!(validate_pdf_bytes(b"%PDF-1.7\n").is_ok());
        assert!(validate_pdf_bytes(b"not-pdf").is_err());
    }

    #[test]
    fn file_progress_tracking_stops_after_download_is_removed() {
        let pending = PendingNativeDownload {
            id: "native-download-1".to_string(),
            browser_tab_id: "tab-1".to_string(),
            url: "https://example.com/archive.zip".to_string(),
            filename: "archive.zip".to_string(),
            path: PathBuf::from("/tmp/archive.zip"),
            request_id: None,
        };
        let state = Arc::new(Mutex::new(NativeDownloadState::default()));
        state
            .lock()
            .expect("download state")
            .by_url
            .entry(pending.url.clone())
            .or_default()
            .push_back(pending.clone());
        assert!(browser_download_file_progress::is_download_active(
            &state,
            &pending.id
        ));
        state.lock().expect("download state").by_url.clear();
        assert!(!browser_download_file_progress::is_download_active(
            &state,
            &pending.id
        ));
    }

    #[test]
    fn same_url_downloads_finish_by_native_destination_not_fifo_order() {
        let url = "https://example.com/archive.zip";
        let mut state = NativeDownloadState::default();
        for (id, path) in [
            ("first", "/tmp/archive.zip"),
            ("second", "/tmp/archive (1).zip"),
        ] {
            state
                .by_url
                .entry(url.to_string())
                .or_default()
                .push_back(PendingNativeDownload {
                    id: id.to_string(),
                    browser_tab_id: "tab-1".to_string(),
                    url: url.to_string(),
                    filename: "archive.zip".to_string(),
                    path: PathBuf::from(path),
                    request_id: None,
                });
        }
        let completed =
            take_finished_download(&mut state, url, Some(Path::new("/tmp/archive (1).zip")))
                .unwrap();
        assert_eq!(completed.id, "second");
        assert_eq!(state.by_url[url].front().unwrap().id, "first");
    }

    #[test]
    fn same_url_native_handles_claim_distinct_pending_downloads_in_order() {
        let url = "https://example.com/archive.zip";
        let mut state = NativeDownloadState::default();
        for id in ["first", "second"] {
            state
                .by_url
                .entry(url.to_string())
                .or_default()
                .push_back(PendingNativeDownload {
                    id: id.to_string(),
                    browser_tab_id: "tab-1".to_string(),
                    url: url.to_string(),
                    filename: "archive.zip".to_string(),
                    path: PathBuf::from(format!("/tmp/{id}.zip")),
                    request_id: None,
                });
        }

        assert_eq!(
            claim_pending_download_for_url(&mut state, url)
                .expect("first native handle")
                .id,
            "first"
        );
        assert_eq!(
            claim_pending_download_for_url(&mut state, url)
                .expect("second native handle")
                .id,
            "second"
        );
        assert!(claim_pending_download_for_url(&mut state, url).is_none());

        let finished = take_finished_download(&mut state, url, Some(Path::new("/tmp/first.zip")))
            .expect("first completion");
        assert_eq!(finished.id, "first");
        assert!(!state.claimed_native_ids.contains("first"));
        assert!(state.claimed_native_ids.contains("second"));
    }

    #[test]
    fn parses_bounded_context_menu_navigation_without_allowing_page_navigation() {
        let url = Url::parse(
            "pebble-context://event?kind=requested&screenX=120&screenY=240&pageUrl=https%3A%2F%2Fexample.com&linkUrl=https%3A%2F%2Fexample.com%2Fdocs&selectionText=hello",
        )
        .unwrap();
        let event = parse_context_menu_navigation(&url, "tab-1").unwrap();
        match event {
            NativeBrowserContextMenuEvent::Requested {
                browser_tab_id,
                screen_x,
                link_url,
                selection_text,
                ..
            } => {
                assert_eq!(browser_tab_id, "tab-1");
                assert_eq!(screen_x, 120.0);
                assert_eq!(link_url, "https://example.com/docs");
                assert_eq!(selection_text, "hello");
            }
            NativeBrowserContextMenuEvent::Dismissed { .. }
            | NativeBrowserContextMenuEvent::PermissionDenied { .. }
            | NativeBrowserContextMenuEvent::GrabModeToggle { .. }
            | NativeBrowserContextMenuEvent::GrabActionShortcut { .. } => {
                panic!("unexpected event")
            }
        }
    }

    #[test]
    fn browser_context_script_suppresses_the_native_menu_and_emits_dismissal() {
        let script = browser_context_menu_script(&["Mod+G".to_string()]).unwrap();
        assert!(script.contains("event.preventDefault()"));
        assert!(script.contains("signal('requested'"));
        assert!(script.contains("signal('dismissed')"));
        assert!(script.contains("reportDenied('media')"));
        assert!(script.contains("reportDenied('notifications')"));
        assert!(script.contains("signal('grabModeToggle')"));
        assert!(script.contains("signal('grabActionShortcut', { key })"));
        assert!(script.contains("[\"Mod+G\"]"));
    }

    #[test]
    fn parses_only_supported_grab_shortcut_signals() {
        let toggle = Url::parse("pebble-context://event?kind=grabModeToggle").unwrap();
        assert!(matches!(
            parse_context_menu_navigation(&toggle, "tab-1"),
            Some(NativeBrowserContextMenuEvent::GrabModeToggle { browser_tab_id })
                if browser_tab_id == "tab-1"
        ));
        let action = Url::parse("pebble-context://event?kind=grabActionShortcut&key=s").unwrap();
        assert!(matches!(
            parse_context_menu_navigation(&action, "tab-1"),
            Some(NativeBrowserContextMenuEvent::GrabActionShortcut { key, .. }) if key == "s"
        ));
        let invalid = Url::parse("pebble-context://event?kind=grabActionShortcut&key=x").unwrap();
        assert!(parse_context_menu_navigation(&invalid, "tab-1").is_none());
    }

    #[test]
    fn browser_capture_script_installs_bounded_console_and_network_hooks() {
        let script = browser_automation_capture_script();
        assert!(script.contains("const MAX = 1000"));
        assert!(script.contains("__pebbleAutomationCapture"));
        assert!(script.contains("globalThis.fetch = async"));
        assert!(script.contains("XMLHttpRequest.prototype.send"));
        assert!(script.contains("if (!state.active) return"));
        assert!(script.contains("pushBounded(state.intercepted"));
        assert!(script.contains("interceptPatterns"));
        assert!(script.contains("interceptRoutes"));
        assert!(script.contains("pattern[index + 1] === '*'"));
        assert!(script.contains("escaped += '[^/]*'"));
        assert!(!script.contains("replace(/\\*\\*/g, '.*').replace(/\\*/g"));
        assert!(script.contains("new Response(route.body"));
        assert!(script.contains("route?.action === 'fulfill'"));
        assert!(script.contains("if (route.action !== 'pause')"));
        assert!(script.contains("const continueRequest = () =>"));
        assert!(script.contains(
            "new URL(String(request instanceof Request ? request.url : request), location.href)"
        ));
        assert!(script.contains("response.clone().text()"));
        assert!(script.contains("responseBody: route.body.slice(0, 65536)"));
        assert!(script.contains("harStartedAt: null"));
        assert!(script.contains("extraHeaders: {}"));
        assert!(script.contains("headers.set(name, value)"));
        assert!(script.contains("this.setRequestHeader(name, value)"));
        assert!(script.contains("offline: false"));
        assert!(script.contains("if (state.offline) throw new TypeError('Failed to fetch')"));
        assert!(script.contains("this.dispatchEvent(new ProgressEvent('error'))"));
        assert!(script.contains("authorization: null"));
        assert!(script.contains("!headers.has('authorization')"));
        assert!(script.contains("name.toLowerCase() === 'authorization'"));
        assert!(script.contains("throw new TypeError('Failed to fetch')"));
        assert!(script.contains("this.abort()"));
    }

    #[test]
    fn validates_bounded_request_user_agents() {
        assert_eq!(
            validate_browser_user_agent(Some(" Pebble Mobile/1.0 ")).unwrap(),
            Some("Pebble Mobile/1.0".to_string())
        );
        assert!(validate_browser_user_agent(Some("bad\nagent")).is_err());
        assert!(
            validate_browser_user_agent(Some(&"x".repeat(MAX_BROWSER_USER_AGENT_LENGTH + 1)))
                .is_err()
        );
    }

    #[test]
    fn validates_bounded_document_start_scripts() {
        let scripts = vec!["globalThis.pebbleReady = true".to_string()];
        assert_eq!(
            validate_browser_init_scripts(&scripts).unwrap(),
            vec![scripts[0].as_str()]
        );
        assert!(validate_browser_init_scripts(&vec![String::new()]).is_err());
        assert!(
            validate_browser_init_scripts(&vec!["x".to_string(); MAX_INIT_SCRIPT_COUNT + 1])
                .is_err()
        );
        assert!(
            validate_browser_init_scripts(&vec!["x".repeat(MAX_INIT_SCRIPT_BYTES); 3]).is_err()
        );
    }
}
