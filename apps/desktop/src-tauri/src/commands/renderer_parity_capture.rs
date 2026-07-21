#![cfg(debug_assertions)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{LogicalSize, Manager, Runtime, Webview};

#[cfg(not(target_os = "macos"))]
use super::browser_child_webview::browser_webview_screenshot::capture_platform_webview;
#[cfg(not(target_os = "macos"))]
use super::browser_child_webview::BrowserScreenshotFormat;

const CAPTURE_PATH_ENV: &str = "PEBBLE_PARITY_CAPTURE_PATH";
const CAPTURE_SURFACE_ENV: &str = "PEBBLE_PARITY_CAPTURE_SURFACE";
const CAPTURE_WIDTH_ENV: &str = "PEBBLE_PARITY_CAPTURE_WIDTH";
const CAPTURE_HEIGHT_ENV: &str = "PEBBLE_PARITY_CAPTURE_HEIGHT";
const PERFORMANCE_PATH_ENV: &str = "PEBBLE_SETTINGS_PERFORMANCE_PATH";
const PERFORMANCE_FRAGMENT_PREFIX: &str = "pebble-settings-performance:";
const UPDATE_READY_FRAGMENT: &str = "pebble-update-ready";
const CRASH_READY_FRAGMENT: &str = "pebble-crash-ready";
static CAPTURE_SCHEDULED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CaptureSurface {
    Crash,
    Landing,
    Settings,
    Update,
}

pub fn schedule_from_environment<R: Runtime>(webview: &Webview<R>) {
    let Ok(path) = std::env::var(CAPTURE_PATH_ENV) else {
        return;
    };
    let Ok(path) = validate_capture_path(&path) else {
        eprintln!("[renderer-parity-capture] ignored invalid output path");
        return;
    };
    let Ok(surface) = capture_surface_from_environment() else {
        eprintln!("[renderer-parity-capture] ignored invalid capture surface");
        return;
    };
    let app = webview.app_handle();
    let Some(primary) = crate::primary_window::webview_window(app) else {
        return;
    };
    if primary.label() != webview.label() || CAPTURE_SCHEDULED.swap(true, Ordering::AcqRel) {
        return;
    }

    let app = app.clone();
    let label = webview.label().to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = prepare_surface(&app, &label, surface).await {
            eprintln!("[renderer-parity-capture] {error}");
            return;
        }
        match capture_main_webview(&app, &label).await {
            Ok(bytes) => match write_capture_atomically(&path, &bytes) {
                Ok(()) => eprintln!("[renderer-parity-capture] wrote {}", path.display()),
                Err(error) => eprintln!("[renderer-parity-capture] {error}"),
            },
            Err(error) => eprintln!("[renderer-parity-capture] {error}"),
        }
        // Why: parity capture is a single-purpose native shell; self-exit prevents
        // cargo/npm teardown from orphaning an unusable Pebble process.
        app.exit(0);
    });
}

pub(crate) fn schedule_functional_renderer_capture(
    app: tauri::AppHandle,
    renderer_label: &str,
    output_path: &str,
) -> Result<(), String> {
    let path = validate_capture_path(output_path)?;
    let ready = PathBuf::from(format!("{}.ready", path.display()));
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(&ready);
    // Why: the invoking renderer is authoritative even while a native browser
    // child WebView is being attached or detached from the window hierarchy.
    let label = renderer_label.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        match capture_main_webview(&app, &label).await {
            Ok(bytes) => {
                if let Err(error) = write_capture_atomically(&path, &bytes)
                    .and_then(|_| std::fs::write(&ready, []).map_err(|error| error.to_string()))
                {
                    eprintln!("[renderer-parity-capture] {error}");
                }
            }
            Err(error) => eprintln!("[renderer-parity-capture] {error}"),
        }
    });
    Ok(())
}

fn capture_surface_from_environment() -> Result<CaptureSurface, String> {
    match std::env::var(CAPTURE_SURFACE_ENV)
        .unwrap_or_else(|_| "landing".to_string())
        .trim()
    {
        "landing" => Ok(CaptureSurface::Landing),
        "crash" => Ok(CaptureSurface::Crash),
        "settings" => Ok(CaptureSurface::Settings),
        "update" => Ok(CaptureSurface::Update),
        _ => Err(
            "renderer parity capture surface must be crash, landing, settings, or update"
                .to_string(),
        ),
    }
}

async fn prepare_surface<R: Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    surface: CaptureSurface,
) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| "primary renderer window is unavailable".to_string())?;
    if let Some(size) = capture_viewport_from_environment()? {
        // Why: Electron hiddenInset and Tauri Overlay reserve different native
        // frame extents. Pixel evidence compares equal renderer content areas.
        window.set_size(size).map_err(|error| error.to_string())?;
    }
    if matches!(
        surface,
        CaptureSurface::Crash | CaptureSurface::Settings | CaptureSurface::Update
    ) {
        // Why: macOS suspends timers in a hidden WKWebView. Settings measures
        // interaction timing, and Update needs timers to mount its lazy card.
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }
    let webview = app
        .get_webview(label)
        .ok_or_else(|| "primary renderer WebView is unavailable".to_string())?;
    // Why: page-load fires before React hydration. Settings additionally uses
    // the real sidebar button so this evidence covers the production route.
    tokio::time::sleep(Duration::from_secs(1)).await;
    webview
        .eval(match surface {
            CaptureSurface::Crash => crash_preparation_script(),
            CaptureSurface::Landing => landing_preparation_script(),
            CaptureSurface::Settings => settings_measurement_script(),
            CaptureSurface::Update => update_preparation_script(),
        })
        .map_err(|error| error.to_string())?;
    match surface {
        CaptureSurface::Crash => wait_for_crash_surface(&webview).await?,
        CaptureSurface::Update => wait_for_update_surface(&webview).await?,
        _ => tokio::time::sleep(Duration::from_secs(2)).await,
    }
    if surface == CaptureSurface::Settings {
        record_settings_performance_from_url(&webview)?;
    }
    Ok(())
}

fn crash_preparation_script() -> &'static str {
    r#"(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
      window.dispatchEvent(new CustomEvent('pebble:open-crash-report-dialog', { detail: { loadLatest: false } }));
      if (!document.querySelector('[data-parity-surface="crash"]')) return;
      history.replaceState(null, '', `${location.pathname}${location.search}#pebble-crash-ready`);
      if (!document.querySelector('style[data-parity-normalization]')) {
        const parityStyle = document.createElement('style');
        parityStyle.dataset.parityNormalization = 'true';
        parityStyle.textContent = '[data-parity-volatile]{display:none!important}*,*::before,*::after{animation:none!important;transition:none!important}';
        document.head.append(parityStyle);
      }
      document.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((node) => node.remove());
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    })()"#
}

async fn wait_for_crash_surface<R: Runtime>(webview: &tauri::Webview<R>) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        webview
            .eval(crash_preparation_script())
            .map_err(|error| error.to_string())?;
        if webview.url().map_err(|error| error.to_string())?.fragment()
            == Some(CRASH_READY_FRAGMENT)
        {
            // Why: the dialog lives in a React portal; wait for WebKit to
            // composite the now animation-free overlay before capture.
            tokio::time::sleep(Duration::from_millis(500)).await;
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err("crash parity surface did not become ready".to_string())
}

fn update_preparation_script() -> &'static str {
    r#"(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
      const store = window.__store;
      if (!store?.getState || !store?.setState) {
        history.replaceState(null, '', `${location.pathname}${location.search}#pebble-update-injected:no-store`);
        return;
      }
      const state = {
          activeModal: 'none',
          activeView: 'terminal',
          activeWorktreeId: null,
          dismissedUpdateVersion: null,
          folderWorkspaces: [],
          projects: [],
          projectGroups: [],
          repos: [],
          rightSidebarOpen: false,
          settingsPageOpen: false,
          updateCardCollapsed: false,
          updateChangelog: null,
          updateReassuranceSeen: true,
          worktreesByRepo: {},
          updateStatus: {
            state: 'available',
            version: '1.4.128',
            releaseUrl: 'https://github.com/nebutra/pebble/releases/tag/v1.4.128',
            changelog: null
          }
      };
      store.setState(state);
      store.getState().setUpdateStatus?.(state.updateStatus);
      if (!document.querySelector('[data-parity-surface="update"]')) {
        history.replaceState(null, '', `${location.pathname}${location.search}#pebble-update-injected:${store.getState().updateStatus?.state || 'unknown'}`);
        return;
      }
      // Why: updater/bootstrap hydration can race the lazy card mount. The
      // final write makes the visible card and its Landing background atomic.
      store.setState(state);
      history.replaceState(null, '', `${location.pathname}${location.search}#pebble-update-ready`);
      if (!document.querySelector('style[data-parity-normalization]')) {
        const parityStyle = document.createElement('style');
        parityStyle.dataset.parityNormalization = 'true';
        parityStyle.textContent = '[data-parity-volatile]{display:none!important}';
        document.head.append(parityStyle);
      }
      document.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((node) => node.remove());
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    })()"#
}

fn landing_preparation_script() -> &'static str {
    r#"(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
      const deadline = performance.now() + 10000;
      const prepare = () => {
        const store = window.__store;
        if (!store?.getState || !store?.setState) {
          if (performance.now() < deadline) setTimeout(prepare, 25);
          return;
        }
        store.setState({
          activeModal: 'none',
          activeView: 'terminal',
          activeWorktreeId: null,
          folderWorkspaces: [],
          projects: [],
          projectGroups: [],
          repos: [],
          rightSidebarOpen: false,
          settingsPageOpen: false,
          worktreesByRepo: {}
        });
        const parityStyle = document.createElement('style');
        parityStyle.textContent = '[data-parity-volatile]{display:none!important}';
        document.head.append(parityStyle);
        document.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((node) => node.remove());
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      };
      setTimeout(prepare, 0);
    })()"#
}

async fn wait_for_update_surface<R: Runtime>(webview: &tauri::Webview<R>) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        // Why: hidden/background WKWebViews may throttle JavaScript timers;
        // native polling keeps parity preparation deterministic.
        webview
            .eval(update_preparation_script())
            .map_err(|error| error.to_string())?;
        let url = webview.url().map_err(|error| error.to_string())?;
        let fragment = url.fragment().unwrap_or_default();
        if fragment == UPDATE_READY_FRAGMENT {
            // Why: the URL signal is emitted from the mounted card. One frame
            // lets its lazy boundary and font metrics settle before capture.
            tokio::time::sleep(Duration::from_millis(50)).await;
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let fragment = webview
        .url()
        .map_err(|error| error.to_string())?
        .fragment()
        .unwrap_or_default()
        .to_string();
    Err(format!(
        "update parity surface did not become ready (renderer={fragment})"
    ))
}

fn record_settings_performance_from_url<R: Runtime>(
    webview: &tauri::Webview<R>,
) -> Result<(), String> {
    let url = webview.url().map_err(|error| error.to_string())?;
    let encoded = url
        .fragment()
        .and_then(|fragment| fragment.strip_prefix(PERFORMANCE_FRAGMENT_PREFIX))
        .ok_or_else(|| "settings performance URL payload is unavailable".to_string())?;
    let decoded = urlencoding::decode(encoded).map_err(|error| error.to_string())?;
    let sample = serde_json::from_str(decoded.as_ref()).map_err(|error| error.to_string())?;
    renderer_parity_record_settings_performance(sample)
}

fn capture_viewport_from_environment() -> Result<Option<LogicalSize<f64>>, String> {
    let width = std::env::var(CAPTURE_WIDTH_ENV).ok();
    let height = std::env::var(CAPTURE_HEIGHT_ENV).ok();
    match (width, height) {
        (None, None) => Ok(None),
        (Some(width), Some(height)) => {
            let width = width
                .parse::<f64>()
                .map_err(|_| "renderer parity capture width must be numeric".to_string())?;
            let height = height
                .parse::<f64>()
                .map_err(|_| "renderer parity capture height must be numeric".to_string())?;
            if !width.is_finite() || !height.is_finite() || width < 600.0 || height < 400.0 {
                return Err("renderer parity capture viewport is invalid".to_string());
            }
            Ok(Some(LogicalSize::new(width, height)))
        }
        _ => Err("renderer parity capture viewport requires width and height".to_string()),
    }
}

fn settings_measurement_script() -> &'static str {
    r#"(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
      const preparationDeadline = performance.now() + 10000;
      const waitForPreparedRoute = () => {
        const store = window.__store;
        if (!store?.getState) {
          if (performance.now() < preparationDeadline) setTimeout(waitForPreparedRoute, 25);
          return;
        }
        const startedAt = performance.now();
        const longTasks = [];
        let previousFrameAt = startedAt;
        let measuring = true;
        const measureFrameStalls = () => {
          const frameAt = performance.now();
          const frameGap = frameAt - previousFrameAt;
          if (frameGap > 50) longTasks.push(frameGap);
          previousFrameAt = frameAt;
          if (measuring) setTimeout(measureFrameStalls, 16);
        };
        setTimeout(measureFrameStalls, 16);
        store.getState().openSettingsPage();
        const switchDeadline = startedAt + 10000;
        const poll = () => {
          const overlay = document.querySelector('[data-settings-overlay][aria-hidden="false"]');
          const loading = document.querySelector('[data-settings-loading]');
          if (overlay && !loading) {
            measuring = false;
            // Why: parity compares renderer output, not machine-specific
            // persistence from each isolated capture profile.
            const parityStyle = document.createElement('style');
            parityStyle.textContent = '[data-parity-volatile]{display:none!important}';
            document.head.append(parityStyle);
            document.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((node) => node.remove());
            for (const input of document.querySelectorAll('input')) {
              if (input.value.includes('/pebble/workspaces')) {
                // Why: parity must compare product UI, not the local account path.
                input.value = '~/pebble/workspaces';
              }
            }
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
            const sample = {
              switchDurationMs: performance.now() - startedAt,
              longTaskCount: longTasks.length,
              maxLongTaskMs: longTasks.length ? Math.max(...longTasks) : 0,
              totalLongTaskMs: longTasks.reduce((sum, value) => sum + value, 0)
            };
            location.hash = 'pebble-settings-performance:' + encodeURIComponent(JSON.stringify(sample));
          } else if (performance.now() < switchDeadline) {
            setTimeout(poll, 16);
          }
        };
        setTimeout(poll, 0);
      };
      setTimeout(waitForPreparedRoute, 0);
    })()"#
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPerformanceSample {
    switch_duration_ms: f64,
    long_task_count: u32,
    max_long_task_ms: f64,
    total_long_task_ms: f64,
}

#[tauri::command]
pub fn renderer_parity_record_settings_performance(
    sample: SettingsPerformanceSample,
) -> Result<(), String> {
    let path = std::env::var(PERFORMANCE_PATH_ENV)
        .map_err(|_| "settings performance output path is not configured".to_string())?;
    let path = validate_json_path(&path)?;
    if !sample.switch_duration_ms.is_finite()
        || !sample.max_long_task_ms.is_finite()
        || !sample.total_long_task_ms.is_finite()
        || sample.switch_duration_ms < 0.0
        || sample.max_long_task_ms < 0.0
        || sample.total_long_task_ms < 0.0
    {
        return Err("settings performance sample contains invalid durations".to_string());
    }
    let bytes = serde_json::to_vec_pretty(&sample).map_err(|error| error.to_string())?;
    write_bytes_atomically(&path, &bytes)
}

fn validate_json_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute() || path.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err("settings performance path must be an absolute .json path".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "settings performance path has no parent".to_string())?;
    if !parent.is_dir() {
        return Err("settings performance parent directory does not exist".to_string());
    }
    Ok(path)
}

#[cfg(target_os = "macos")]
async fn capture_main_webview<R: Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
) -> Result<Vec<u8>, String> {
    let webview = app
        .get_webview(label)
        .ok_or_else(|| "primary renderer WebView is unavailable".to_string())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| capture_macos_webview(platform_webview, sender))
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "renderer snapshot callback was dropped".to_string())?
}

#[cfg(target_os = "macos")]
fn capture_macos_webview(
    platform_webview: tauri::webview::PlatformWebview,
    sender: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
) {
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex};

    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
    };
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    let pointer = platform_webview.inner();
    if pointer.is_null() {
        let _ = sender.send(Err("renderer WKWebView pointer is null".to_string()));
        return;
    }
    let sender = Arc::new(Mutex::new(Some(sender)));
    let completion_sender = sender.clone();
    let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let result = (|| {
            if !error.is_null() {
                return Err("WKWebView renderer snapshot failed".to_string());
            }
            let image = unsafe { image.as_ref() }
                .ok_or_else(|| "WKWebView returned no renderer snapshot".to_string())?;
            let tiff = image
                .TIFFRepresentation()
                .ok_or_else(|| "renderer snapshot has no TIFF representation".to_string())?;
            let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)
                .ok_or_else(|| "renderer snapshot bitmap decode failed".to_string())?;
            let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
            let data = unsafe {
                bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
            }
            .ok_or_else(|| "renderer snapshot PNG encoding failed".to_string())?;
            let length = data.length();
            let mut bytes = vec![0_u8; length];
            if length > 0 {
                let destination = NonNull::new(bytes.as_mut_ptr().cast::<c_void>())
                    .ok_or_else(|| "renderer snapshot allocation failed".to_string())?;
                unsafe { data.getBytes_length(destination, length) };
            }
            Ok(bytes)
        })();
        if let Some(sender) = completion_sender
            .lock()
            .ok()
            .and_then(|mut value| value.take())
        {
            let _ = sender.send(result);
        }
    });
    let webview = unsafe { &*(pointer as *const WKWebView) };
    unsafe { webview.takeSnapshotWithConfiguration_completionHandler(None, &completion) };
}

#[cfg(not(target_os = "macos"))]
async fn capture_main_webview<R: Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
) -> Result<Vec<u8>, String> {
    let webview = app
        .get_webview(label)
        .ok_or_else(|| "primary renderer WebView is unavailable".to_string())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let _ = sender.send(capture_platform_webview(
                platform_webview,
                BrowserScreenshotFormat::Png,
                None,
                1.0,
            ));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "renderer parity capture callback was dropped".to_string())?
}

fn validate_capture_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute() || path.extension().and_then(|value| value.to_str()) != Some("png") {
        return Err("renderer parity capture path must be an absolute .png path".to_string());
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "renderer parity capture path has no parent".to_string())?;
    if !parent.is_dir() {
        return Err("renderer parity capture parent directory does not exist".to_string());
    }
    Ok(path)
}

fn write_capture_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("renderer parity capture did not return PNG bytes".to_string());
    }
    write_bytes_atomically(path, bytes)
}

fn write_bytes_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        error.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_absolute_png_paths_with_existing_parents() {
        let root = tempfile::tempdir().unwrap();
        assert!(validate_capture_path(root.path().join("tauri.png").to_str().unwrap()).is_ok());
        assert!(validate_capture_path("relative.png").is_err());
        assert!(validate_capture_path(root.path().join("tauri.jpg").to_str().unwrap()).is_err());
        assert!(
            validate_capture_path(root.path().join("missing/out.png").to_str().unwrap()).is_err()
        );
    }

    #[test]
    fn atomically_writes_only_png_payloads() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("capture.png");
        assert!(write_capture_atomically(&path, b"not png").is_err());
        let png = b"\x89PNG\r\n\x1a\ncontent";
        write_capture_atomically(&path, png).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), png);
    }

    #[test]
    fn capture_surface_defaults_to_landing_and_rejects_unknown_values() {
        std::env::remove_var(CAPTURE_SURFACE_ENV);
        assert_eq!(
            capture_surface_from_environment().unwrap(),
            CaptureSurface::Landing
        );
        std::env::set_var(CAPTURE_SURFACE_ENV, "settings");
        assert_eq!(
            capture_surface_from_environment().unwrap(),
            CaptureSurface::Settings
        );
        std::env::set_var(CAPTURE_SURFACE_ENV, "update");
        assert_eq!(
            capture_surface_from_environment().unwrap(),
            CaptureSurface::Update
        );
        std::env::set_var(CAPTURE_SURFACE_ENV, "crash");
        assert_eq!(
            capture_surface_from_environment().unwrap(),
            CaptureSurface::Crash
        );
        std::env::set_var(CAPTURE_SURFACE_ENV, "mock-ui");
        assert!(capture_surface_from_environment().is_err());
        std::env::remove_var(CAPTURE_SURFACE_ENV);
    }

    #[test]
    fn settings_measurement_uses_the_real_control_and_long_task_observer() {
        let script = settings_measurement_script();
        assert!(script.contains("store.getState().openSettingsPage()"));
        assert!(script.contains("frameGap > 50"));
        assert!(script.contains("[data-parity-volatile]{display:none!important}"));
        assert!(script.contains("location.hash = 'pebble-settings-performance:'"));
    }

    #[test]
    fn landing_capture_uses_the_real_empty_project_surface() {
        let script = landing_preparation_script();
        assert!(script.contains("store.setState"));
        assert!(script.contains("activeWorktreeId: null"));
        assert!(script.contains("projects: []"));
        assert!(script.contains("repos: []"));
        assert!(script.contains("[data-parity-volatile]{display:none!important}"));
    }

    #[test]
    fn update_capture_uses_the_real_available_update_surface() {
        let script = update_preparation_script();
        assert!(script.contains("state: 'available'"));
        assert!(script.contains("version: '1.4.128'"));
        assert!(script.contains("github.com/nebutra/pebble/releases/tag/v1.4.128"));
        assert!(script.contains("updateReassuranceSeen: true"));
    }

    #[test]
    fn crash_capture_opens_the_real_crash_report_dialog() {
        let script = crash_preparation_script();
        assert!(script.contains("pebble:open-crash-report-dialog"));
        assert!(script.contains("[data-parity-surface=\"crash\"]"));
        assert!(script.contains("pebble-crash-ready"));
    }
}
