use serde::Deserialize;
use tauri::{AppHandle, Manager};

const BROWSER_WEBVIEW_LABEL_PREFIX: &str = "browser-";
const MAX_MARKERS: usize = 50;
const MAX_MARKER_ID_LENGTH: usize = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAnnotationOverlayInput {
    pub label: String,
    pub enabled: bool,
    pub markers: Vec<BrowserAnnotationOverlayMarker>,
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAnnotationOverlayMarker {
    pub id: String,
    pub index: u32,
    pub rect_page: BrowserAnnotationOverlayRect,
    pub rect_viewport: BrowserAnnotationOverlayRect,
    pub is_fixed: bool,
}

#[derive(Debug, Deserialize, serde::Serialize)]
pub struct BrowserAnnotationOverlayRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[tauri::command]
pub fn browser_annotation_overlay_set(
    app: AppHandle,
    input: BrowserAnnotationOverlayInput,
) -> Result<bool, String> {
    let label = validate_browser_webview_label(&input.label)?;
    validate_markers(&input.markers)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    let script = browser_annotation_overlay_script(input.enabled, &input.markers)?;
    // Why: annotations are persisted renderer data. The host validates their
    // geometry before injecting the isolated visual overlay into remote content.
    webview.eval(script).map_err(|error| error.to_string())?;
    Ok(true)
}

fn validate_browser_webview_label(value: &str) -> Result<String, String> {
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

fn validate_markers(markers: &[BrowserAnnotationOverlayMarker]) -> Result<(), String> {
    if markers.len() > MAX_MARKERS {
        return Err("too many annotation markers".to_string());
    }
    if markers.iter().any(|marker| {
        marker.id.is_empty()
            || marker.id.len() > MAX_MARKER_ID_LENGTH
            || marker.index >= 100
            || !is_valid_rect(&marker.rect_page)
            || !is_valid_rect(&marker.rect_viewport)
    }) {
        return Err("invalid annotation marker".to_string());
    }
    Ok(())
}

fn is_valid_rect(rect: &BrowserAnnotationOverlayRect) -> bool {
    rect.x.is_finite()
        && rect.y.is_finite()
        && rect.width.is_finite()
        && rect.height.is_finite()
        && rect.width >= 0.0
        && rect.height >= 0.0
}

fn browser_annotation_overlay_script(
    enabled: bool,
    markers: &[BrowserAnnotationOverlayMarker],
) -> Result<String, String> {
    let markers = serde_json::to_string(markers).map_err(|error| error.to_string())?;
    let enabled = serde_json::to_string(&enabled).map_err(|error| error.to_string())?;
    Ok(format!(
        r#"(() => {{
          const enabled = {enabled};
          const markers = {markers};
          const key = '__pebbleTauriAnnotationOverlay';
          const existing = window[key];
          const cleanup = (state) => {{
            state?.remove?.();
            delete window[key];
          }};
          if (!enabled || markers.length === 0) {{ cleanup(existing); return true; }}
          cleanup(existing);
          const root = document.body || document.documentElement;
          if (!root) return false;
          const host = document.createElement('div');
          host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;overflow:hidden;';
          const shadow = host.attachShadow({{ mode: 'closed' }});
          const style = document.createElement('style');
          style.textContent = '.marker{{position:absolute;width:24px;height:24px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;border-radius:9999px;border:1px solid rgba(255,255,255,.95);background:#2563eb;color:#fff;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 10px 24px rgba(0,0,0,.18);}}';
          shadow.appendChild(style);
          const items = markers.map((marker) => {{
            const element = document.createElement('span');
            element.className = 'marker';
            element.textContent = String(marker.index + 1);
            shadow.appendChild(element);
            return {{ marker, element }};
          }});
          const update = () => {{
            const scrollX = Number.isFinite(window.scrollX) ? window.scrollX : 0;
            const scrollY = Number.isFinite(window.scrollY) ? window.scrollY : 0;
            for (const {{ marker, element }} of items) {{
              const rect = marker.isFixed ? marker.rectViewport : marker.rectPage;
              const x = marker.isFixed ? rect.x : rect.x - scrollX;
              const y = marker.isFixed ? rect.y : rect.y - scrollY;
              const visible = x + rect.width >= 0 && y + rect.height >= 0 && x <= window.innerWidth && y <= window.innerHeight;
              element.style.display = visible ? 'flex' : 'none';
              if (visible) element.style.transform = `translate3d(${{x + rect.width / 2 - 12}}px,${{y + rect.height - 12}}px,0)`;
            }}
          }};
          const remove = () => {{
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update, true);
            host.remove();
          }};
          window.addEventListener('scroll', update, true);
          window.addEventListener('resize', update, true);
          window[key] = {{ remove }};
          root.appendChild(host);
          update();
          return true;
        }})()"#
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker() -> BrowserAnnotationOverlayMarker {
        BrowserAnnotationOverlayMarker {
            id: "note-1".to_string(),
            index: 0,
            rect_page: BrowserAnnotationOverlayRect {
                x: 1.0,
                y: 2.0,
                width: 3.0,
                height: 4.0,
            },
            rect_viewport: BrowserAnnotationOverlayRect {
                x: 1.0,
                y: 2.0,
                width: 3.0,
                height: 4.0,
            },
            is_fixed: false,
        }
    }

    #[test]
    fn accepts_bounded_annotation_markers() {
        assert!(validate_markers(&[marker()]).is_ok());
    }

    #[test]
    fn rejects_invalid_annotation_marker_geometry() {
        let mut invalid = marker();
        invalid.rect_page.width = -1.0;
        assert!(validate_markers(&[invalid]).is_err());
    }

    #[test]
    fn overlay_script_keeps_marker_geometry_data_only() {
        let script = browser_annotation_overlay_script(true, &[marker()]).expect("script");
        assert!(script.contains("__pebbleTauriAnnotationOverlay"));
        assert!(script.contains("note-1"));
        assert!(!script.contains("eval("));
    }
}
