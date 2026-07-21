use tauri::WebviewWindow;

#[tauri::command]
pub async fn perform_native_paste(
    window: WebviewWindow,
    mode: Option<String>,
) -> Result<bool, String> {
    if !window.is_focused().map_err(|error| error.to_string())? {
        return Ok(false);
    }
    let mode = NativePasteMode::parse(mode.as_deref())?;
    #[cfg(target_os = "windows")]
    if mode == NativePasteMode::PasteAndMatchStyle {
        return perform_windows_plain_text_paste(&window);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |platform_webview| {
            let _ = sender.send(perform_platform_paste(platform_webview, mode));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "Native paste responder was dropped.".to_string())?
}

#[cfg(target_os = "windows")]
fn perform_windows_plain_text_paste(window: &WebviewWindow) -> Result<bool, String> {
    let text = arboard::Clipboard::new()
        .map_err(|error| error.to_string())?
        .get_text()
        .map_err(|error| error.to_string())?;
    if text.len() > 4 * 1024 * 1024 {
        return Err("Clipboard text exceeds the desktop safety limit.".to_string());
    }
    window
        .eval(build_plain_text_paste_script(&text)?)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg(any(target_os = "windows", test))]
fn build_plain_text_paste_script(text: &str) -> Result<String, String> {
    let encoded = serde_json::to_string(text).map_err(|error| error.to_string())?;
    Ok(format!(
        r#"(() => {{
  const text = {encoded};
  const target = document.activeElement;
  if (!document.hasFocus() || !target) return false;
  const before = new InputEvent('beforeinput', {{
    bubbles: true,
    cancelable: true,
    inputType: 'insertFromPaste',
    data: text
  }});
  if (!target.dispatchEvent(before)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {{
    if (target.disabled || target.readOnly) return false;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.setRangeText(text, start, end, 'end');
  }} else if (target.isContentEditable) {{
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }} else {{
    return false;
  }}
  target.dispatchEvent(new InputEvent('input', {{
    bubbles: true,
    inputType: 'insertFromPaste',
    data: text
  }}));
  return true;
}})();"#
    ))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativePasteMode {
    Paste,
    PasteAndMatchStyle,
}

impl NativePasteMode {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("paste") {
            "paste" => Ok(Self::Paste),
            "paste-and-match-style" => Ok(Self::PasteAndMatchStyle),
            _ => Err("Unsupported native paste mode.".to_string()),
        }
    }
}

#[cfg(target_os = "macos")]
fn perform_platform_paste(
    _platform_webview: tauri::webview::PlatformWebview,
    mode: NativePasteMode,
) -> Result<bool, String> {
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::NSApp;

    let marker = MainThreadMarker::new()
        .ok_or_else(|| "Native paste must execute on the AppKit thread.".to_string())?;
    let selector = match mode {
        NativePasteMode::Paste => sel!(paste:),
        NativePasteMode::PasteAndMatchStyle => sel!(pasteAsPlainText:),
    };
    // Why: a nil target asks AppKit to resolve the active first responder, the
    // same path used by Electron's WebContents paste and pasteAndMatchStyle.
    Ok(unsafe { NSApp(marker).sendAction_to_from(selector, None, None) })
}

#[cfg(target_os = "linux")]
fn perform_platform_paste(
    platform_webview: tauri::webview::PlatformWebview,
    mode: NativePasteMode,
) -> Result<bool, String> {
    use webkit2gtk::WebViewExt;

    let command = match mode {
        NativePasteMode::Paste => "Paste",
        NativePasteMode::PasteAndMatchStyle => "PasteAsPlainText",
    };
    platform_webview.inner().execute_editing_command(command);
    Ok(true)
}

#[cfg(target_os = "windows")]
fn perform_platform_paste(
    _platform_webview: tauri::webview::PlatformWebview,
    _mode: NativePasteMode,
) -> Result<bool, String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetFocus;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_PASTE};

    // WebView2 exposes the focused editable surface as a child HWND. WM_PASTE
    // avoids synthesizing Ctrl+V, which would re-enter Pebble's menu accelerator.
    let focused = unsafe { GetFocus() };
    if focused.is_null() {
        return Ok(false);
    }
    unsafe {
        SendMessageW(focused, WM_PASTE, 0, 0);
    }
    Ok(true)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn perform_platform_paste(
    _platform_webview: tauri::webview::PlatformWebview,
    _mode: NativePasteMode,
) -> Result<bool, String> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_native_paste_modes() {
        assert_eq!(
            NativePasteMode::parse(None).unwrap(),
            NativePasteMode::Paste
        );
        assert_eq!(
            NativePasteMode::parse(Some("paste-and-match-style")).unwrap(),
            NativePasteMode::PasteAndMatchStyle
        );
        assert!(NativePasteMode::parse(Some("execute-script")).is_err());
    }

    #[test]
    fn plain_text_paste_script_serializes_untrusted_clipboard_text() {
        let script = build_plain_text_paste_script("line\n'</script>\\tail").unwrap();
        assert!(script.contains(r#"const text = "line\n'</script>\\tail";"#));
        assert!(script.contains("target.setRangeText"));
        assert!(script.contains("target.isContentEditable"));
        assert!(script.contains("inputType: 'insertFromPaste'"));
        assert!(!script.contains("execCommand"));
    }
}
